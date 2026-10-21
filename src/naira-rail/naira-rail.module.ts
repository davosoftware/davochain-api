import { Global, Module } from '@nestjs/common';
import { PayrepModule } from '../payrep/payrep.module';
import { NAIRA_RAIL } from './naira-rail';
import { PayrepRail } from './payrep-rail';
import { RailTransferHooks } from './rail-transfer-hooks';

/**
 * The active naira rail, injected as NAIRA_RAIL. Payrep MFB today; to change
 * provider, write another class implementing NairaRail and point useExisting at it.
 */
@Global()
@Module({
  imports: [PayrepModule],
  providers: [PayrepRail, { provide: NAIRA_RAIL, useExisting: PayrepRail }, RailTransferHooks],
  exports: [NAIRA_RAIL, RailTransferHooks],
})
export class NairaRailModule {}
