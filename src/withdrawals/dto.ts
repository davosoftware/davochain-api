import {
  IsEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * POST /v1/withdrawals/crypto (Part 2, C6): only to a saved address. The old
 * typed fields are refused by name so an old app build gets a clear message.
 */
export class WithdrawCryptoDto {
  @IsNumberString()
  amount!: string;

  @IsString()
  @MaxLength(64)
  savedCryptoAddressId!: string;

  @IsEmpty({ message: 'Choose a saved address' }) asset?: never;
  @IsEmpty({ message: 'Choose a saved address' }) network?: never;
  @IsEmpty({ message: 'Choose a saved address' }) address?: never;
  @IsEmpty({ message: 'Choose a saved address' }) destinationTag?: never;
}

export class VerifyNgnBankAccountDto {
  @IsString()
  @Matches(/^\d{10}$/, { message: 'Enter a valid 10-digit Nigerian bank account number' })
  accountNumber!: string;

  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,20}$/, { message: 'Choose a valid bank from the list' })
  bankCode!: string;
}

/** POST /v1/withdrawals/ngn (Part 2, C6): only to a saved bank account. */
export class WithdrawNgnDto {
  @IsNumberString({}, { message: 'Enter a valid naira amount' })
  amount!: string;

  @IsString()
  @MaxLength(64)
  savedBankAccountId!: string;

  @IsEmpty({ message: 'Choose a saved bank account' }) accountNumber?: never;
  @IsEmpty({ message: 'Choose a saved bank account' }) bankCode?: never;
}

/** POST /v1/me/bank-accounts (Part 2). The account name is looked up, never sent. */
export class AddBankAccountDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9]{1,20}$/, { message: 'Choose a valid bank from the list' })
  bankCode!: string;

  @IsString()
  @Matches(/^\d{10}$/, { message: 'Enter a valid 10-digit Nigerian bank account number' })
  accountNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  nickname?: string;

  /** Your password again: a stolen session alone cannot add an account. Never stored or logged. */
  @IsString()
  @MaxLength(128)
  password!: string;
}

/** POST /v1/me/crypto-addresses (Part 2). */
export class AddCryptoAddressDto {
  @IsString()
  @Matches(/^[a-z0-9]{2,20}$/i)
  asset!: string;

  @IsString()
  @MaxLength(40)
  network!: string;

  @IsString()
  @MaxLength(200)
  address!: string;

  /** Required on XRP, XLM and TON. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  destinationTag?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  nickname?: string;

  @IsString()
  @MaxLength(128)
  password!: string;
}
