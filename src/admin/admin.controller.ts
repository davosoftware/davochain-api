import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AdminRole,
  FeeKind,
  GiftCardTradeStatus,
  KycTier,
  ReferralStatus,
  TxStatus,
  TxType,
} from '@prisma/client';
import { AdminService, type AdminJwtPayload } from './admin.service';
import { UsersAdminService } from './users-admin.service';
import { AdminsService } from './admins.service';
import { AdminSessionsService } from './sessions.service';
import { OverviewService } from './overview.service';
import {
  EarningsService,
  type EarningCurrency,
  type EarningKind,
  type EarningQuery,
} from './earnings.service';
import { AdminTransactionsService, type TxQuery } from './transactions.service';
import { ReferralsService } from '../referrals/referrals.service';
import { GiftCardsAdminService } from '../giftcards/giftcards-admin.service';
import { GiftCardsService } from '../giftcards/giftcards.service';
import { CURRENCIES } from '../giftcards/currencies';
import {
  ApproveGiftCardDto,
  GiftCardBrandDto,
  GiftCardCategoryDto,
  GiftCardTypeDto,
  PartialApproveGiftCardDto,
  RejectGiftCardDto,
} from '../giftcards/dto';
import { SiteSettingsService } from './site-settings.service';
import { CredentialsService } from '../common/credentials.service';
import { KycLimitsService } from '../kyc/kyc-limits.service';
import { FeeBandsService } from '../rates/fee-bands.service';
import { AdminGuard } from './admin.guard';
import { CurrentAdmin } from './current-admin.decorator';
import { RequirePermissions } from './require-permissions.decorator';
import { PERMISSION_GROUPS } from './permissions';
import {
  AcceptInviteDto,
  AdminLoginDto,
  BroadcastDto,
  ChangePasswordDto,
  CreateAdminDto,
  SetAvatarDto,
  UpdateProfileDto,
  SetFeeLadderDto,
  RequestResetDto,
  ResetPasswordDto,
  SetPermissionsDto,
  SetRoleDto,
  KycLimitsDto,
  SetCredentialDto,
  SiteLogoDto,
  SiteSettingsDto,
  SuspendUserDto,
  ClaimFeesDto,
  InventoryTargetDto,
  PauseDto,
  RecordRefillDto,
  ReferralSettingsDto,
  RejectDepositDto,
  ReviewKycDto,
  SetGateDto,
} from './dto';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { InventoryService } from '../inventory/inventory.service';
import { FeeClaimsService } from '../fees/fee-claims.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { SystemFlagsService } from '../common/system-flags.service';
import { CmsService } from '../cms/cms.service';
import { EmailTemplateService } from '../cms/email-template.service';
import { isEmailTemplateKey } from '../cms/email-templates';
import { SocialLinksService, KNOWN_NETWORKS, ICON_PIXELS } from '../cms/social-links.service';
import {
  CreateFaqDto,
  CreatePageDto,
  EmailImageDto,
  PreviewEmailDto,
  ReorderDto,
  SocialIconDto,
  SocialLinkDto,
  UpdateEmailTemplateDto,
  UpdateFaqDto,
  UpdatePageDto,
} from '../cms/dto';
import { dec } from '../common/money';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

/**
 * The ladder name from a URL. Derived from the enum rather than listed by
 * hand, so adding a fourth fee cannot leave this behind rejecting it.
 */
const LADDER_NAMES = Object.values(FeeKind);

function parseKind(value: string): FeeKind {
  const upper = value?.toUpperCase() as FeeKind;
  if (LADDER_NAMES.includes(upper)) return upper;
  throw new BadRequestException(
    `Ladder must be one of: ${LADDER_NAMES.map((k) => k.toLowerCase()).join(', ')}`,
  );
}

