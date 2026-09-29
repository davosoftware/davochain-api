import { Type } from 'class-transformer';
import { AdminRole, FeeKind, KycTier } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  ValidateNested,
  IsBoolean,
  IsEmail,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
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
  @IsOptional() @IsString() tier?: string;
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

export class SuspendUserDto {
  @IsString() @MaxLength(500) reason!: string;
}

/** Why a held naira deposit was refused. The user is shown this text. */
export class RejectDepositDto {
  @IsString() @MaxLength(500) reason!: string;
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
  @IsString() @MaxLength(1_000_000) dataUrl!: string;
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
  @IsString() @MaxLength(1_500_000) dataUrl!: string;
}

export class KycLimitsDto {
  @IsEnum(KycTier) tier!: KycTier;
  @IsNumberString() ngnDepositSingle!: string;
  @IsNumberString() ngnDepositDaily!: string;
  @IsNumberString() ngnWithdrawSingle!: string;
  @IsNumberString() ngnWithdrawDaily!: string;
}

export class SetCredentialDto {
  @IsString() @MaxLength(120) name!: string;
  /** Write-only. Nothing ever hands this back. */
  @IsString() @MaxLength(8000) value!: string;
}
