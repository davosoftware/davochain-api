import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FeeKind, PolicyAction, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { QuidaxError } from '../quidax/quidax.errors';
import { LedgerService } from '../ledger/ledger.service';
import { AssetsService } from '../assets/assets.service';
import { SettlementService } from '../trades/settlement.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RatesService } from '../rates/rates.service';
import { FeeBandsService } from '../rates/fee-bands.service';
import { KycLimitsService } from '../kyc/kyc-limits.service';
import { LevelPolicyService } from '../levels/level-policy.service';
import { levelOf } from '../levels/levels';
import { assertCryptoDestination } from './destination-rules';
import { ZERO, dec, str, type Decimal } from '../common/money';

/** A plain positive decimal, as the app types it: "5000", "0.0125". No signs, exponents or separators. */
const PLAIN_AMOUNT = /^\d+(\.\d+)?$/;

/**
 * The amount from a quote's query string. Query strings skip the DTO pipe, so a
 * missing or malformed one reached `new Decimal()` and surfaced as a 500.
 */
export function positiveAmount(raw: unknown): Decimal {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!PLAIN_AMOUNT.test(text) || dec(text).lte(0)) throw new BadRequestException('Enter an amount greater than zero');
  return dec(text);
}

/**
 * Crypto leaves from the user's own Quidax sub-account; NGN bank payouts leave
 * the merchant's main Quidax account against the user's Davochain ledger claim.
 */
@Injectable()
export class WithdrawalsService {
  private readonly log = new Logger(WithdrawalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
    private readonly ledger: LedgerService,
    private readonly assets: AssetsService,
    private readonly settlement: SettlementService,
    private readonly rates: RatesService,
    private readonly feeBands: FeeBandsService,
    private readonly kycLimits: KycLimitsService,
    private readonly flags: SystemFlagsService,
    private readonly notifications: NotificationsService,
    private readonly policy: LevelPolicyService,
  ) {}

  /**
   * What an external withdrawal costs: our fee, plus the chain's.
   *
   * The two halves come from different places and are never blended. Ours is a
   * banded dollar amount an admin sets and can be held to; the chain's is
   * whatever Quidax quotes at that moment and is out of anyone's hands. One
   * merged number would make our fee look like it moves on its own.
   *
   * Priced in dollars because that is how the bands are defined — the same $10
   * step has to mean the same thing whether the coin is bitcoin or dogecoin —
   * then converted into the coin, which is what actually leaves the balance.
   */
  private async fees(
    code: string,
    amount: Decimal,
    networkId: string,
    cfg: { withdrawalFee: unknown },
  ): Promise<{
    platformFee: Decimal;
    platformFeeUsd: Decimal | null;
    networkFee: Decimal;
    usdValue: Decimal | null;
  }> {
    let upstream;
    try {
      upstream = await this.quidax.fetchWithdrawalFee({
        currency: code,
        amount: amount.toFixed(),
        network: networkId,
      });
    } catch {
      // Quidax charges this fee regardless. A zero fallback can under-lock the
      // user's balance and make the quote materially false.
      throw new ServiceUnavailableException(
        'Unable to retrieve the network fee. Please try again shortly.',
      );
    }
    const networkFee = dec(upstream.fee);

    // Best effort: a price lookup is a call out, and money leaving must never
    // be blocked by one. Without a price there is no dollar size to band on,
    // so the flat configured fee stands in — the behaviour before ladders.
    const price = await this.rates.price(code).catch(() => null);
    if (!price) {
      return {
        platformFee: dec(cfg.withdrawalFee as string),
        platformFeeUsd: null,
        networkFee,
        usdValue: null,
      };
    }

    const usdValue = amount.mul(price.priceUsd);
    const band = await this.feeBands.resolve(FeeKind.WITHDRAWAL, code, usdValue);

    if (!band) {
      // No ladder for this coin or globally: the flat per-coin fee still
      // applies, so an install that never configures one keeps working.
      const flat = dec(cfg.withdrawalFee as string);
      return {
        platformFee: flat,
        platformFeeUsd: flat.mul(price.priceUsd),
        networkFee,
        usdValue,
      };
    }

    return {
      platformFee: band.value.div(price.priceUsd),
      platformFeeUsd: band.value,
      networkFee,
      usdValue,
    };
  }

