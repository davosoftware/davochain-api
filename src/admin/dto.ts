import { Type } from 'class-transformer';
import { AdminRole, AlertType, FeeKind, KycTier, LimitCurrency, PolicyAction, PolicyLevel } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  ValidateNested,
  IsBoolean,
  IsEmail,
  IsInt,
  IsNumber,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class AdminLoginDto {
  @IsEmail() email!: string;
  @IsString() @MaxLength(128) password!: string;
}

export class SetGateDto {
  @IsOptional() @IsNumberString() gateNgnPerUsd?: string;
  @IsOptional() @IsNumberString() swapFeeUsd?: string;
  @IsOptional() @IsNumberString() floorUsd?: string;
  @IsOptional() @IsNumberString() maxTradeUsd?: string;
  @IsOptional() @IsNumberString() withdrawalFee?: string;
  @IsOptional() @IsInt() quoteTtlSeconds?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class RecordRefillDto {
  @IsString() asset!: string;
  @IsNumberString() quantity!: string;
  @IsNumberString() pricePaidUsd!: string;
  @IsOptional() @IsString() occurredAt?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ClaimFeesDto {
  @IsString({ each: true }) assets!: string[];
}

export class ReviewKycDto {
  @IsBoolean() approve!: boolean;
  // L1: a free string reached the database as a tier and came back a 500.
  @IsOptional() @IsEnum(KycTier, { message: 'tier must be TIER_0, TIER_1, TIER_2 or TIER_3' }) tier?: KycTier;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class PauseDto {
  @IsString() asset!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class InventoryTargetDto {
  @IsString() asset!: string;
  @IsOptional() @IsNumberString() target?: string;
  @IsOptional() @IsNumberString() floorPct?: string;
  @IsOptional() @IsNumberString() dipAlertPct?: string;
  @IsOptional() @IsBoolean() fallbackSwapEnabled?: boolean;
}

/** An admin removing a customer's saved withdrawal destination (Part 2). The customer is emailed this reason. */
export class RemoveDestinationDto {
  @IsString() @MinLength(10, { message: 'Give a reason of at least 10 characters' }) @MaxLength(500) reason!: string;
}

/** An owner's balance correction from the reconciliation screen. The service checks every rule and says why in plain words. */
export class BalanceCorrectionDto {
  @IsString() @MaxLength(64) userId!: string;
  @IsString() @MaxLength(20) asset!: string;
  @IsIn(['CREDIT', 'DEBIT']) direction!: 'CREDIT' | 'DEBIT';
  @IsString() @MaxLength(40) amount!: string;
  @IsString() @MaxLength(500) reason!: string;
}

/** PUT /v1/admin/dojah/settings. null = back to the server default; the service checks every rule. */
export class DojahSettingsDto {
  @IsOptional() @IsNumber({}, { message: 'Enter a whole naira amount, 0 or more.' }) minBalance?: number | null;
  @IsOptional() @IsNumber({}, { message: 'Enter a whole naira amount, 0 or more.' }) lowBalanceWarn?: number | null;
  @IsOptional() @IsNumber({}, { message: "Tries must be whole numbers from 1 to 20, and the daily number can't be more than the total." }) dailyAttempts?: number | null;
  @IsOptional() @IsNumber({}, { message: "Tries must be whole numbers from 1 to 20, and the daily number can't be more than the total." }) totalAttempts?: number | null;
}

/** POST /v1/admin/dojah/basic-switch. enabled null = back to the server default. */
export class DojahBasicSwitchDto {
  @IsOptional() @IsBoolean() enabled!: boolean | null;
  /** Checked, never stored or audited. */
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

/** PUT /v1/admin/dojah/advanced-settings. null = back to the default. The service checks ranges and says why. */
export class DojahAdvancedSettingsDto {
  @IsOptional() @IsNumber() advancedDailyAttempts?: number | null;
  @IsOptional() @IsNumber() advancedTotalAttempts?: number | null;
  @IsOptional() @IsNumber() livenessMin?: number | null;
  @IsOptional() @IsNumber() faceMatchPass?: number | null;
  @IsOptional() @IsNumber() faceMatchReview?: number | null;
  @IsOptional() @IsNumber() addressRecencyMonths?: number | null;
  /** Checked, never stored or audited. */
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

/** POST /v1/admin/dojah/thresholds: Dojah's prices in naira. */
export class DojahThresholdsDto {
  @IsNumber({}, { message: 'Enter the price per check and per screening in naira.' }) lookupPrice!: number;
  @IsNumber({}, { message: 'Enter the price per check and per screening in naira.' }) amlPrice!: number;
  @IsOptional() @IsNumber() leadDays?: number;
  /** Naira per Advanced Dojah call. */
  @IsOptional() @IsNumber() advancedPrice?: number;
}

/** PUT /v1/admin/treasury/settings. The service checks every rule and says why in plain words. */
export class TreasurySettingsDto {
  @IsOptional() @IsNumber({}, { message: 'Enter a whole naira amount, 0 or more.' }) payoutReserveNgn?: number;
  @IsOptional() @IsString() @MaxLength(20) fundingBankCode?: string;
  @IsOptional() @IsString() @MaxLength(20) fundingAccountNumber?: string;
  /** Checked, never stored or audited. */
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

/** POST /v1/admin/treasury/moves: send naira from the rail to Quidax. */
/** Just the password (Treasury "mark as failed"). Checked, never stored or audited. */
export class TreasuryPasswordDto {
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

export class TreasuryMoveDto {
  @IsNumber({}, { message: 'Enter a whole naira amount above zero.' }) amount!: number;
  /** Checked, never stored or audited. */
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

/** POST /v1/admin/treasury/check-name */
export class TreasuryCheckNameDto {
  @IsString() @MaxLength(20) bankCode!: string;
  @IsString() @Matches(/^\d{10}$/, { message: 'Enter a valid 10-digit Nigerian bank account number' }) accountNumber!: string;
}

export class SuspendUserDto {
  @IsString() @MaxLength(500) reason!: string;
}

/** Why a held naira deposit was refused. The user is shown this text. */
export class RejectDepositDto {
  @IsString() @MaxLength(500) reason!: string;
}

/** A held Payrep deposit sent back from the Payrep dashboard: how, for the team (final review, Important 1). */
export class MarkReturnedDto {
  @IsString() @MaxLength(500) note!: string;
}

/** H4: an owner's decision on a transaction that is being checked. */
export class ResolveTransactionDto {
  @IsIn(['COMPLETED', 'FAILED'], { message: 'Choose COMPLETED or FAILED' }) outcome!: 'COMPLETED' | 'FAILED';
  @IsString() @MaxLength(1000) note!: string;
}

/**
 * The referral offer.
 *
 * Every field optional: this is a settings screen where somebody changes one
 * number, and a partial update is what that actually is. Amounts arrive as
 * strings for the same reason every other amount does — a naira figure that
 * has been through a float is not the figure that was typed.
 */
export class ReferralSettingsDto {
  @IsOptional() @IsBoolean() isEnabled?: boolean;

  @IsOptional() @IsNumberString({}, { message: 'Enter an amount' }) referrerRewardNgn?: string;
  @IsOptional() @IsNumberString({}, { message: 'Enter an amount' }) refereeRewardNgn?: string;

  @IsOptional() @IsEnum(KycTier) unlockTier?: KycTier;

  @IsOptional()
  @IsNumberString({}, { message: 'Enter an amount' })
  refereeTradeVolumeNgn?: string;

  @IsOptional() @IsInt() @Min(0) @Max(100_000) maxPaidReferralsPerUser?: number;
  @IsOptional() @IsNumberString({}, { message: 'Enter an amount' }) maxEarningsPerUserNgn?: string;

  @IsOptional() @IsString() @MaxLength(120) headline?: string;
  @IsOptional() @IsString() @MaxLength(2000) terms?: string;
}

export class BroadcastDto {
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(2000) body!: string;

  /** Omit or leave empty to reach every active user. */
  @IsOptional() @IsArray() @IsString({ each: true }) userIds?: string[];
}

/**
 * The same policy as a user's password: length does more work than character
 * classes, capped so a huge input cannot be used to burn scrypt memory.
 */
const PASSWORD_RULES = [
  MinLength(10, { message: 'Password must be at least 10 characters' }),
  MaxLength(128),
  Matches(/[a-zA-Z]/, { message: 'Password must contain a letter' }),
  Matches(/[0-9]/, { message: 'Password must contain a number' }),
];

function Password() {
  return function (target: object, key: string) {
    for (const rule of PASSWORD_RULES) rule(target, key);
  };
}

export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsEmail({}, { message: 'Enter a valid email address' }) @MaxLength(254) email?: string;

  /** Required only when the email is changing. */
  @IsOptional() @IsString() currentPassword?: string;
}

export class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString() @Password() newPassword!: string;
}

export class SetAvatarDto {
  /**
   * A data URL, because the browser downscales the picture on a canvas before
   * it is sent — which keeps a 40 MB phone photo off the wire entirely and
   * saves the API a resizing dependency.
   */
  @IsString() @MaxLength(3_000_000) dataUrl!: string;
}

export class CreateAdminDto {
  @IsEmail({}, { message: 'Enter a valid email address' }) @MaxLength(254) email!: string;
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsEnum(AdminRole) role?: AdminRole;
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
}

export class SetPermissionsDto {
  @IsArray() @IsString({ each: true }) permissions!: string[];
}

export class SetRoleDto {
  @IsEnum(AdminRole) role!: AdminRole;
}

export class RequestResetDto {
  /**
   * Whose account. Unauthenticated, because the whole point is that they
   * cannot sign in — so the response never says whether it matched.
   */
  @IsEmail({}, { message: 'Enter a valid email address' }) @MaxLength(254) email!: string;
}

export class ResetPasswordDto {
  @IsEmail({}, { message: 'Enter a valid email address' }) @MaxLength(254) email!: string;
  @IsString() @Matches(/^[0-9]{6}$/, { message: 'The code is six digits' }) code!: string;
  @IsString() @Password() newPassword!: string;
}

export class AcceptInviteDto {
  /** From the emailed link. Compared against a stored hash, never logged. */
  @IsString() @MaxLength(200) token!: string;
  @IsString() @Password() password!: string;
}

export class FeeLadderBandDto {
  @IsNumberString() minAmount!: string;

  /** null or omitted on the top band — everything above minAmount. */
  @IsOptional() @IsNumberString() maxAmount?: string | null;

  /** The fee itself, in whatever currency this ladder charges. */
  @IsNumberString() value!: string;
}

/** One ladder, one kind. The two fees are never set in the same call. */
export class SetFeeLadderDto {
  @IsEnum(FeeKind) kind!: FeeKind;
  /** Omit for the global default that every coin without its own falls back to. */
  @IsOptional() @IsString() asset?: string;
  /** Empty when inheriting — the marker carries no rungs of its own. */
  @IsArray() @ValidateNested({ each: true }) @Type(() => FeeLadderBandDto) bands!: FeeLadderBandDto[];

  /** Put this coin back on the global default. Requires an asset. */
  @IsOptional() @IsBoolean() inherits?: boolean;

  @IsOptional() @IsString() @MaxLength(500) note?: string;
}


export class SiteSettingsDto {
  @IsOptional() @IsString() @MaxLength(120) companyName?: string;
  @IsOptional() @IsEmail({}, { message: 'Support email is not an email address' }) @MaxLength(254) supportEmail?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;

  @IsOptional() @IsString() @MaxLength(20) iosVersion?: string | null;
  @IsOptional() @IsString() @MaxLength(20) androidVersion?: string | null;
  @IsOptional() @IsString() @MaxLength(500) iosStoreUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(500) androidStoreUrl?: string | null;

  @IsOptional() @IsBoolean() maintenanceMode?: boolean;
  @IsOptional() @IsString() @MaxLength(500) maintenanceMessage?: string | null;

  // Social links moved to their own table — see SocialLinkDto in cms/dto.ts.

  // The footer on every email. Blank means "use the shipped default", so an
  // empty field never produces an empty line.
  @IsOptional() @IsString() @MaxLength(160) emailLegalName?: string | null;
  @IsOptional() @IsString() @MaxLength(300) emailAddressLine?: string | null;
  @IsOptional() @IsString() @MaxLength(300) emailOptInNote?: string | null;
  @IsOptional() @IsString() @MaxLength(300) emailUnsubscribeNote?: string | null;
  @IsOptional() @IsString() @MaxLength(500) emailUnsubscribeUrl?: string | null;
}

export class SiteLogoDto {
  /** A data URL. Same reasoning as the admin avatar — see SetAvatarDto. */
  @IsString() @MaxLength(3_000_000) dataUrl!: string;
}

class LevelRuleDto {
  @IsEnum(PolicyLevel) level!: PolicyLevel;
  @IsEnum(PolicyAction) action!: PolicyAction;
  @IsBoolean() allowed!: boolean;
  @IsEnum(LimitCurrency) currency!: LimitCurrency;
  /** Blank or null = no limit. The service checks each is a plain number. */
  @IsOptional() @IsString() @MaxLength(30) minPerTx!: string | null;
  @IsOptional() @IsString() @MaxLength(30) maxPerTx!: string | null;
  @IsOptional() @IsString() @MaxLength(30) maxPerDay!: string | null;
}

class LevelCooloffDto {
  @IsEnum(PolicyLevel) level!: PolicyLevel;
  @IsInt() afterSignupHours!: number;
  @IsInt() afterCredentialChangeHours!: number;
  @IsInt() afterNewPayeeHours!: number;
}

class PlatformLimitDto {
  @IsOptional() @IsString() @MaxLength(30) tradingMaxPerDay!: string | null;
  @IsEnum(LimitCurrency) currency!: LimitCurrency;
  /** How many withdrawal destinations a customer may keep (Part 2). The service checks 1 to 50. */
  @IsOptional() @IsInt() maxSavedBankAccounts?: number;
  @IsOptional() @IsInt() maxSavedCryptoAddresses?: number;
}

/** PUT /v1/admin/levels: the whole table at once, so one save is one audit entry. */
export class SaveLevelsDto {
  @IsArray() @ArrayMaxSize(64) @ValidateNested({ each: true }) @Type(() => LevelRuleDto) rules!: LevelRuleDto[];
  @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => LevelCooloffDto) cooloffs!: LevelCooloffDto[];
  @ValidateNested() @Type(() => PlatformLimitDto) platform!: PlatformLimitDto;
}

export class SetCredentialDto {
  @IsString() @MaxLength(120) name!: string;
  /** Write-only. Nothing ever hands this back. */
  @IsString() @MaxLength(8000) value!: string;
}

/** Every change to the naira-withdrawal switch costs the admin's password. */
export class SetNgnWithdrawalsDto {
  @IsBoolean() enabled!: boolean;
  /** Checked, never stored or audited. */
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** Set once the admin has seen the "withdrawals in progress" warning. */
  @IsOptional() @IsBoolean() confirmInFlight?: boolean;
}

export class ResetNgnWithdrawalsDto {
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsBoolean() confirmInFlight?: boolean;
}

/** Why an admin switched a naira deposit account off or on. Audited. */
export class VirtualAccountStatusDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

/** Development only: a pretend bank transfer into a user's virtual account (the mock). */
export class SimulatePayInDto {
  @IsUUID() userId!: string;
  @Matches(/^\d{1,9}(\.\d{1,2})?$/, { message: 'amount is naira as text, e.g. "1500" or "1500.50"' })
  amount!: string;
  @IsOptional() @IsString() @MaxLength(100) payerName?: string;
  @IsOptional() @IsIn(['success', 'pending', 'failed']) status?: 'success' | 'pending' | 'failed';
}

export class AddAlertRecipientDto {
  @IsEnum(AlertType)
  type!: AlertType;

  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  email!: string;
}

export class SetAlertRecipientEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}

// ── M7: two-step sign-in ─────────────────────────────────────

/** The ticket from a sign-in that passed its password. */
export class TwoStepTicketDto {
  @IsString() @MinLength(20) @MaxLength(100) ticket!: string;
}

/** The ticket and the 6-digit code (emailed, or a backup code). */
export class TwoStepCodeDto extends TwoStepTicketDto {
  @IsString() @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' }) code!: string;
}

/** Checked, never stored or audited. */
export class TwoStepPasswordDto {
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

export class TwoStepEnableDto {
  @IsString() @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' }) code!: string;
}

export class TwoStepDisableDto extends TwoStepPasswordDto {
  @IsString() @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code or a backup code' }) code!: string;
}

export class TwoStepRequiredDto extends TwoStepPasswordDto {
  @IsBoolean() required!: boolean;
}
