import { IsIn, IsNumberString, IsString, Matches, MaxLength } from 'class-validator';

const CODE = /^[a-z0-9]{2,20}$/i;

export class QuoteDto {
  @IsIn(['buy', 'sell', 'swap'])
  side!: 'buy' | 'sell' | 'swap';

  @IsString()
  @Matches(CODE)
  @MaxLength(20)
  fromAsset!: string;

  @IsString()
  @Matches(CODE)
  @MaxLength(20)
  toAsset!: string;

  /** String, always. A float here is a rounding bug waiting to be shipped. */
  @IsNumberString()
  amount!: string;
}

export class ExecuteTradeDto {
  @IsString()
  @MaxLength(64)
  quoteId!: string;
}
