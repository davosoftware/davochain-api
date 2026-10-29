import { IsString, MaxLength } from 'class-validator';

/** POST /v1/me/transaction-pin */
export class CreatePinDto {
  @IsString() @MaxLength(200) password!: string;
  @IsString() @MaxLength(10) pin!: string;
}

/** PUT /v1/me/transaction-pin */
export class ChangePinDto {
  @IsString() @MaxLength(10) currentPin!: string;
  @IsString() @MaxLength(10) newPin!: string;
}

/** POST /v1/me/transaction-pin/reset/request */
export class RequestPinResetDto {
  @IsString() @MaxLength(200) password!: string;
}

/** POST /v1/me/transaction-pin/reset */
export class ResetPinDto {
  @IsString() @MaxLength(10) code!: string;
  @IsString() @MaxLength(10) newPin!: string;
}