  /** Quote the fee before the user commits. Three lines, never one blended number. */
  async quoteFee(assetCode: string, amount: string, networkId: string) {
    if (typeof assetCode !== 'string' || !assetCode.trim()) throw new BadRequestException('Choose a coin');
    if (typeof networkId !== 'string' || !networkId.trim()) throw new BadRequestException('Choose a network');
    const total = positiveAmount(amount);
    const code = assetCode.toLowerCase();
    const [asset, cfg] = await Promise.all([
      this.assets.require(code),
      this.rates.rateConfig(code),
    ]);

    const { platformFee, platformFeeUsd, networkFee } = await this.fees(
      code,
      total,
      networkId,
      cfg,
    );

    return {
      asset: code,
      network: networkId,
      amount: str(total, asset.displayScale),
      networkFee: str(networkFee, asset.displayScale),
      platformFee: str(platformFee, asset.displayScale),
      /** Our share in dollars, which is the figure the ladder actually sets. */
      platformFeeUsd: platformFeeUsd ? platformFeeUsd.toFixed(2) : null,
      totalFee: str(networkFee.plus(platformFee), asset.displayScale),
      totalDeducted: str(total.plus(networkFee).plus(platformFee), asset.displayScale),
      youReceive: str(total, asset.displayScale),
    };
  }

