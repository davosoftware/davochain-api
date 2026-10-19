import { Global, Module } from '@nestjs/common';
import { FlutterwaveModule } from '../flutterwave/flutterwave.module';
import { FlutterwaveRail } from './flutterwave-rail';
import { NAIRA_RAIL } from './naira-rail';
import { RailTransferHooks } from './rail-transfer-hooks';

/**
 * The active naira rail, injected as NAIRA_RAIL. Flutterwave today; to change
 * provider, write another class implementing NairaRail and point useExisting at it.
 */
@Global()
@Module({
  imports: [FlutterwaveModule],
  providers: [FlutterwaveRail, { provide: NAIRA_RAIL, useExisting: FlutterwaveRail }, RailTransferHooks],
  exports: [NAIRA_RAIL, RailTransferHooks],
})
export class NairaRailModule {}
