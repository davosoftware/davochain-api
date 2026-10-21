import { Global, Module } from '@nestjs/common';
import { FlutterwaveModule } from '../flutterwave/flutterwave.module';
import { PayrepModule } from '../payrep/payrep.module';
import { NAIRA_RAIL } from './naira-rail';
import { PayrepRail } from './payrep-rail';
import { RailTransferHooks } from './rail-transfer-hooks';

/**
 * The active naira rail, injected as NAIRA_RAIL. Payrep MFB today; to change
 * provider, write another class implementing NairaRail and point useExisting at it.
 * (FlutterwaveModule stays imported until the deposit side moves to Payrep.)
 */
@Global()
@Module({
  imports: [PayrepModule, FlutterwaveModule],
  providers: [PayrepRail, { provide: NAIRA_RAIL, useExisting: PayrepRail }, RailTransferHooks],
  exports: [NAIRA_RAIL, RailTransferHooks],
})
export class NairaRailModule {}
