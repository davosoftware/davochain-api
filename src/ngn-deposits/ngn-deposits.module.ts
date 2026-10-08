import { Module } from '@nestjs/common';
import { FlutterwaveModule } from '../flutterwave/flutterwave.module';
import { KycModule } from '../kyc/kyc.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RatesModule } from '../rates/rates.module';
import { OpsAlertsService } from './ops-alerts.service';
import { PayInProcessor } from './pay-in.processor';
import { PayInService } from './pay-in.service';
import { ReadinessService } from './readiness.service';
import { SweepService } from './sweep.service';
import { VirtualAccountsController } from './virtual-accounts.controller';
import { VirtualAccountsService } from './virtual-accounts.service';
import { FlutterwaveWebhookController } from './flutterwave-webhook.controller';

/**
 * Naira deposits through Flutterwave: virtual accounts, webhook intake,
 * verification and crediting, the missed-webhook sweep, and readiness.
 */
@Module({
  imports: [FlutterwaveModule, KycModule, LedgerModule, RatesModule],
  controllers: [VirtualAccountsController, FlutterwaveWebhookController],
  providers: [OpsAlertsService, ReadinessService, VirtualAccountsService, PayInService, PayInProcessor, SweepService],
  exports: [OpsAlertsService, ReadinessService, VirtualAccountsService, PayInService],
})
export class NgnDepositsModule {}
