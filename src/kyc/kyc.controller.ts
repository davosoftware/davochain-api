import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsDateString, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { KycService } from './kyc.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

class SubmitTier1Dto {
  @IsOptional() @IsString() @Matches(/^[0-9]{11}$/) bvn?: string;
  @IsOptional() @IsString() @Matches(/^[0-9]{11}$/) nin?: string;
  @IsDateString() dateOfBirth!: string;
}

class AttachDocumentDto {
  @IsString() type!: string;
  @IsString() @MaxLength(500) storageKey!: string;
  @IsString() @MaxLength(100) mimeType!: string;
  @IsInt() sizeBytes!: number;
}

@ApiTags('kyc')
@ApiBearerAuth('user')
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  status(@CurrentUser('sub') userId: string) {
    return this.kyc.status(userId);
  }

  @Post('tier1')
  submit(@CurrentUser('sub') userId: string, @Body() dto: SubmitTier1Dto) {
    return this.kyc.submitTier1(userId, dto);
  }

  @Post('documents')
  attach(@CurrentUser('sub') userId: string, @Body() dto: AttachDocumentDto) {
    return this.kyc.attachDocument(userId, dto);
  }
}
