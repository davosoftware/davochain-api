import { Body, Controller, Get, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { KycService } from './kyc.service';
import { BasicVerificationService } from './basic-verification.service';
import { KycDocumentsService, UPLOADABLE_DOCUMENT_TYPES, type UploadableDocumentType } from './kyc-documents.service';
import { DocumentUploadInterceptor } from './document-upload.interceptor';
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

/**
 * The form fields beside the file (H8). Only the type: where the file is
 * stored, what it is and how big it is are all decided by the server.
 */
export class AttachDocumentDto {
  // L1: outside the list it reached the database and came back a 500.
  @IsIn(UPLOADABLE_DOCUMENT_TYPES, { message: `type must be one of: ${UPLOADABLE_DOCUMENT_TYPES.join(', ')}` })
  type!: UploadableDocumentType;
}

@ApiTags('kyc')
@ApiBearerAuth('user')
@Controller('kyc')
export class KycController {
  constructor(
    private readonly kyc: KycService,
    private readonly basic: BasicVerificationService,
    private readonly documents: KycDocumentsService,
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

  /**
   * Upload one ID document (H8): multipart/form-data with "type" and "file".
   * 201 once the file is stored AND recorded; 200 when it is the same file
   * again (a retry), which creates nothing new.
   */
  @PausedDuringMaintenance()
  @RateLimit('kyc.documents')
  @Post('documents')
  @UseInterceptors(DocumentUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['type', 'file'],
      properties: { type: { type: 'string', enum: [...UPLOADABLE_DOCUMENT_TYPES] }, file: { type: 'string', format: 'binary' } },
    },
  })
  async attach(
    @CurrentUser('sub') userId: string,
    @Body() dto: AttachDocumentDto,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { duplicate, ...doc } = await this.documents.upload(userId, dto.type, file);
    if (duplicate) res.status(200);
    return doc;
  }
}
