import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Password policy: length does more work than character classes. 10 chars
 * minimum, capped at 128 so a huge input cannot be used to burn scrypt memory.
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

export class RegisterDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @Password()
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lastName!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'Enter a valid phone number' })
  phone?: string;

  /**
   * Somebody's referral code, if they arrived through one.
   *
   * Accepted only here. A referrer can be attached at the moment an account is
   * created and never afterwards — an endpoint that could add one later is the
   * whole attack, so there is not one.
   *
   * A code that matches nobody is IGNORED rather than refused: a typo must not
   * stop somebody signing up.
   */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  referralCode?: string;
}

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @IsString()
  @MaxLength(512)
  refreshToken!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(128)
  currentPassword!: string;

  @IsString()
  @Password()
  newPassword!: string;
}

export class RequestPasswordResetDto {
  /**
   * Whose account. Unauthenticated, because the whole point is that they
   * cannot sign in — so the response never says whether it matched.
   */
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(/^[0-9]{6}$/, { message: 'The code is six digits' })
  code!: string;

  @IsString()
  @Password()
  newPassword!: string;
}
