import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Offering a card. At least one of `code` or `images` is required — checked
 *  in the service, because "one of these two" is not a field-level rule. */
export class SubmitGiftCardDto {
  @IsUUID() typeId!: string;

  /** The card's face value, in the type's own currency. */
  @IsNumberString({}, { message: 'Enter the value of the card' }) faceValue!: string;

  /** Sealed before it is stored. Never returned to the user afterwards. */
  @IsOptional() @IsString() @MaxLength(200) code?: string;

  /**
   * Data URLs. The browser or app downscales before sending, which keeps a
   * 40 MB phone photo off the wire and saves the API a resizing dependency.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  images?: string[];
}

export class GiftCardCategoryDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class GiftCardBrandDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsUUID() categoryId!: string;
  /** A data URL. Omit to leave an existing logo alone. */
  @IsOptional() @IsString() @MaxLength(8_000_000) image?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class GiftCardTypeDto {
  @IsOptional() @IsUUID() id?: string;
  @IsUUID() brandId!: string;
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  /** Three letters — USD, GBP, EUR. Not every gift card is a dollar card. */
  @IsString() @MinLength(3) @MaxLength(3) currency!: string;
  @IsNumberString({}, { message: 'Enter a minimum' }) minAmount!: string;
  @IsNumberString({}, { message: 'Enter a maximum' }) maxAmount!: string;
  @IsNumberString({}, { message: 'Enter a rate' }) rateNgn!: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** What the desk actually cleared the card at. Never shown to the user. */
export class ApproveGiftCardDto {
  @IsNumberString({}, { message: 'Enter the rate you cleared it at' }) actualRateNgn!: string;
}

export class PartialApproveGiftCardDto {
  /** What the card is really worth, in its own currency. */
  @IsNumberString({}, { message: 'Enter what the card is worth' }) approvedValue!: string;
  /** What to pay per unit. Defaults to the quoted rate unless overridden. */
  @IsNumberString({}, { message: 'Enter the rate to pay at' }) approvedRateNgn!: string;
  /** What the desk cleared it at. Admin-only. */
  @IsNumberString({}, { message: 'Enter the rate you cleared it at' }) actualRateNgn!: string;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class RejectGiftCardDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}