@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly users: UsersAdminService,
    private readonly admins: AdminsService,
    private readonly sessions: AdminSessionsService,
    private readonly overview: OverviewService,
    private readonly earnings: EarningsService,
    private readonly txs: AdminTransactionsService,
    private readonly referrals: ReferralsService,
    private readonly giftcards: GiftCardsAdminService,
    private readonly userGiftcards: GiftCardsService,
    private readonly site: SiteSettingsService,
    private readonly credentials: CredentialsService,
    private readonly kycLimits: KycLimitsService,
    private readonly bands: FeeBandsService,
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
    private readonly inventory: InventoryService,
    private readonly claims: FeeClaimsService,
    private readonly reconciliation: ReconciliationService,
    private readonly flags: SystemFlagsService,
    private readonly cms: CmsService,
    private readonly templates: EmailTemplateService,
    private readonly socials: SocialLinksService,
  ) {}

  // ── gates ─────────────────────────────────────────────────

  @Get('rate-configs')
  @RequirePermissions('fees.view')
  gates() {
    return this.admin.gates();
  }

  @Put('rate-configs/:asset')
  @RequirePermissions('fees.manage')
  setGate(
    @CurrentAdmin('sub') adminId: string,
    @Param('asset') asset: string,
    @Body() dto: SetGateDto,
  ) {
    return this.admin.setGate(adminId, asset, dto);
  }

  // ── inventory desk ────────────────────────────────────────

  @Get('inventory')
  @RequirePermissions('inventory.view')
  inventorySnapshot() {
    return this.inventory.snapshot();
  }

  @Get('inventory/fuel')
  @RequirePermissions('inventory.view')
  async fuel() {
    const fuel = await this.inventory.fuelLevel();
    return {
      balanceNgn: fuel.balanceNgn.toFixed(2),
      dailyBurnNgn: fuel.dailyBurnNgn.toFixed(2),
      daysOfCover: fuel.daysOfCover.toFixed(1),
    };
  }

  @Put('inventory/targets')
  @RequirePermissions('inventory.manage')
  async setTarget(@CurrentAdmin('sub') adminId: string, @Body() dto: InventoryTargetDto) {
    const before = await this.prisma.inventorySetting.findUnique({
      where: { assetCode: dto.asset },
    });
    const after = await this.prisma.inventorySetting.upsert({
      where: { assetCode: dto.asset },
      create: {
        assetCode: dto.asset,
        target: dto.target ?? '0',
        floorPct: dto.floorPct ?? '25',
        dipAlertPct: dto.dipAlertPct ?? '5',
        fallbackSwapEnabled: dto.fallbackSwapEnabled ?? true,
      },
      update: {
        ...(dto.target !== undefined ? { target: dto.target } : {}),
        ...(dto.floorPct !== undefined ? { floorPct: dto.floorPct } : {}),
        ...(dto.dipAlertPct !== undefined ? { dipAlertPct: dto.dipAlertPct } : {}),
        ...(dto.fallbackSwapEnabled !== undefined
          ? { fallbackSwapEnabled: dto.fallbackSwapEnabled }
          : {}),
      },
    });
    await this.admin.audit(
      adminId,
      'inventory.target',
      'InventorySetting',
      dto.asset,
      before,
      after,
    );
    return after;
  }

  /** Record a restock you made elsewhere — closes the period and resets drift. */
  @Post('inventory/refill')
  @RequirePermissions('inventory.manage')
  async refill(@CurrentAdmin('sub') adminId: string, @Body() dto: RecordRefillDto) {
    await this.inventory.recordRefill({
      assetCode: dto.asset.toLowerCase(),
      quantity: dec(dto.quantity),
      pricePaidUsd: dec(dto.pricePaidUsd),
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      recordedBy: adminId,
      note: dto.note,
    });
    await this.admin.audit(adminId, 'inventory.refill', 'Refill', dto.asset, null, dto);
    return { recorded: true };
  }

  // ── fee claims ────────────────────────────────────────────

  @Get('fees/claimable')
  @RequirePermissions('claims.view')
  claimable() {
    return this.claims.claimable();
  }

  /** Enqueues — never blocks. Runs on the throttled background lane. */
  @Post('fees/claim')
  @RequirePermissions('claims.manage')
  async claim(@CurrentAdmin('sub') adminId: string, @Body() dto: ClaimFeesDto) {
    const result = await this.claims.startRun(adminId, dto.assets);
    await this.admin.audit(adminId, 'fees.claim', 'FeeClaimRun', result.runId, null, dto);
    return result;
  }

  @Get('fees/claims/:id')
  @RequirePermissions('claims.view')
  claimStatus(@Param('id') id: string) {
    return this.claims.runStatus(id);
  }

  // ── oversight ─────────────────────────────────────────────

  /**
   * Every figure the dashboard shows, in one pass over the database.
   *
   * from/to narrow the flows. Balances ignore them — what users hold is true
   * now and has no date range — and the screen labels those so nobody reads
   * them as belonging to the period.
   */
  /** A from/to pair off the query string, or a complaint about why it is not one. */
  private range(from?: string, to?: string): { from?: Date; to?: Date } {
    const parse = (value: string | undefined, label: string): Date | undefined => {
      if (!value) return undefined;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw new BadRequestException(`${label} is not a date`);
      }
      return date;
    };

    const parsedFrom = parse(from, 'from');
    const parsedTo = parse(to, 'to');
    if (parsedFrom && parsedTo && parsedFrom > parsedTo) {
      throw new BadRequestException('The range starts after it ends');
    }
    return { from: parsedFrom, to: parsedTo };
  }

  @Get('overview')
  @RequirePermissions('overview.view')
  overviewSnapshot(@Query('from') from?: string, @Query('to') to?: string) {
    return this.overview.snapshot(this.range(from, to));
  }

  @Get('margin')
  @RequirePermissions('overview.view')
  margin(@Query('days') days?: string) {
    return this.admin.margin(days ? Number(days) : 30);
  }

  @Get('reconciliation')
  @RequirePermissions('reconciliation.view')
  reconcile() {
    return this.reconciliation.checkInvariants();
  }

  /**
   * The flat list the old screen used, kept for anything already calling it.
   *
   * The transactions manager uses `/transactions/manager` below, which pages,
   * searches and knows what is waiting on a person.
   */
  @Get('transactions')
  @RequirePermissions('transactions.view')
  transactions(
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('userId') userId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.admin.transactions({
      status,
      type,
      userId,
      limit: limit ? Number(limit) : 100,
    });
  }

  /**
   * The filters, validated once for every route on the transactions manager.
   *
   * An unknown tab or status is refused rather than quietly ignored: a filter
   * that silently does nothing is worse than one that says it was not
   * understood, because the rows still look plausible.
   */
  private txQuery(q: {
    tab?: string;
    status?: string;
    type?: string;
    amountType?: string;
    mode?: string;
    search?: string;
    from?: string;
    to?: string;
    direction?: string;
  }): TxQuery {
    const TABS = ['ALL', 'BUY', 'SELL', 'SWAP', 'DEPOSIT', 'WITHDRAWAL', 'APPROVAL'];
    const MODES = ['BANK', 'NGN_BALANCE', 'CHAIN', 'INTERNAL'];

    if (q.tab && !TABS.includes(q.tab)) {
      throw new BadRequestException(`tab must be one of ${TABS.join(', ')}`);
    }
    if (q.status && !(q.status in TxStatus)) {
      throw new BadRequestException(`status must be one of ${Object.keys(TxStatus).join(', ')}`);
    }
    if (q.type && !(q.type in TxType)) {
      throw new BadRequestException(`type must be one of ${Object.keys(TxType).join(', ')}`);
    }
    if (q.amountType && q.amountType !== 'DEBIT' && q.amountType !== 'CREDIT') {
      throw new BadRequestException('amountType must be DEBIT or CREDIT');
    }
    if (q.mode && !MODES.includes(q.mode)) {
      throw new BadRequestException(`mode must be one of ${MODES.join(', ')}`);
    }

    return {
      ...this.range(q.from, q.to),
      tab: (q.tab as TxQuery['tab']) ?? 'ALL',
      status: q.status as TxStatus | undefined,
      type: q.type as TxType | undefined,
      amountType: q.amountType as 'DEBIT' | 'CREDIT' | undefined,
      mode: q.mode,
      search: q.search,
      direction: q.direction === 'asc' ? 'asc' : 'desc',
    };
  }

  @Get('transactions/manager')
  @RequirePermissions('transactions.view')
  transactionsManager(
    @Query('tab') tab?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('amountType') amountType?: string,
    @Query('mode') mode?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('direction') direction?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.txs.list({
      ...this.txQuery({ tab, status, type, amountType, mode, search, from, to, direction }),
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** Everything matching, for a CSV. Audited — it carries names and emails. */
  @Get('transactions/manager/export')
  @RequirePermissions('transactions.view')
  async transactionsExport(
    @CurrentAdmin('sub') adminId: string,
    @Query('tab') tab?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('amountType') amountType?: string,
    @Query('mode') mode?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('direction') direction?: string,
  ) {
    const query = this.txQuery({ tab, status, type, amountType, mode, search, from, to, direction });
    const result = await this.txs.all(query);
    await this.admin.audit(adminId, 'transactions.export', 'Transaction', null, null, {
      rows: result.rows.length,
      truncated: result.truncated,
      filters: { tab, status, type, amountType, mode, search, from, to },
    });
    return result;
  }

  /**
   * Credit a naira deposit that was held over the depositor's tier limit.
   *
   * This moves real money into a balance, which is why it has a permission of
   * its own rather than riding on `transactions.view`, and why the before and
   * after are both written to the audit log.
   */
  @Post('transactions/:id/release')
  @HttpCode(200)
  @RequirePermissions('transactions.approve')
  async releaseTransaction(@CurrentAdmin('sub') adminId: string, @Param('id') id: string) {
    const before = await this.txs.one(id);
    const after = await this.txs.release(id);
    await this.admin.audit(adminId, 'transaction.release', 'Transaction', id, before, after);
    return after;
  }

  /** Refuse a held naira deposit. No money moves; the user is told why. */
  @Post('transactions/:id/reject')
  @HttpCode(200)
  @RequirePermissions('transactions.approve')
  async rejectTransaction(
    @CurrentAdmin('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: RejectDepositDto,
  ) {
    const before = await this.txs.one(id);
    const after = await this.txs.reject(id, dto.reason);
    await this.admin.audit(adminId, 'transaction.reject', 'Transaction', id, before, after);
    return after;
  }

  // ── gift cards ────────────────────────────────────────────

  @Get('giftcards/categories')
  @RequirePermissions('giftcards.view')
  giftCardCategories() {
    return this.giftcards.categories();
  }

  @Put('giftcards/categories')
  @RequirePermissions('giftcards.manage')
  async saveGiftCardCategory(
    @CurrentAdmin('sub') adminId: string,
    @Body() dto: GiftCardCategoryDto,
  ) {
    const saved = await this.giftcards.saveCategory(adminId, dto);
    await this.admin.audit(adminId, 'giftcard.category.save', 'GiftCardBrandCategory', saved.id, null, saved);
    return saved;
  }

  @Delete('giftcards/categories/:id')
  @RequirePermissions('giftcards.manage')
  async deleteGiftCardCategory(@CurrentAdmin('sub') adminId: string, @Param('id') id: string) {
    const result = await this.giftcards.deleteCategory(id);
    await this.admin.audit(adminId, 'giftcard.category.delete', 'GiftCardBrandCategory', id, null, null);
    return result;
  }

  @Get('giftcards/brands')
  @RequirePermissions('giftcards.view')
  giftCardBrands() {
    return this.giftcards.brands();
  }

  @Put('giftcards/brands')
  @RequirePermissions('giftcards.manage')
  async saveGiftCardBrand(@CurrentAdmin('sub') adminId: string, @Body() dto: GiftCardBrandDto) {
    const saved = await this.giftcards.saveBrand(adminId, dto);
    // The picture is megabytes of base64 and would bloat every audit row.
    await this.admin.audit(adminId, 'giftcard.brand.save', 'GiftCardBrand', saved.id, null, {
      name: saved.name,
      categoryId: saved.categoryId,
      isActive: saved.isActive,
      imageChanged: Boolean(dto.image),
    });
    return { id: saved.id, name: saved.name };
  }

  @Delete('giftcards/brands/:id')
  @RequirePermissions('giftcards.manage')
  async deleteGiftCardBrand(@CurrentAdmin('sub') adminId: string, @Param('id') id: string) {
    const result = await this.giftcards.deleteBrand(id);
    await this.admin.audit(adminId, 'giftcard.brand.delete', 'GiftCardBrand', id, null, null);
    return result;
  }

  @Get('giftcards/types')
  @RequirePermissions('giftcards.view')
  giftCardTypes() {
    return this.giftcards.types();
  }

  /**
   * The currencies a card type may be priced in.
   *
   * Served rather than hardcoded in the dashboard so the dropdown can only
   * offer codes the app has a symbol for — a currency the admin can pick but
   * the app cannot draw would give the seller a bare number in the amount
   * field.
   */
  @Get('giftcards/currencies')
  @RequirePermissions('giftcards.view')
  giftCardCurrencies() {
    return CURRENCIES;
  }

  /** The rate here is what every user is quoted from the moment it is saved. */
  @Put('giftcards/types')
  @RequirePermissions('giftcards.manage')
  async saveGiftCardType(@CurrentAdmin('sub') adminId: string, @Body() dto: GiftCardTypeDto) {
    const before = dto.id
      ? await this.prisma.giftCardType.findUnique({ where: { id: dto.id } })
      : null;
    const saved = await this.giftcards.saveType(adminId, dto);
    await this.admin.audit(adminId, 'giftcard.type.save', 'GiftCardType', saved.id, before, saved);
    return saved;
  }

  @Delete('giftcards/types/:id')
  @RequirePermissions('giftcards.manage')
  async deleteGiftCardType(@CurrentAdmin('sub') adminId: string, @Param('id') id: string) {
    const result = await this.giftcards.deleteType(id);
    await this.admin.audit(adminId, 'giftcard.type.delete', 'GiftCardType', id, null, null);
    return result;
  }

  // ── the trade queue ───────────────────────────────────────

  @Get('giftcards/trades')
  @RequirePermissions('giftcards.view')
  giftCardTrades(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (status && !(status in GiftCardTradeStatus)) {
      throw new BadRequestException(
        `status must be one of ${Object.keys(GiftCardTradeStatus).join(', ')}`,
      );
    }
    return this.giftcards.trades({
      status: status as GiftCardTradeStatus | undefined,
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** The only place a voucher code is decrypted. Reading one is audited. */
  @Get('giftcards/trades/:id')
  @RequirePermissions('giftcards.view')
  async giftCardTrade(@CurrentAdmin('sub') adminId: string, @Param('id') id: string) {
    const trade = await this.giftcards.trade(id);
    if (trade.code) {
      await this.admin.audit(adminId, 'giftcard.code.read', 'GiftCardTrade', id, null, null);
    }
    return trade;
  }

  @Get('giftcards/trades/:id/images/:imageId')
  @RequirePermissions('giftcards.view')
  async giftCardTradeImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Res() res: Response,
  ) {
    // null: an admin may see any trade's photographs, not only their own.
    const { image, type } = await this.userGiftcards.tradeImage(null, id, imageId);
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'private, max-age=3600');
    res.end(image);
  }

  @Post('giftcards/trades/:id/approve')
  @HttpCode(200)
  @RequirePermissions('giftcards.review')
  async approveGiftCard(
    @CurrentAdmin('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: ApproveGiftCardDto,
  ) {
    const after = await this.giftcards.approve(adminId, id, dto.actualRateNgn);
    await this.admin.audit(adminId, 'giftcard.approve', 'GiftCardTrade', id, null, after);
    return after;
  }

  @Post('giftcards/trades/:id/partial')
  @HttpCode(200)
  @RequirePermissions('giftcards.review')
  async partiallyApproveGiftCard(
    @CurrentAdmin('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: PartialApproveGiftCardDto,
  ) {
    const after = await this.giftcards.partiallyApprove(adminId, id, dto);
    await this.admin.audit(adminId, 'giftcard.partial', 'GiftCardTrade', id, null, after);
    return after;
  }

  @Post('giftcards/trades/:id/reject')
  @HttpCode(200)
  @RequirePermissions('giftcards.review')
  async rejectGiftCard(
    @CurrentAdmin('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: RejectGiftCardDto,
  ) {
    const after = await this.giftcards.reject(adminId, id, dto.reason);
    await this.admin.audit(adminId, 'giftcard.reject', 'GiftCardTrade', id, null, after);
    return after;
  }

  // ── referrals and rewards ─────────────────────────────────

  @Get('referrals/settings')
  @RequirePermissions('referrals.view')
  async referralSettings() {
    return this.referrals.view(await this.referrals.settings());
  }

  /**
   * Change the offer.
   *
   * Audited with both halves, because this is the figure every future payout
   * is copied from — "who lowered the referral bonus and when" is a question
   * somebody eventually asks.
   */
  @Put('referrals/settings')
  @RequirePermissions('referrals.manage')
  async setReferralSettings(
    @CurrentAdmin('sub') adminId: string,
    @Body() dto: ReferralSettingsDto,
  ) {
    const before = await this.referrals.settings();
    const after = await this.referrals.updateSettings(adminId, dto);
    await this.admin.audit(adminId, 'referrals.settings', 'ReferralSetting', 'default', before, after);
    return this.referrals.view(after);
  }

  @Get('referrals')
  @RequirePermissions('referrals.view')
  referralList(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (status && !(status in ReferralStatus)) {
      throw new BadRequestException(
        `status must be one of ${Object.keys(ReferralStatus).join(', ')}`,
      );
    }
    return this.referrals.adminList({
      status: status as ReferralStatus | undefined,
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  // ── earnings ──────────────────────────────────────────────

  /**
   * The filters, validated once for every earnings route.
   *
   * Rejects an unknown ladder or currency rather than quietly returning
   * everything: a filter that silently does nothing is worse than one that
   * says it was not understood, because the numbers still look plausible.
   */
  private earningQuery(q: {
    kind?: string;
    currency?: string;
    type?: string;
    search?: string;
    from?: string;
    to?: string;
    sort?: string;
    direction?: string;
  }): EarningQuery {
    const KINDS = ['RATE', 'SWAP', 'WITHDRAWAL', 'NGN_WITHDRAWAL', 'GIFT_CARD'];
    const TYPES = ['BUY', 'SELL', 'SWAP', 'WITHDRAWAL', 'GIFT_CARD'];

    if (q.kind && !KINDS.includes(q.kind)) {
      throw new BadRequestException(`kind must be one of ${KINDS.join(', ')}`);
    }
    if (q.currency && q.currency !== 'NGN' && q.currency !== 'USD') {
      throw new BadRequestException('currency must be NGN or USD');
    }
    if (q.type && !TYPES.includes(q.type)) {
      throw new BadRequestException(`type must be one of ${TYPES.join(', ')}`);
    }

    return {
      ...this.range(q.from, q.to),
      kind: q.kind as EarningKind | undefined,
      currency: q.currency as EarningCurrency | undefined,
      type: q.type,
      search: q.search,
      sort: q.sort === 'fee' ? 'fee' : 'createdAt',
      direction: q.direction === 'asc' ? 'asc' : 'desc',
    };
  }

  /**
   * One page of earnings, plus what the whole filtered set adds up to.
   *
   * The totals are for everything that matches, not for the rows on this page —
   * a total that only covered the visible ten would be a different number on
   * every page and would answer no question anybody has.
   */
  @Get('earnings')
  @RequirePermissions('earnings.view')
  async earningsList(
    @Query('kind') kind?: string,
    @Query('currency') currency?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sort') sort?: string,
    @Query('direction') direction?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const query = this.earningQuery({ kind, currency, type, search, from, to, sort, direction });

    const [list, totals, summary] = await Promise.all([
      this.earnings.list({
        ...query,
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
      }),
      this.earnings.totals(query),
      // Tab-independent, so the four ladder figures stay still while somebody
      // clicks between them.
      this.earnings.summary(query),
    ]);

    return { ...list, totals, summary };
  }

  /**
   * Everything matching, for a spreadsheet.
   *
   * Audited. This is a bulk export of who paid what, with names and email
   * addresses attached, and the one question worth being able to answer later
   * is who took a copy of it.
   */
  @Get('earnings/export')
  @RequirePermissions('earnings.view')
  async earningsExport(
    @CurrentAdmin('sub') adminId: string,
    @Query('kind') kind?: string,
    @Query('currency') currency?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sort') sort?: string,
    @Query('direction') direction?: string,
  ) {
    const query = this.earningQuery({ kind, currency, type, search, from, to, sort, direction });
    const result = await this.earnings.all(query);

    await this.admin.audit(adminId, 'earnings.export', 'Transaction', null, null, {
      rows: result.rows.length,
      truncated: result.truncated,
      filters: { kind, currency, type, search, from, to },
    });

    return result;
  }

  // ── assets ────────────────────────────────────────────────

  @Post('assets/sync-networks')
  @RequirePermissions('inventory.manage')
  async sync(@CurrentAdmin('sub') adminId: string) {
    const result = await this.assets.syncAll();
    await this.admin.audit(adminId, 'assets.sync', 'AssetNetwork', null, null, result);
    return result;
  }

  // ── kill switches ─────────────────────────────────────────

  @Post('pause')
  @RequirePermissions('fees.manage')
  @HttpCode(200)
  async pause(@CurrentAdmin('sub') adminId: string, @Body() dto: PauseDto) {
    await this.flags.pauseAsset(dto.asset, adminId, dto.reason ?? 'manual');
    await this.admin.audit(adminId, 'asset.pause', 'SystemFlag', dto.asset, null, dto);
    return { paused: dto.asset };
  }

  @Post('resume')
  @RequirePermissions('fees.manage')
  @HttpCode(200)
  async resume(@CurrentAdmin('sub') adminId: string, @Body() dto: PauseDto) {
    await this.flags.resumeAsset(dto.asset, adminId);
    await this.admin.audit(adminId, 'asset.resume', 'SystemFlag', dto.asset, null, dto);
    return { resumed: dto.asset };
  }


  // ── fee ladders ───────────────────────────────────────────
  //
  // Two of them, kept apart on purpose: RATE prices buying and selling for
  // naira, SWAP prices coin-to-coin. Same shape, same rules, separate ladders.

  /** One kind of ladder across every coin, plus the global default. */
  @Get('fee-ladders/:kind')
  @RequirePermissions('fees.view')
  feeLadder(@Param('kind') kind: string) {
    return this.bands.listCurrent(parseKind(kind));
  }

  /**
   * Replace one ladder. Writes a NEW schedule rather than editing bands, so a
   * past trade can still be explained with the rungs that were live then.
   */
  @Put('fee-ladders')
  @RequirePermissions('fees.manage')
  async setFeeLadder(@CurrentAdmin('sub') adminId: string, @Body() dto: SetFeeLadderDto) {
    const before = dto.asset ? await this.bands.currentSchedule(dto.kind, dto.asset) : null;
    const created = await this.bands.setSchedule({
      kind: dto.kind,
      assetCode: dto.asset ?? null,
      bands: dto.bands,
      setBy: adminId,
      note: dto.note,
      inherits: dto.inherits,
    });
    await this.admin.audit(
      adminId,
      `fee_ladder.${dto.kind.toLowerCase()}.${dto.inherits ? 'inherit' : 'set'}`,
      'FeeSchedule',
      created.id,
      before?.schedule ?? null,
      created,
    );
    return created;
  }

  /** What a trade of this size pays on BOTH ladders. Used by the editors. */
  @Get('fee-ladders-preview')
  @RequirePermissions('fees.view')
  previewLadders(@Query('asset') asset: string, @Query('usd') usd: string) {
    return this.bands.preview(asset, usd);
  }

  @Get('fee-ladders/:kind/history')
  @RequirePermissions('fees.view')
  feeLadderHistory(@Param('kind') kind: string, @Query('asset') asset?: string) {
    return this.bands.history(parseKind(kind), asset ?? null);
  }

  // ── users ─────────────────────────────────────────────────

  @Get('users/stats')
  @RequirePermissions('users.view')
  userStats() {
    return this.users.stats();
  }

  @Get('users')
  @RequirePermissions('users.view')
  listUsers(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.users.list({
      search,
      status: status as never,
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }

  /** Full detail including balances. Loaded when a row is expanded. */
  @Get('users/:id')
  @RequirePermissions('users.view')
  userDetail(@Param('id') id: string) {
    return this.users.detail(id);
  }

  /** Revokes every session immediately — see the service for why. */
  @Post('users/:id/suspend')
  @RequirePermissions('users.manage')
  async suspend(
    @CurrentAdmin('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: SuspendUserDto,
  ) {
    const result = await this.users.suspend(adminId, id, dto.reason);
    await this.admin.audit(adminId, 'user.suspend', 'User', id, null, { reason: dto.reason });
    return result;
  }

  @Post('users/:id/reinstate')
  @RequirePermissions('users.manage')
  async reinstate(@CurrentAdmin('sub') adminId: string, @Param('id') id: string) {
    const result = await this.users.reinstate(adminId, id);
    await this.admin.audit(adminId, 'user.reinstate', 'User', id, null, null);
    return result;
  }

  // ── broadcasts ────────────────────────────────────────────

  @Get('broadcasts')
  @RequirePermissions('notifications.send')
  broadcasts() {
    return this.users.broadcastHistory();
  }

  /** Omit userIds to reach every active user. */
  @Post('broadcasts')
  @RequirePermissions('notifications.send')
  async broadcast(@CurrentAdmin('sub') adminId: string, @Body() dto: BroadcastDto) {
    const result = await this.users.broadcast({
      adminId,
      title: dto.title,
      body: dto.body,
      userIds: dto.userIds,
    });
    await this.admin.audit(adminId, 'broadcast.send', 'Broadcast', result.id, null, result);
    return result;
  }

  // ── kyc review ────────────────────────────────────────────

  @Get('kyc/pending')
  @RequirePermissions('kyc.view')
  pendingKyc() {
    return this.prisma.kycProfile.findMany({
      where: { status: 'PENDING' },
      include: {
        documents: true,
        user: { select: { email: true, firstName: true, lastName: true } },
      },
      orderBy: { submittedAt: 'asc' },
      take: 100,
    });
  }

  @Post('kyc/:userId/review')
  @RequirePermissions('kyc.review')
  reviewKyc(
    @CurrentAdmin('sub') adminId: string,
    @Param('userId') userId: string,
    @Body() dto: ReviewKycDto,
  ) {
    return this.admin.reviewKyc(adminId, userId, {
      approve: dto.approve,
      tier: dto.tier as KycTier | undefined,
      reason: dto.reason,
    });
  }

  // ── your account ──────────────────────────────────────────

  /**
   * Everything the dashboard needs to render itself: who you are, what you may
   * do, and how long you have before the session idles out.
   */
  @Get('me')
  async me(@CurrentAdmin() actor: AdminJwtPayload) {
    const [profile, idleMs] = await Promise.all([
      this.admins.me(actor.sub),
      this.sessions.remainingMs(actor.jti),
    ]);
    return {
      ...profile,
      idleTimeoutMs: this.sessions.idleMs,
      idleRemainingMs: idleMs,
      /** So the UI can render the same list an owner sees when granting. */
      permissionCatalogue: PERMISSION_GROUPS,
    };
  }

  @Get('me/sessions')
  sessions_(@CurrentAdmin() actor: AdminJwtPayload) {
    return this.admins.sessionsFor(actor.sub, actor.jti);
  }

  /** Sign out everywhere but here, without changing the password. */
  @Post('me/sessions/end-others')
  @HttpCode(200)
  async endOtherSessions(@CurrentAdmin() actor: AdminJwtPayload) {
    const result = await this.admins.endOtherSessions(actor.sub, actor.jti);
    await this.admin.audit(actor.sub, 'admin.sessions.end_others', 'AdminUser', actor.sub, null, result);
    return result;
  }

  @Patch('me')
  async updateMe(@CurrentAdmin('sub') adminId: string, @Body() dto: UpdateProfileDto) {
    const before = await this.admins.me(adminId);
    const after = await this.admins.updateProfile(adminId, dto);
    await this.admin.audit(adminId, 'admin.profile.update', 'AdminUser', adminId, before, after);
    return after;
  }

  /**
   * Returns a replacement token. The caller must store it — every other
   * session, including this one's old token, stops working immediately.
   */
  @Post('me/password')
  @HttpCode(200)
  async changePassword(
    @CurrentAdmin('sub') adminId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    const result = await this.admins.changePassword(adminId, dto.currentPassword, dto.newPassword);
    // Never log the passwords themselves, only that it happened.
    await this.admin.audit(adminId, 'admin.password.change', 'AdminUser', adminId, null, null);
    return result;
  }

  @Put('me/avatar')
  setAvatar(@CurrentAdmin('sub') adminId: string, @Body() dto: SetAvatarDto) {
    return this.admins.setAvatar(adminId, dto.dataUrl);
  }

  @Delete('me/avatar')
  clearAvatar(@CurrentAdmin('sub') adminId: string) {
    return this.admins.clearAvatar(adminId);
  }

  @Get('me/activity')
  activity(@CurrentAdmin('sub') adminId: string, @Query('limit') limit?: string) {
    return this.admins.activity(adminId, limit ? Number(limit) : 20);
  }

  // ── the team ──────────────────────────────────────────────

  @Get('admins')
  @RequirePermissions('team.manage')
  team() {
    return this.admins.team();
  }

  @Post('admins')
  @RequirePermissions('team.manage')
  async createAdmin(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: CreateAdminDto) {
    const adminId = actor.sub;
    const created = await this.admins.createAdmin({ id: actor.sub, role: actor.role }, dto);
    await this.admin.audit(
      adminId,
      'admin.create',
      'AdminUser',
      created.admin.id,
      null,
      // No credential in the record — there is no longer one to leave out.
      // The account has no usable password until the invitation is accepted.
      { email: created.admin.email, name: created.admin.name, invited: created.invite.delivered },
    );
    return created;
  }

  /** Send the invitation again — for a link that expired before it was used. */
  @Post('admins/:id/invite')
  @RequirePermissions('team.manage')
  async resendInvite(@CurrentAdmin() actor: AdminJwtPayload, @Param('id') id: string) {
    const invite = await this.admins.sendInvite(id, actor.sub);
    await this.admin.audit(actor.sub, 'admin.invite.resend', 'AdminUser', id, null, {
      sentTo: invite.sentTo,
      delivered: invite.delivered,
    });
    return invite;
  }

  @Post('admins/:id/deactivate')
  @HttpCode(200)
  @RequirePermissions('team.manage')
  async deactivateAdmin(@CurrentAdmin() actor: AdminJwtPayload, @Param('id') id: string) {
    const result = await this.admins.setActive({ id: actor.sub, role: actor.role }, id, false);
    await this.admin.audit(actor.sub, 'admin.deactivate', 'AdminUser', id, null, result);
    return result;
  }

  @Post('admins/:id/reactivate')
  @HttpCode(200)
  @RequirePermissions('team.manage')
  async reactivateAdmin(@CurrentAdmin() actor: AdminJwtPayload, @Param('id') id: string) {
    const result = await this.admins.setActive({ id: actor.sub, role: actor.role }, id, true);
    await this.admin.audit(actor.sub, 'admin.reactivate', 'AdminUser', id, null, result);
    return result;
  }

  /** Owners only — enforced in the service, not just here. */
  @Put('admins/:id/permissions')
  @RequirePermissions('team.manage')
  async setPermissions(
    @CurrentAdmin() actor: AdminJwtPayload,
    @Param('id') id: string,
    @Body() dto: SetPermissionsDto,
  ) {
    const before = await this.admins.me(id);
    const after = await this.admins.setPermissions(
      { id: actor.sub, role: actor.role },
      id,
      dto.permissions,
    );
    await this.admin.audit(actor.sub, 'admin.permissions.set', 'AdminUser', id, before, after);
    return after;
  }

  @Put('admins/:id/role')
  @RequirePermissions('team.manage')
  async setRole(
    @CurrentAdmin() actor: AdminJwtPayload,
    @Param('id') id: string,
    @Body() dto: SetRoleDto,
  ) {
    const before = await this.admins.me(id);
    const after = await this.admins.setRole({ id: actor.sub, role: actor.role }, id, dto.role);
    await this.admin.audit(actor.sub, 'admin.role.set', 'AdminUser', id, before, after);
    return after;
  }

  // ── site settings ─────────────────────────────────────────
  //
  // One row, read by the public website and the apps. Everything here is
  // already printed on the landing page, which is why GET /v1/site serves the
  // same values to anyone; these routes are about who may CHANGE them.

  @Get('site-settings')
  @RequirePermissions('settings.manage')
  siteSettings() {
    return this.site.get();
  }

  @Put('site-settings')
  @RequirePermissions('settings.manage')
  async updateSiteSettings(
    @CurrentAdmin() actor: AdminJwtPayload,
    @Body() dto: SiteSettingsDto,
  ) {
    const before = await this.site.get();
    const after = await this.site.update(dto, actor.sub);
    await this.admin.audit(actor.sub, 'site.settings.update', 'SiteSetting', 'default', before, after);
    return after;
  }

  @Put('site-settings/logo')
  @RequirePermissions('settings.manage')
  async setSiteLogo(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: SiteLogoDto) {
    const result = await this.site.setLogo(dto.dataUrl, actor.sub);
    // The bytes are deliberately not in the record — only that it changed.
    await this.admin.audit(actor.sub, 'site.logo.set', 'SiteSetting', 'default', null, {
      version: result.logoVersion,
    });
    return result;
  }

  @Delete('site-settings/logo')
  @RequirePermissions('settings.manage')
  async clearSiteLogo(@CurrentAdmin() actor: AdminJwtPayload) {
    const result = await this.site.clearLogo(actor.sub);
    await this.admin.audit(actor.sub, 'site.logo.clear', 'SiteSetting', 'default', null, null);
    return result;
  }

  // ── KYC limits ────────────────────────────────────────────
  //
  // Naira only. A tier caps the leg that touches a bank, because that is what
  // verifying an identity is for; a coin moving between our own wallets moves
  // no real money.

  @Get('kyc-limits')
  @RequirePermissions('kyc.view')
  listKycLimits() {
    return this.kycLimits.all();
  }

  @Put('kyc-limits')
  @RequirePermissions('kyc.limits')
  async setKycLimits(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: KycLimitsDto) {
    const before = await this.kycLimits.all();
    const after = await this.kycLimits.setLimits(dto.tier, dto, actor.sub);
    // Raising a limit is a financial act, so it is recorded like one.
    await this.admin.audit(actor.sub, 'kyc.limits.set', 'KycTierLimit', dto.tier, before, after);
    return after;
  }

  // ── partner API keys ──────────────────────────────────────
  //
  // Never returns a secret. The screen sees the last four characters and when
  // it changed, which is enough to tell which key is loaded and useless to
  // anyone who photographs the screen.

  @Get('credentials')
  @RequirePermissions('credentials.manage')
  listCredentials() {
    return this.credentials.list();
  }

  @Put('credentials')
  @RequirePermissions('credentials.manage')
  async setCredential(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: SetCredentialDto) {
    if (actor.role !== AdminRole.OWNER) {
      // The permission alone is not enough for this one. A key that can move
      // the treasury is an owner's to rotate.
      throw new ForbiddenException('Only an owner can change a partner API key');
    }
    const result = await this.credentials.set(dto.name, dto.value, actor.sub);
    // The name and nothing else. An audit row is the last place a secret should
    // end up, and "who changed which key when" is the whole question anyway.
    await this.admin.audit(actor.sub, 'credential.set', 'IntegrationCredential', dto.name, null, null);
    return result;
  }

  @Delete('credentials/:name')
  @RequirePermissions('credentials.manage')
  async clearCredential(@CurrentAdmin() actor: AdminJwtPayload, @Param('name') name: string) {
    if (actor.role !== AdminRole.OWNER) {
      throw new ForbiddenException('Only an owner can change a partner API key');
    }
    const result = await this.credentials.clear(name, actor.sub);
    await this.admin.audit(actor.sub, 'credential.clear', 'IntegrationCredential', name, null, null);
    return result;
  }

  // ── the audit log ─────────────────────────────────────────

  /**
   * Every admin action, by whom, newest first.
   *
   * Read-only and append-only — there is deliberately no endpoint that edits or
   * deletes an entry, because a log somebody can tidy is not evidence.
   */
  @Get('audit')
  @RequirePermissions('audit.view')
  auditLog(
    @Query('admin') adminUserId?: string,
    @Query('action') action?: string,
    @Query('entity') entity?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.admins.auditLog({
      adminUserId,
      action,
      entity,
      since: since ? new Date(since) : undefined,
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }

  /**
   * The picture itself. Immutable for a year and keyed by a version the client
   * already holds, because the bytes for a given version can never change —
   * uploading a new one produces a new version.
   */
  @Get('admins/:id/avatar')
  async avatar(@Param('id') id: string, @Res() res: Response) {
    const { bytes, type, version } = await this.admins.avatarOf(id);
    res
      .type(type)
      .set('cache-control', 'private, max-age=31536000, immutable')
      .set('etag', `"${version}"`)
      .send(bytes);
  }

  // ── CMS: static pages ─────────────────────────────────────
  //
  // What the website and the apps display for About us, Terms, Privacy and
  // anything else added here. Saving publishes: there is no draft-and-approve
  // step, which is why the permission to edit is separate from the one to read.

  @Get('cms/pages')
  @RequirePermissions('content.view')
  cmsPages() {
    return this.cms.listPages();
  }

  @Post('cms/pages')
  @RequirePermissions('content.manage')
  async createCmsPage(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: CreatePageDto) {
    const page = await this.cms.createPage(actor.sub, dto);
    await this.admin.audit(actor.sub, 'cms.page.create', 'StaticPage', page.id, null, {
      slug: page.slug,
      title: page.title,
    });
    return page;
  }

  @Put('cms/pages/:id')
  @RequirePermissions('content.manage')
  async updateCmsPage(
    @CurrentAdmin() actor: AdminJwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdatePageDto,
  ) {
    const page = await this.cms.updatePage(actor.sub, id, dto);
    // The wording is not in the record — a policy is long, and the audit log is
    // for who changed what and when, not for a diff of a legal document.
    await this.admin.audit(actor.sub, 'cms.page.update', 'StaticPage', id, null, {
      slug: page.slug,
      title: page.title,
      isPublished: page.isPublished,
    });
    return page;
  }

  @Delete('cms/pages/:id')
  @RequirePermissions('content.manage')
  async deleteCmsPage(@CurrentAdmin() actor: AdminJwtPayload, @Param('id') id: string) {
    const result = await this.cms.deletePage(id);
    await this.admin.audit(actor.sub, 'cms.page.delete', 'StaticPage', id, null, null);
    return result;
  }

  // ── CMS: FAQs ─────────────────────────────────────────────
  //
  // Website only. The apps have their own help surface and do not read these.

  @Get('cms/faqs')
  @RequirePermissions('content.view')
  cmsFaqs() {
    return this.cms.listFaqs();
  }

  @Post('cms/faqs')
  @RequirePermissions('content.manage')
  async createCmsFaq(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: CreateFaqDto) {
    const faq = await this.cms.createFaq(actor.sub, dto);
    await this.admin.audit(actor.sub, 'cms.faq.create', 'Faq', faq.id, null, {
      question: faq.question,
    });
    return faq;
  }

  @Put('cms/faqs/:id')
  @RequirePermissions('content.manage')
  async updateCmsFaq(
    @CurrentAdmin() actor: AdminJwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateFaqDto,
  ) {
    const faq = await this.cms.updateFaq(actor.sub, id, dto);
    await this.admin.audit(actor.sub, 'cms.faq.update', 'Faq', id, null, {
      question: faq.question,
      isPublished: faq.isPublished,
    });
    return faq;
  }

  @Delete('cms/faqs/:id')
  @RequirePermissions('content.manage')
  async deleteCmsFaq(@CurrentAdmin() actor: AdminJwtPayload, @Param('id') id: string) {
    const result = await this.cms.deleteFaq(id);
    await this.admin.audit(actor.sub, 'cms.faq.delete', 'Faq', id, null, null);
    return result;
  }

  @Put('cms/faqs-order')
  @RequirePermissions('content.manage')
  reorderCmsFaqs(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: ReorderDto) {
    // Deliberately not audited: dragging a question up the list is arrangement,
    // not a change to what anybody is told, and logging it would bury the edits
    // that matter under a pile of reorders.
    return this.cms.reorderFaqs(actor.sub, dto.ids);
  }

  // ── CMS: email templates ──────────────────────────────────
  //
  // The catalogue of keys lives in code, because a template exists only if
  // something sends it. This is the wording, and the switch.

  @Get('cms/email-templates')
  @RequirePermissions('content.view')
  emailTemplates() {
    return this.templates.list();
  }

  @Put('cms/email-templates/:key')
  @RequirePermissions('content.emails')
  async setEmailTemplate(
    @CurrentAdmin() actor: AdminJwtPayload,
    @Param('key') key: string,
    @Body() dto: UpdateEmailTemplateDto,
  ) {
    if (!isEmailTemplateKey(key)) {
      throw new BadRequestException(`There is no email template called "${key}"`);
    }

    const saved = await this.templates.save(key, actor.sub, dto);

    // Switching an email off stops every user receiving it, which is the kind
    // of change somebody will later want to find. The body is not recorded.
    await this.admin.audit(actor.sub, 'cms.email.update', 'EmailTemplate', key, null, {
      subject: saved.subject,
      isActive: saved.isActive,
    });
    return saved;
  }

  /** Back to the wording this install shipped with. */
  @Delete('cms/email-templates/:key')
  @RequirePermissions('content.emails')
  async resetEmailTemplate(@CurrentAdmin() actor: AdminJwtPayload, @Param('key') key: string) {
    if (!isEmailTemplateKey(key)) {
      throw new BadRequestException(`There is no email template called "${key}"`);
    }
    // Restores the wording and keeps the picture. Deleting the row would take
    // the banner with it, and "reset the wording" is not what anybody means by
    // "delete my image".
    const restored = await this.templates.reset(key);
    await this.admin.audit(actor.sub, 'cms.email.reset', 'EmailTemplate', key, null, null);
    return restored;
  }

  /**
   * Render one with sample values, and optionally send a real copy.
   *
   * Previewing the editor's contents rather than what is saved is the point:
   * seeing the finished email before committing to it is the only way to catch
   * a mangled placeholder before every user receives it.
   */
  @Post('cms/email-templates/:key/preview')
  @RequirePermissions('content.emails')
  async previewEmailTemplate(
    @CurrentAdmin() actor: AdminJwtPayload,
    @Param('key') key: string,
    @Body() dto: PreviewEmailDto,
  ) {
    if (!isEmailTemplateKey(key)) {
      throw new BadRequestException(`There is no email template called "${key}"`);
    }
    return this.templates.preview(key, actor.sub, dto);
  }

  /**
   * The picture that rides under the header on one email.
   *
   * Per template, not global: a welcome email and a failed-withdrawal email
   * want very different pictures, and one banner for both would be wrong for at
   * least one of them.
   */
  @Put('cms/email-templates/:key/image')
  @RequirePermissions('content.emails')
  async setEmailImage(
    @CurrentAdmin() actor: AdminJwtPayload,
    @Param('key') key: string,
    @Body() dto: EmailImageDto,
  ) {
    if (!isEmailTemplateKey(key)) {
      throw new BadRequestException(`There is no email template called "${key}"`);
    }
    const result = await this.templates.setImage(key, dto.dataUrl, dto.alt, actor.sub);
    // The bytes are deliberately not in the record — only that it changed.
    await this.admin.audit(actor.sub, 'cms.email.image.set', 'EmailTemplate', key, null, {
      alt: result.imageAlt,
    });
    return result;
  }

  @Delete('cms/email-templates/:key/image')
  @RequirePermissions('content.emails')
  async clearEmailImage(@CurrentAdmin() actor: AdminJwtPayload, @Param('key') key: string) {
    if (!isEmailTemplateKey(key)) {
      throw new BadRequestException(`There is no email template called "${key}"`);
    }
    const result = await this.templates.clearImage(key, actor.sub);
    await this.admin.audit(actor.sub, 'cms.email.image.clear', 'EmailTemplate', key, null, null);
    return result;
  }

  // ── CMS: social links ─────────────────────────────────────
  //
  // Shown in every email footer and on the website. A row per network, so
  // adding one is a form rather than a migration.

  @Get('cms/socials')
  @RequirePermissions('content.view')
  socialLinks() {
    return this.socials.list();
  }

  /** The catalogue of networks worth offering by name, for the picker. */
  @Get('cms/socials/known')
  @RequirePermissions('content.view')
  knownNetworks() {
    return { networks: KNOWN_NETWORKS, iconPixels: ICON_PIXELS };
  }

  @Post('cms/socials')
  @RequirePermissions('content.manage')
  async createSocial(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: SocialLinkDto) {
    const link = await this.socials.create(actor.sub, {
      label: dto.label!,
      url: dto.url!,
      isEnabled: dto.isEnabled,
    });
    await this.admin.audit(actor.sub, 'cms.social.create', 'SocialLink', link.id, null, {
      label: link.label,
      url: link.url,
    });
    return link;
  }

  @Put('cms/socials/:id')
  @RequirePermissions('content.manage')
  async updateSocial(
    @CurrentAdmin() actor: AdminJwtPayload,
    @Param('id') id: string,
    @Body() dto: SocialLinkDto,
  ) {
    const link = await this.socials.update(actor.sub, id, dto);
    // Where a link points is echoed to every recipient of every email, so a
    // change to one is worth being able to trace.
    await this.admin.audit(actor.sub, 'cms.social.update', 'SocialLink', id, null, {
      label: link.label,
      url: link.url,
      isEnabled: link.isEnabled,
    });
    return link;
  }

  @Delete('cms/socials/:id')
  @RequirePermissions('content.manage')
  async deleteSocial(@CurrentAdmin() actor: AdminJwtPayload, @Param('id') id: string) {
    const result = await this.socials.remove(id);
    await this.admin.audit(actor.sub, 'cms.social.delete', 'SocialLink', id, null, null);
    return result;
  }

  /** The whole arrangement in one call — same reasoning as the FAQ order. */
  @Put('cms/socials-order')
  @RequirePermissions('content.manage')
  reorderSocials(@CurrentAdmin() actor: AdminJwtPayload, @Body() dto: ReorderDto) {
    return this.socials.reorder(actor.sub, dto.ids);
  }

  @Put('cms/socials/:id/icon')
  @RequirePermissions('content.manage')
  async setSocialIcon(
    @CurrentAdmin() actor: AdminJwtPayload,
    @Param('id') id: string,
    @Body() dto: SocialIconDto,
  ) {
    const result = await this.socials.setIcon(id, dto.dataUrl, actor.sub);
    // The bytes are deliberately not in the record — only that it changed.
    await this.admin.audit(actor.sub, 'cms.social.icon.set', 'SocialLink', id, null, null);
    return result;
  }

  @Delete('cms/socials/:id/icon')
  @RequirePermissions('content.manage')
  async clearSocialIcon(@CurrentAdmin() actor: AdminJwtPayload, @Param('id') id: string) {
    const result = await this.socials.clearIcon(id, actor.sub);
    await this.admin.audit(actor.sub, 'cms.social.icon.clear', 'SocialLink', id, null, null);
    return result;
  }
}

@Public()
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly admin: AdminService,
    private readonly admins: AdminsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    return this.admin.login(dto.email, dto.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  /**
   * Start a password reset.
   *
   * Unauthenticated by necessity — the people who need it are the ones who
   * cannot sign in. The response is identical whether or not the email matched
   * an account, because a different answer is a way to enumerate admins.
   */
  @Post('reset/request')
  @HttpCode(200)
  async requestReset(@Body() dto: RequestResetDto) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
      select: { id: true },
    });

    if (admin) {
      // Swallowed on purpose: a rate-limit or SMTP error must not become the
      // signal that distinguishes a real account from a made-up one.
      await this.admins.requestPasswordReset(admin.id).catch(() => undefined);
    }

    return {
      message: 'If that email belongs to an admin, a six-digit code is on its way to it.',
    };
  }

  /** Finish it. Returns a token, so a reset lands them signed in. */
  @Post('reset/confirm')
  @HttpCode(200)
  async confirmReset(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
      select: { id: true },
    });
    if (!admin) {
      // Same message the wrong-code path gives, for the same reason.
      throw new BadRequestException('That code is not right.');
    }

    const result = await this.admins.resetPasswordWithOtp(admin.id, dto.code, dto.newPassword);
    await this.admin.audit(admin.id, 'admin.password.reset', 'AdminUser', admin.id, null, {
      ip: req.ip ?? null,
    });
    return result;
  }

  // ── invitations ───────────────────────────────────────────
  //
  // A new admin has no password to sign in with — one was never generated for
  // them — so these two routes are how they get in. Unauthenticated for the
  // same reason the reset routes are.

  /**
   * Is this link still good?
   *
   * Called before the form is shown, so somebody is not asked to choose a
   * password and only then told the link expired. Never says *why* an invalid
   * token failed: "expired" and "never existed" are the same answer, because
   * telling the two apart confirms a guessed token was real.
   */
  @Get('invite')
  checkInvite(@Query('token') token: string) {
    return this.admins.checkInvite(token ?? '');
  }

  /** Set the password they chose and burn the link. */
  @Post('invite/accept')
  @HttpCode(200)
  async acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    const result = await this.admins.acceptInvite(dto.token, dto.password);
    const admin = await this.prisma.adminUser.findUnique({
      where: { email: result.email },
      select: { id: true },
    });
    if (admin) {
      await this.admin.audit(admin.id, 'admin.invite.accept', 'AdminUser', admin.id, null, {
        ip: req.ip ?? null,
      });
    }
    return result;
  }
}
