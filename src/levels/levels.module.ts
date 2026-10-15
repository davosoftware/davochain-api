import { Global, Module } from '@nestjs/common';
import { RatesModule } from '../rates/rates.module';
import { LevelPolicyService } from './level-policy.service';

/** Global: every money module asks it (as KycLimitsModule was). */
@Global()
@Module({ imports: [RatesModule], providers: [LevelPolicyService], exports: [LevelPolicyService] })
export class LevelsModule {}
