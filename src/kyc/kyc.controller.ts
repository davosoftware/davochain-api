import { Body, Controller, Get, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { KycDocumentType } from '@prisma/client';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { KycService } from './kyc.service';
import { BasicVerificationService } from './basic-verification.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { NG_STATES } from './ng-states';
import { PausedDuringMaintenance } from '../common/maintenance.guard';

/** A letter first, then letters, accents, apostrophes, spaces, dots and hyphens. */
const NAME = /^[\p{L}][\p{L}\p{M}' .-]{0,59}$/u;

class AddressDto {
  @IsString() @IsNotEmpty() @MaxLength(200) street!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) city!: string;
  @IsString() @IsNotEmpty() @MaxLength(40) state!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) lga!: string;
  @IsOptional() @IsString() @Matches(/^\d{6}$/, { message: 'A postcode is 6 digits' }) postcode?: string;
}

export class SubmitBasicDto {
  @IsIn(['BVN', 'NIN']) idType!: 'BVN' | 'NIN';
  @IsString() @Matches(/^[0-9]{11}$/, { message: 'BVN and NIN are 11 digits' }) idNumber!: string;
  @IsString() @Matches(NAME, { message: 'Enter your first name as it appears on your ID' }) firstName!: string;
  @IsOptional() @IsString() @Matches(NAME, { message: 'Enter your middle name as it appears on your ID' }) middleName?: string;
  @IsString() @Matches(NAME, { message: 'Enter your last name as it appears on your ID' }) lastName!: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use YYYY-MM-DD' }) dateOfBirth!: string;
  @ValidateNested() @Type(() => AddressDto) address!: AddressDto;
  @IsString() @IsNotEmpty() @MaxLength(40) stateOfOrigin!: string;
  @IsIn(['NG']) country!: 'NG';
}

export class AttachDocumentDto {
  // L1: outside the list it reached the database and came back a 500.
  @IsEnum(KycDocumentType, { message: `type must be one of: ${Object.values(KycDocumentType).join(', ')}` }) type!: KycDocumentType;
  @IsString() @MaxLength(500) storageKey!: string;
  @IsString() @MaxLength(100) mimeType!: string;
  @IsInt() sizeBytes!: number;
}

@ApiTags('kyc')
@ApiBearerAuth('user')
@Controller('kyc')
export class KycController {
  constructor(
    private readonly kyc: KycService,
    private readonly basic: BasicVerificationService,
  ) {}

  @Get()
  status(@CurrentUser('sub') userId: string) {
    return this.kyc.status(userId);
  }

  /** Basic verification (spec §11). Off until KYC_BASIC_ENABLED and readiness are green. */
  @PausedDuringMaintenance()
  @Post('basic')
  @RateLimit('kyc.basic')
  submitBasic(@CurrentUser('sub') userId: string, @Body() dto: SubmitBasicDto) {
    return this.basic.submit(userId, dto);
  }

  /** The 36 states plus the FCT, with their LGAs. */
  @Public()
  @RateLimit('public')
  @Get('states')
  states() {
    return { states: NG_STATES };
  }

  @Post('documents')
  attach(@CurrentUser('sub') userId: string, @Body() dto: AttachDocumentDto) {
    return this.kyc.attachDocument(userId, dto);
  }
}
