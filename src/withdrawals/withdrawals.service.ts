import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { FeeKind, TxStatus, TxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { LedgerService } from '../ledger/ledger.service';
import { AssetsService } from '../assets/assets.service';
import { SettlementService } from '../trades/settlement.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RatesService } from '../rates/rates.service';
import { FeeBandsService } from '../rates/fee-bands.service';
import { KycLimitsService } from '../kyc/kyc-limits.service';
import { ZERO, dec, str, type Decimal } from '../common/money';

/**
 * Crypto leaves from the user's OWN sub-account — inventory is never touched,
 * so a withdrawal can never compete with a buy.
 *
 * Naira leaves through a separate payout provider, which is still undecided.
 * See TODO.md: Quidax's bank-withdrawal endpoints are deliberately unused.
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
    const upstream = await this.quidax
      .fetchWithdrawalFee({ currency: code, amount: amount.toFixed(), network: networkId })
      // A withdrawal must not fail because a fee lookup did. Quidax deducts its
      // own fee regardless; showing zero here understates a line we do not set.
      .catch(() => ({ fee: 0, type: 'unknown' }));
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
    const code = assetCode.toLowerCase();
    const [asset, cfg] = await Promise.all([
      this.assets.require(code),
      this.rates.rateConfig(code),
    ]);

    const total = dec(amount);
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
   * The payout itself is not built: Davochain does not have a naira payout
   * provider yet, and Quidax's bank endpoints are deliberately unused (see
   * TODO.md). This prices it so the ladder can be set, agreed and shown before
   * the rail exists, rather than being invented on the day it arrives.
   */
  async quoteNgnWithdrawalFee(userId: string, ngnAmount: string) {
    const amount = dec(ngnAmount);
    if (amount.lte(0)) throw new BadRequestException('Enter an amount greater than zero');

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
        singleLimit: str(limit.singleLimit, 2),
        dailyLimit: str(limit.dailyLimit, 2),
        usedToday: str(limit.usedToday, 2),
        remainingToday: str(limit.remainingToday.lt(0) ? ZERO : limit.remainingToday, 2),
      },
      /** There is no rail yet — this is the price, not a promise it will send. */
      payoutAvailable: false,
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

    const code = input.asset.toLowerCase();
    const asset = await this.assets.require(code);

    const network = await this.prisma.assetNetwork.findUnique({
      where: { assetCode_networkId: { assetCode: code, networkId: input.network } },
    });
    if (!network || !network.isListed) {
      throw new BadRequestException(`${code.toUpperCase()} is not available on ${input.network}`);
    }
    // Arbitrum is deposit-only for USDT today, and nothing in the docs says so.
    if (!network.withdrawsEnabled) {
      throw new BadRequestException(
        `Withdrawals are disabled for ${code.toUpperCase()} on ${network.label}`,
      );
    }
    if (network.requiresTag && !input.destinationTag) {
      throw new BadRequestException(
        `${network.label} requires a destination tag. Without it the funds cannot be credited.`,
      );
    }
    if (network.addressRegex && !new RegExp(network.addressRegex).test(input.address)) {
      throw new BadRequestException(`That does not look like a valid ${network.label} address`);
    }

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
    const totalDebit = amount.plus(platformFee);

    const reference = this.quidax.newReference('wd');
    const subId = await this.settlement.quidaxIdFor(userId);

    // Debit under lock BEFORE the call out.
    const tx = await this.prisma.serializable(async (t) => {
      await this.ledger.lock(t, userId, code, totalDebit);
      return t.transaction.create({
        data: {
          userId,
          type: TxType.WITHDRAWAL,
          status: TxStatus.PENDING,
          fromAsset: code,
          fromAmount: totalDebit.toFixed(),
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

    try {
      const result = await this.quidax.createCryptoWithdrawal(subId, {
        currency: code,
        amount: amount.toFixed(),
        fund_uid: input.address,
        fund_uid2: input.destinationTag ?? null,
        network: input.network,
        reference,
      });

      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: {
          status: TxStatus.PROCESSING,
          quidaxRef: result.id,
          quidaxRawStatus: result.status,
        },
      });

      return {
        transactionId: tx.id,
        status: TxStatus.PROCESSING,
        asset: code,
        amount: str(amount, asset.displayScale),
        address: input.address,
      };
    } catch (err) {
      // Unknown outcome: the send may have gone out. Funds stay locked.
      if (this.settlement.isUnknown(err)) {
        await this.settlement.markReconciling(tx.id, this.settlement.describe(err));
        return {
          transactionId: tx.id,
          status: TxStatus.RECONCILING,
          asset: code,
          amount: str(amount, asset.displayScale),
          address: input.address,
        };
      }
      await this.settlement.reverse(tx.id, this.settlement.describe(err));
      throw new BadRequestException(
        `${this.settlement.describe(err)}. Nothing was deducted from your balance.`,
      );
    }
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
      amount: t.fromAmount ? str(t.fromAmount) : null,
      status: t.status,
      reason: t.failureReason,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    }));
  }
}
