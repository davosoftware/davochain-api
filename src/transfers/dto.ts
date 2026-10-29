import { IsNumberString, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The real rules live in checkPayUsername, which gives a reason a person can
 * act on; these only keep the body sane.
 */
export class SetPayUsernameDto {
  @IsString()
  @MaxLength(64)
  username!: string;
}

/** POST /v1/transfers/crypto */
export class SendByUsernameDto {
  @IsString()
  @MaxLength(64)
  username!: string;

  @IsString()
  @MaxLength(20)
  asset!: string;

  @IsNumberString({}, { message: 'Enter an amount greater than zero' })
  amount!: string;

  /**
   * No longer used (29 Oct 2026): the transaction PIN replaced it. Still
   * accepted, and ignored, so an older app that sends it is not refused.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;
}
