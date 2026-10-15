import { AlertRecipientsController } from './alert-recipients.controller';
import { KycBasicReviewController } from './kyc-basic-review.controller';
import { ComplianceController } from './compliance.controller';
import { DojahAdminController } from './dojah-admin.controller';
import { KycModule } from '../kyc/kyc.module';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';
import { AdminService } from './admin.service';
import { UsersAdminService } from './users-admin.service';
import { AdminsService } from './admins.service';
import { OverviewService } from './overview.service';
import { EarningsService } from './earnings.service';
import { AdminTransactionsService } from './transactions.service';
import { SiteSettingsService } from './site-settings.service';
import { AdminSessionsService } from './sessions.service';
import { AdminOtpService } from './otp.service';
import { NgnWithdrawalsService } from './ngn-withdrawals.service';
import { AdminController, AdminAuthController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AssetsModule } from '../assets/assets.module';
import { InventoryModule } from '../inventory/inventory.module';
import { FeesModule } from '../fees/fees.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { RatesModule } from '../rates/rates.module';
import { LedgerModule } from '../ledger/ledger.module';
import { GiftCardsModule } from '../giftcards/giftcards.module';
import { NgnDepositsModule } from '../ngn-deposits/ngn-deposits.module';
import { FlutterwaveModule } from '../flutterwave/flutterwave.module';
import { QUEUES } from '../common/queues';
import { LevelAdminService } from '../levels/level-admin.service';

@Module({
  imports: [
    JwtModule.register({}),
    BullModule.registerQueue({ name: QUEUES.NOTIFICATIONS }),
    AssetsModule,
    InventoryModule,
    FeesModule,
    ReconciliationModule,
    RatesModule,
    // Releasing a held deposit writes the ledger entry the webhook never got to.
    LedgerModule,
    GiftCardsModule,
    NgnDepositsModule,
    FlutterwaveModule,
    KycModule,
  ],
  controllers: [AdminController, AdminAuthController, AlertRecipientsController, KycBasicReviewController, ComplianceController, DojahAdminController],
  providers: [AdminService, UsersAdminService, AdminsService, OverviewService, EarningsService, AdminTransactionsService, SiteSettingsService, AdminSessionsService, AdminOtpService, NgnWithdrawalsService, AdminGuard, LevelAdminService],
  exports: [AdminService, UsersAdminService, AdminsService, AdminSessionsService, OverviewService, EarningsService, AdminTransactionsService, SiteSettingsService],
})
export class AdminModule {}
