import { Module } from '@nestjs/common';
import { FlutterwaveModule } from '../flutterwave/flutterwave.module';
import { KycModule } from '../kyc/kyc.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RatesModule } from '../rates/rates.module';
import { PayInProcessor } from './pay-in.processor';
import { PayInService } from './pay-in.service';
import { ReadinessService } from './readiness.service';
import { SweepService } from './sweep.service';
import { VirtualAccountsController } from './virtual-accounts.controller';
import { VirtualAccountsService } from './virtual-accounts.service';
import { FlutterwaveWebhookController } from './flutterwave-webhook.controller';
import { DepositIntake, PayrepWebhookController } from './payrep-webhook.controller';
import { PayrepModule } from '../payrep/payrep.module';

/**
 * Naira deposits through Flutterwave: virtual accounts, webhook intake,
 * verification and crediting, the missed-webhook sweep, and readiness.
 */
@Module({
  imports: [FlutterwaveModule, PayrepModule, KycModule, LedgerModule, RatesModule],
  controllers: [VirtualAccountsController, FlutterwaveWebhookController, PayrepWebhookController],
  providers: [
    ReadinessService,
    VirtualAccountsService,
    PayInService,
    { provide: DepositIntake, useExisting: PayInService },
    PayInProcessor,
    SweepService,
  ],
  exports: [ReadinessService, VirtualAccountsService, PayInService],
})
export class NgnDepositsModule {}
