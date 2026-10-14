import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../common/queues';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { UserOtpService } from './user-otp.service';
import { AuthController } from './auth.controller';
import { PasswordService } from './password.service';
import { JwtAuthGuard, KycGuard } from './jwt-auth.guard';
import { MaintenanceGuard } from '../common/maintenance.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@Global()
@Module({
  imports: [JwtModule.register({}), BullModule.registerQueue({ name: QUEUES.PROVISIONING })],
  controllers: [AuthController],
  providers: [
    AuthService,
    UserOtpService,
    PasswordService,
    // Global. Auth is on by default; a route opts out with @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: KycGuard },
    // Money-moving routes answer 503 while an admin has maintenance mode on.
    { provide: APP_GUARD, useClass: MaintenanceGuard },
    // Last, so the signed-in user is known when a per-user limit is counted.
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [AuthService, PasswordService, JwtModule],
})
export class AuthModule {}
