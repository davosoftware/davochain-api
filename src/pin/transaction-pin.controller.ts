import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { TransactionPinService } from './transaction-pin.service';
import { ChangePinDto, CreatePinDto, RequestPinResetDto, ResetPinDto } from './dto';

/** The transaction PIN (29 Oct 2026). docs/TRANSACTION_PIN.md is the app's guide. */
@ApiTags('transaction-pin')
@ApiBearerAuth('user')
@Controller('me/transaction-pin')
export class TransactionPinController {
  constructor(private readonly pins: TransactionPinService) {}

  /** Whether they have a PIN, and whether it is locked. */
  @Get()
  status(@CurrentUser('sub') userId: string) {
    return this.pins.status(userId);
  }

  /** Create the first PIN: password + 4 digits. */
  @RateLimit('pin.manage')
  @Post()
  create(@CurrentUser('sub') userId: string, @Body() dto: CreatePinDto) {
    return this.pins.create(userId, dto.password, dto.pin);
  }

  /** Change it: the old PIN, then the new one. */
  @RateLimit('pin.manage')
  @Put()
  change(@CurrentUser('sub') userId: string, @Body() dto: ChangePinDto) {
    return this.pins.change(userId, dto.currentPin, dto.newPin);
  }

  /** Forgot PIN, step 1: password; a 6-digit code goes to their email. */
  @RateLimit('pin.manage')
  @HttpCode(200)
  @Post('reset/request')
  requestReset(@CurrentUser('sub') userId: string, @Body() dto: RequestPinResetDto) {
    return this.pins.requestReset(userId, dto.password);
  }

  /** Forgot PIN, step 2: the emailed code and the new PIN. */
  @RateLimit('pin.manage')
  @HttpCode(200)
  @Post('reset')
  reset(@CurrentUser('sub') userId: string, @Body() dto: ResetPinDto) {
    return this.pins.reset(userId, dto.code, dto.newPin);
  }
}
