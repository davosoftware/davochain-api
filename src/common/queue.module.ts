import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUES, DEFAULT_JOB_OPTS } from './queues';

const queues = Object.values(QUEUES).map((name) => ({ name }));

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
          maxRetriesPerRequest: null,
        },
        defaultJobOptions: DEFAULT_JOB_OPTS,
      }),
    }),
    BullModule.registerQueue(...queues),
  ],
  exports: [BullModule],
})
export class QueueModule {}
