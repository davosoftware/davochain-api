import { Global, Module } from '@nestjs/common';
import { OpsAlertsService } from './ops-alerts.service';

/** Deduplicated operational alerts, available everywhere: deposits, rate limiting, admin lockouts. */
@Global()
@Module({
  providers: [OpsAlertsService],
  exports: [OpsAlertsService],
})
export class OpsAlertsModule {}
