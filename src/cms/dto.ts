import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Bodies are capped generously but not unboundedly. A privacy policy is long;
 * a megabyte of it is somebody pasting a whole document by accident, and an
 * unbounded text column reachable from a form is a cheap way to fill a disk.
 */
const BODY_MAX = 60_000;

export class CreatePageDto {
  @IsString() @MinLength(2) @MaxLength(160) title!: string;

  /** Derived from the title when omitted. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'A slug is lowercase letters, numbers and hyphens — for example "terms-and-conditions"',
  })
  slug?: string;

  @IsString() @MaxLength(BODY_MAX) body!: string;

  @IsOptional() @IsString() @MaxLength(300) excerpt?: string;
  @IsOptional() @IsBoolean() isPublished?: boolean;
}

export class UpdatePageDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'A slug is lowercase letters, numbers and hyphens',
  })
  slug?: string;

  @IsOptional() @IsString() @MaxLength(BODY_MAX) body?: string;
  @IsOptional() @IsString() @MaxLength(300) excerpt?: string;
  @IsOptional() @IsBoolean() isPublished?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class CreateFaqDto {
  @IsString() @MinLength(3) @MaxLength(300) question!: string;
  @IsString() @MinLength(1) @MaxLength(8_000) answer!: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsBoolean() isPublished?: boolean;
}

export class UpdateFaqDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(300) question?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(8_000) answer?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsBoolean() isPublished?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class ReorderDto {
  @IsArray() @IsString({ each: true }) ids!: string[];
}

export class UpdateEmailTemplateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) subject?: string;
  @IsOptional() @IsString() @MaxLength(BODY_MAX) body?: string;

  /** Off means this event sends no email. The push and the feed are unaffected. */
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class PreviewEmailDto {
  /** Preview what is in the editor, not what is saved. */
  @IsOptional() @IsString() @MaxLength(200) subject?: string;
  @IsOptional() @IsString() @MaxLength(BODY_MAX) body?: string;

  /** Where to send a real copy. Omit to render without sending. */
  @IsOptional() @IsString() @MaxLength(254) sendTo?: string;
}

export class EmailImageDto {
  /** A data URL. Decoded, checked by its first bytes, then stored. */
  @IsString() @MaxLength(3_000_000) dataUrl!: string;

  /**
   * What an inbox shows when images are blocked — which, in a lot of corporate
   * mail, is the only version anyone ever sees.
   */
  @IsOptional() @IsString() @MaxLength(200) alt?: string;
}

export class SocialLinkDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) label?: string;
  @IsOptional() @IsString() @MaxLength(500) url?: string;

  /** Off keeps the row and its icon but takes it out of emails and the site. */
  @IsOptional() @IsBoolean() isEnabled?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class SocialIconDto {
  /** A data URL. Decoded, checked by its first bytes, then stored. */
  @IsString() @MaxLength(400_000) dataUrl!: string;
}
