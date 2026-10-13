import { Global, Module } from '@nestjs/common';
import { AlertRecipientsService } from './alert-recipients.service';
import { OpsAlertsService } from './ops-alerts.service';

/** Deduplicated operational alerts and who receives them, available everywhere. */
@Global()
@Module({
  providers: [OpsAlertsService, AlertRecipientsService],
  exports: [OpsAlertsService, AlertRecipientsService],
})
export class OpsAlertsModule {}
