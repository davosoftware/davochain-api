import { Global, Module } from '@nestjs/common';
import { FlutterwaveModule } from '../flutterwave/flutterwave.module';
import { FlutterwaveRail } from './flutterwave-rail';
import { NAIRA_RAIL } from './naira-rail';

/**
 * The active naira rail, injected as NAIRA_RAIL. Flutterwave today; to change
 * provider, write another class implementing NairaRail and point useExisting at it.
 */
@Global()
@Module({
  imports: [FlutterwaveModule],
  providers: [FlutterwaveRail, { provide: NAIRA_RAIL, useExisting: FlutterwaveRail }],
  exports: [NAIRA_RAIL],
})
export class NairaRailModule {}
