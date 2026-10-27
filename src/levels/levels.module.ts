import { Global, Module } from '@nestjs/common';
import { RatesModule } from '../rates/rates.module';
import { LevelPolicyService } from './level-policy.service';
import { DailyUsageService } from './daily-usage.service';

/** Global: every money module asks it (as KycLimitsModule was). The daily limits monitor lives beside the check it mirrors. */
@Global()
@Module({ imports: [RatesModule], providers: [LevelPolicyService, DailyUsageService], exports: [LevelPolicyService, DailyUsageService] })
export class LevelsModule {}