  /**
   * What cashing out to a Nigerian bank costs.
   *
   * The fee is a flat naira amount, banded by how much is leaving — the same
   * ladder shape as everything else, priced in the currency the user actually
   * loses. Banded on the dollar equivalent so all four ladders break on one
   * axis and a $100 step means the same thing everywhere.
   *
   * Payouts run from the Quidax main account and are switched on and off by
   * NGN_WITHDRAWALS_ENABLED, overridable live from the dashboard (System →
   * Withdrawals). This quote works either way, so the fee and the user's limits
   * can be shown before payouts are on; `payoutAvailable` says whether they are.
   */
  async quoteNgnWithdrawalFee(userId: string, ngnAmount: string) {
    const amount = positiveAmount(ngnAmount);

    // The tier caps naira, so the quote says whether this one is allowed before
    // anybody types their bank details.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycTier: true },
    });
    const limit = await this.kycLimits.check(userId, user?.kycTier ?? 'TIER_0', 'withdraw', amount);

    /*
     * Banded on the NAIRA amount, not on its dollar equivalent.
     *
     * Nothing about this transaction is denominated in dollars. A naira balance
     * is a virtual number the platform owes; cashing out is what turns it into
     * real money. Pricing the fee off an exchange rate would mean a ₦50,000
     * cash-out costs something different tomorrow because the naira moved — a
     * change nobody made and no customer agreed to. It also needs no price
     * lookup at all, so this quote cannot fail because Quidax is slow.
     */
    const band = await this.feeBands.resolve(FeeKind.NGN_WITHDRAWAL, 'ngn', amount);

    // Naira has no RateConfig of its own — it is not a coin anyone trades
    // against, so nothing ever created one. The ladder is the source here, and
    // its absence means no fee has been set rather than an error.
    const feeNgn = band?.value ?? ZERO;

    return {
      asset: 'ngn',
      /** What the user asked for, and what reaches their bank. */
      amount: str(amount, 2),
      feeNgn: str(feeNgn, 2),
      /*
       * amount + fee.
       *
       * The fee leaves the balance alongside the payout, so the balance falls
       * by more than lands in the bank. That difference is naira the platform
       * no longer owes anybody — which is precisely why it is earnings rather
       * than a transfer.
       */
      totalDebited: str(amount.plus(feeNgn), 2),
      youReceive: str(amount, 2),
      band: band
        ? { minAmount: band.minAmount.toFixed(2), maxAmount: band.maxAmount?.toFixed(2) ?? null }
        : null,
      /** No ladder set means no fee is charged, not that pricing failed. */
      feeConfigured: band !== null,
      limit: {
        allowed: limit.allowed,
        reason: limit.reason ?? null,
        /** null = no limit. */
        singleLimit: limit.singleLimit ? str(limit.singleLimit, 2) : null,
        dailyLimit: limit.dailyLimit ? str(limit.dailyLimit, 2) : null,
        usedToday: str(limit.usedToday, 2),
        remainingToday: limit.remainingToday ? str(limit.remainingToday.lt(0) ? ZERO : limit.remainingToday, 2) : null,
        currency: limit.currency,
      },
      /** Mirrors the switch (System → Withdrawals). The app disables payout while false. */
      payoutAvailable: await this.flags.ngnWithdrawalsEnabled(),
    };
  }

  async ngnBanks() {
    await this.flags.assertNgnWithdrawalsAllowed();
    const banks = await this.quidax.fetchBanks();
    return banks
      .filter((bank) => bank.country.toLowerCase() === 'nigeria' && bank.currency.toLowerCase() === 'ngn')
      .map(({ code, name }) => ({ code, name }));
  }

  async verifyNgnBankAccount(input: { accountNumber: string; bankCode: string }) {
    await this.flags.assertNgnWithdrawalsAllowed();
    const accountName = await this.resolveNgnAccountName(input);
    return {
      accountName,
      accountNumberLast4: input.accountNumber.slice(-4),
      bankCode: input.bankCode,
    };
  }

  /**
   * The bank's name and the account holder's name, for saving a bank account
   * (Part 2). Not tied to the payout switch: people may save accounts while
   * payouts are paused.
   */
  async lookupNgnBankAccount(input: { accountNumber: string; bankCode: string }): Promise<{ bankName: string; accountName: string }> {
    const banks = await this.quidax.fetchBanks().catch(() => {
      throw new ServiceUnavailableException('The bank list is temporarily unavailable. Try again shortly.');
    });
    const bank = banks.find(
      (b) => b.code === input.bankCode && b.country.toLowerCase() === 'nigeria' && b.currency.toLowerCase() === 'ngn',
    );
    if (!bank) throw new BadRequestException('Choose a supported Nigerian bank');
    return { bankName: bank.name, accountName: await this.resolveNgnAccountName(input) };
  }

  /**
   * The account holder's name from Quidax. A refusal (4xx) is the customer's
   * details being wrong; anything else is Quidax being unavailable. Shared by
   * 8.6 and 8.7, so the submit can never surface a raw provider error as a 500.
   */
  private async resolveNgnAccountName(input: { accountNumber: string; bankCode: string }): Promise<string> {
    try {
      return (await this.quidax.verifyBankAccount(input)).account_name;
    } catch (err) {
      if (err instanceof QuidaxError && err.httpStatus >= 400 && err.httpStatus < 500) {
        throw new BadRequestException('Unable to verify those bank details. Check the account and bank.');
      }
      throw new ServiceUnavailableException('Bank account verification is temporarily unavailable.');
    }
  }

  /** Who is withdrawing, with what the cool-offs need. */
  private async withdrawer(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, kycTier: true, createdAt: true, credentialsChangedAt: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async withdrawNgn(
    userId: string,
    input: { amount: string; accountNumber: string; bankCode: string },
  ) {
    await this.flags.assertNgnWithdrawalsAllowed();
    await this.flags.assertWithdrawalsAllowed();
    await this.policy.assertCooledOff(await this.withdrawer(userId), PolicyAction.NGN_WITHDRAW);

    const amount = dec(input.amount);
    if (!amount.isFinite() || amount.lte(0)) {
      throw new BadRequestException('Enter an amount greater than zero');
    }

    const quote = await this.quoteNgnWithdrawalFee(userId, input.amount);
    if (!quote.limit.allowed) {
      throw new BadRequestException(quote.limit.reason ?? 'Withdrawal limit exceeded');
    }

    // Resolve again at submit time; never trust a client-supplied account name.
    await this.resolveNgnAccountName({
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
    });
    const banks = await this.quidax.fetchBanks().catch(() => {
      throw new ServiceUnavailableException('Naira withdrawals are temporarily unavailable. Try again shortly.');
    });
    const bank = banks.find(
      (candidate) =>
        candidate.code === input.bankCode &&
        candidate.country.toLowerCase() === 'nigeria' &&
        candidate.currency.toLowerCase() === 'ngn',
    );
    if (!bank) throw new BadRequestException('Choose a supported Nigerian bank');

    const platformFee = dec(quote.feeNgn);
    const totalDebit = amount.plus(platformFee);
    const reference = this.quidax.newReference('ngnwd');
    const fx = await this.kycLimits.fx();
    const tx = await this.prisma.serializable(async (t) => {
      // An admin may have switched payouts off while Quidax was answering.
      await this.flags.assertNgnWithdrawalsAllowedIn(t);
      await this.ledger.lock(t, userId, 'ngn', totalDebit);
      const user = await t.user.findUnique({
        where: { id: userId },
        select: { kycTier: true },
      });
      const currentLimit = await this.kycLimits.checkInTransaction(
        t,
        userId,
        user?.kycTier ?? 'TIER_0',
        'withdraw',
        amount,
        fx,
      );
      if (!currentLimit.allowed) {
        throw new BadRequestException(currentLimit.reason ?? 'Withdrawal limit exceeded');
      }
      const created = await t.transaction.create({
        data: {
          userId,
          type: TxType.WITHDRAWAL,
          status: TxStatus.PENDING,
          fromAsset: 'ngn',
          fromAmount: totalDebit.toFixed(),
          toAsset: 'ngn',
          toAmount: amount.toFixed(),
          feeAmount: platformFee.toFixed(),
          feeAsset: 'ngn',
          payoutBankCode: input.bankCode,
          payoutBankName: bank.name,
          payoutAccountLast4: input.accountNumber.slice(-4),
          reference,
        },
      });
      await t.settlementLeg.create({
        data: {
          transactionId: created.id,
          kind: 'BANK_PAYOUT',
          assetCode: 'ngn',
          amount: amount.toFixed(),
          reference,
        },
      });
      return created;
    });

    await this.notifications
      .notify({
        userId,
        transactionId: tx.id,
        type: 'withdrawal.submitted',
        title: `Naira withdrawal requested: ${str(amount, 2)}`,
        body: `To ${bank.name} account ending ${input.accountNumber.slice(-4)}. We will confirm when it is paid.`,
        email: {
          key: 'ngn.withdrawal.submitted',
          variables: {
            amount: str(amount, 2),
            fee: str(platformFee, 2),
            bankName: bank.name,
            accountNumber: `****${input.accountNumber.slice(-4)}`,
            transactionId: tx.id,
          },
        },
      })
      .catch((err: Error) => this.log.error(`Could not notify NGN withdrawal ${tx.id}: ${err.message}`));

    let result: Awaited<ReturnType<QuidaxClient['createNgnBankWithdrawal']>>;
    try {
      result = await this.quidax.createNgnBankWithdrawal({
        amount: amount.toFixed(2),
        accountNumber: input.accountNumber,
        bankCode: input.bankCode,
        reference,
        transactionNote: `DavoChain withdrawal ${tx.id}`,
        narration: 'DavoChain NGN withdrawal',
      });
    } catch (err) {
      if (this.settlement.isUnknown(err)) {
        await this.prisma.settlementLeg.update({
          where: { reference },
          data: {
            state: 'UNKNOWN',
            attempts: { increment: 1 },
            lastError: this.settlement.internalReason(err).slice(0, 1000),
          },
        });
        await this.settlement.markReconciling(tx.id, this.settlement.describe(err), this.settlement.internalReason(err));
        return {
          transactionId: tx.id,
          status: TxStatus.RECONCILING,
          asset: 'ngn',
          amount: str(amount, 2),
          bankName: bank.name,
          accountNumberLast4: input.accountNumber.slice(-4),
        };
      }

      await this.prisma.settlementLeg.update({
        where: { reference },
        data: {
          state: 'FAILED',
          attempts: { increment: 1 },
          lastError: this.settlement.internalReason(err).slice(0, 1000),
        },
      });
      await this.settlement.reverse(tx.id, this.settlement.describe(err));
      throw new BadRequestException(
        `${this.settlement.describe(err)}. Nothing was deducted from your balance.`,
      );
    }

    const providerFee = dec(result.fee ?? 0).plus(result.stamp_duty_fee ?? 0);
    try {
      await this.prisma.$transaction([
        this.prisma.transaction.update({
          where: { id: tx.id },
          data: {
            status: TxStatus.PROCESSING,
            quidaxRef: result.id,
            quidaxRawStatus: result.status,
            networkFee: providerFee.toFixed(2),
          },
        }),
        this.prisma.settlementLeg.update({
          where: { reference },
          data: {
            state: 'SENT',
            quidaxRef: result.id,
            attempts: { increment: 1 },
          },
        }),
      ]);
    } catch (err) {
      // Quidax accepted the request; a DB write failure must never refund it.
      await this.prisma.settlementLeg
        .update({
          where: { reference },
          data: {
            state: 'UNKNOWN',
            quidaxRef: result.id,
            attempts: { increment: 1 },
            lastError: (err as Error).message.slice(0, 1000),
          },
        })
        .catch(() => undefined);
      await this.settlement.markReconciling(tx.id, 'Being checked — awaiting confirmation', `Provider accepted payout but local update failed: ${(err as Error).message}`);
      return {
        transactionId: tx.id,
        status: TxStatus.RECONCILING,
        asset: 'ngn',
        amount: str(amount, 2),
        bankName: bank.name,
        accountNumberLast4: input.accountNumber.slice(-4),
      };
    }

    return {
      transactionId: tx.id,
      status: TxStatus.PROCESSING,
      asset: 'ngn',
      amount: str(amount, 2),
      feeNgn: str(platformFee, 2),
      totalDebited: str(totalDebit, 2),
      bankName: bank.name,
      accountNumberLast4: input.accountNumber.slice(-4),
    };
  }

  async withdrawCrypto(
    userId: string,
    input: {
      asset: string;
      network: string;
      amount: string;
      address: string;
      destinationTag?: string;
    },
  ) {
    await this.flags.assertWithdrawalsAllowed();
    const user = await this.withdrawer(userId);
    await this.policy.assertCooledOff(user, PolicyAction.CRYPTO_WITHDRAW);

    const { code, network } = await assertCryptoDestination(this.prisma, input);
    const asset = await this.assets.require(code);

    const amount = dec(input.amount);
    const cfg = await this.rates.rateConfig(code);

    // NOT assertTransferable(): those are the INTERNAL sub <-> main limits and
    // they do not govern an on-chain send. Quidax enforces the chain minimum on
    // its side; we surface its rejection rather than guessing at the number.
    if (amount.lte(0)) {
      throw new BadRequestException('Enter an amount greater than zero');
    }

    const { platformFee, platformFeeUsd, networkFee, usdValue } = await this.fees(
      code,
      amount,
      input.network,
      cfg,
    );
    const totalDebit = amount.plus(platformFee).plus(networkFee);

    const reference = this.quidax.newReference('wd');
    const subId = await this.settlement.quidaxIdFor(userId);

    // Level rules: a limit is never skipped because a price is missing.
    const level = levelOf(user.kycTier);
    if (!usdValue) {
      const rule = (await this.policy.rulesFor(level)).find((r) => r.action === PolicyAction.CRYPTO_WITHDRAW);
      if (rule && (rule.minPerTx != null || rule.maxPerTx != null || rule.maxPerDay != null)) {
        throw new ServiceUnavailableException('Pricing is unavailable right now. Please try again shortly.');
      }
    }
    const fx = await this.policy.fx();

    // Debit under lock BEFORE the call out.
    const tx = await this.prisma.serializable(async (t) => {
      await this.policy.assertWithinLimits(t, userId, level, PolicyAction.CRYPTO_WITHDRAW, usdValue ?? ZERO, 'USD', fx);
      await this.ledger.lock(t, userId, code, totalDebit);
      const created = await t.transaction.create({
        data: {
          userId,
          type: TxType.WITHDRAWAL,
          status: TxStatus.PENDING,
          fromAsset: code,
          fromAmount: totalDebit.toFixed(),
          toAsset: code,
          toAmount: amount.toFixed(),
          // What we keep, and what the chain takes, recorded apart. Blending
          // them would report a cost we paid out as revenue we earned.
          feeAmount: platformFee.toFixed(),
          feeAsset: code,
          feeUsd: platformFeeUsd?.toFixed() ?? null,
          networkFee: networkFee.toFixed(),
          usdValue: usdValue?.toFixed() ?? null,
          reference,
          rateConfigId: cfg.id,
        },
      });
      await t.settlementLeg.create({
        data: {
          transactionId: created.id,
          kind: 'CHAIN_WITHDRAWAL',
          assetCode: code,
          amount: amount.toFixed(),
          reference,
        },
      });
      return created;
    });

    /*
     * Told before it goes, not after.
     *
     * This is the email somebody reads when a withdrawal they did not make
     * appears in their inbox — and the only moment at which it can still be
     * stopped. Sending it only on success would mean the first warning arrives
     * after the coins are on a chain, which is too late to be a warning.
     *
     * Queued, so a slow mailer cannot delay the send itself.
     */
    await this.notifications.notify({
      userId,
      transactionId: tx.id,
      type: 'withdrawal.submitted',
      title: `Withdrawal requested: ${str(amount, asset.displayScale)} ${code.toUpperCase()}`,
      body: `To ${input.address.slice(0, 10)}…${input.address.slice(-6)}. We will confirm when it leaves.`,
      email: {
        key: 'withdrawal.submitted',
        variables: {
          amount: str(amount, asset.displayScale),
          assetCode: code.toUpperCase(),
          address: input.address,
          networkLabel: network?.label ?? input.network,
          transactionId: tx.id,
        },
      },
    });

    // The call out, alone in its try: only ITS failure can be a refund.
    let result: Awaited<ReturnType<QuidaxClient['createCryptoWithdrawal']>>;
    try {
      result = await this.quidax.createCryptoWithdrawal(subId, {
        currency: code,
        amount: amount.toFixed(),
        fund_uid: input.address,
        fund_uid2: input.destinationTag ?? null,
        network: input.network,
        reference,
      });
    } catch (err) {
      // Unknown outcome: the send may have gone out. Funds stay locked.
      if (this.settlement.isUnknown(err)) {
        await this.prisma.settlementLeg.update({
          where: { reference },
          data: {
            state: 'UNKNOWN',
            attempts: { increment: 1 },
            lastError: this.settlement.internalReason(err).slice(0, 1000),
          },
        });
        await this.settlement.markReconciling(tx.id, this.settlement.describe(err), this.settlement.internalReason(err));
        return {
          transactionId: tx.id,
          status: TxStatus.RECONCILING,
          asset: code,
          amount: str(amount, asset.displayScale),
          address: input.address,
        };
      }
      await this.prisma.settlementLeg.update({
        where: { reference },
        data: {
          state: 'FAILED',
          attempts: { increment: 1 },
          lastError: this.settlement.internalReason(err).slice(0, 1000),
        },
      });
      await this.settlement.reverse(tx.id, this.settlement.describe(err));
      throw new BadRequestException(
        `${this.settlement.describe(err)}. Nothing was deducted from your balance.`,
      );
    }

    try {
      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: {
          status: TxStatus.PROCESSING,
          quidaxRef: result.id,
          quidaxRawStatus: result.status,
          networkFee: dec(result.fee).toFixed(),
        },
      });
      await this.prisma.settlementLeg.update({
        where: { reference },
        data: {
          state: result.status.toLowerCase() === 'done' ? 'CONFIRMED' : 'SENT',
          quidaxRef: result.id,
          attempts: { increment: 1 },
        },
      });
    } catch (err) {
      // C3: Quidax accepted the send, so the coins are on their way. A failure
      // in our own database must never refund it: hold the funds for the
      // reconciler instead.
      await this.prisma.settlementLeg
        .update({
          where: { reference },
          data: {
            state: 'UNKNOWN',
            quidaxRef: result.id,
            attempts: { increment: 1 },
            lastError: (err as Error).message.slice(0, 1000),
          },
        })
        .catch(() => undefined);
      await this.settlement.markReconciling(tx.id, 'Being checked — awaiting confirmation', `Provider accepted withdrawal but local update failed: ${(err as Error).message}`);
      return {
        transactionId: tx.id,
        status: TxStatus.RECONCILING,
        asset: code,
        amount: str(amount, asset.displayScale),
        address: input.address,
      };
    }

    return {
      transactionId: tx.id,
      status: TxStatus.PROCESSING,
      asset: code,
      amount: str(amount, asset.displayScale),
      address: input.address,
    };
  }

  async history(userId: string, limit = 50) {
    const rows = await this.prisma.transaction.findMany({
      where: { userId, type: TxType.WITHDRAWAL },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
    return rows.map((t) => ({
      id: t.id,
      asset: t.fromAsset,
      amount: t.toAmount ? str(t.toAmount, t.fromAsset === 'ngn' ? 2 : 8) : null,
      totalDebited: t.fromAmount ? str(t.fromAmount, t.fromAsset === 'ngn' ? 2 : 8) : null,
      feeAmount: t.feeAmount ? str(t.feeAmount, t.fromAsset === 'ngn' ? 2 : 8) : '0',
      networkFee: t.networkFee ? str(t.networkFee, t.fromAsset === 'ngn' ? 2 : 8) : '0',
      bankName: t.payoutBankName,
      accountNumberLast4: t.payoutAccountLast4,
      status: t.status,
      reason: t.failureReason,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    }));
  }
}
