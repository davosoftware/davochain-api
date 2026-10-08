import { Module } from '@nestjs/common';
import { FlutterwaveModule } from '../flutterwave/flutterwave.module';
import { KycModule } from '../kyc/kyc.module';
import { OpsAlertsService } from './ops-alerts.service';
import { ReadinessService } from './readiness.service';
import { VirtualAccountsController } from './virtual-accounts.controller';
import { VirtualAccountsService } from './virtual-accounts.service';

/**
 * Naira deposits through Flutterwave: virtual accounts, webhook intake,
 * verification and crediting, the missed-webhook sweep, and readiness.
 */
@Module({
  imports: [FlutterwaveModule, KycModule],
  controllers: [VirtualAccountsController],
  providers: [OpsAlertsService, ReadinessService, VirtualAccountsService],
  exports: [OpsAlertsService, ReadinessService, VirtualAccountsService],
})
export class NgnDepositsModule {}
