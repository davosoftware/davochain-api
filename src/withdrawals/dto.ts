import {
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class WithdrawCryptoDto {
  @IsString()
  @Matches(/^[a-z0-9]{2,20}$/i)
  asset!: string;

  @IsString()
  @MaxLength(40)
  network!: string;

  @IsNumberString()
  amount!: string;

  @IsString()
  @MaxLength(200)
  address!: string;

  /** Required on XRP, XLM and TON — without it the deposit is lost to the omnibus. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  destinationTag?: string;
}

export class VerifyNgnBankAccountDto {
  @IsString()
  @Matches(/^\d{10}$/, { message: 'Enter a valid 10-digit Nigerian bank account number' })
  accountNumber!: string;

  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,20}$/, { message: 'Choose a valid bank from the list' })
  bankCode!: string;
}

export class WithdrawNgnDto extends VerifyNgnBankAccountDto {
  @IsNumberString({}, { message: 'Enter a valid naira amount' })
  amount!: string;
}
