import { Module } from '@nestjs/common';
import { FlutterwaveModule } from '../flutterwave/flutterwave.module';
import { OpsAlertsService } from './ops-alerts.service';
import { ReadinessService } from './readiness.service';

/**
 * Naira deposits through Flutterwave: virtual accounts, webhook intake,
 * verification and crediting, the missed-webhook sweep, and readiness.
 */
@Module({
  imports: [FlutterwaveModule],
  providers: [OpsAlertsService, ReadinessService],
  exports: [OpsAlertsService, ReadinessService],
})
export class NgnDepositsModule {}
