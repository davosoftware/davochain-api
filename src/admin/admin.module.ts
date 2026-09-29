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
import { AdminController, AdminAuthController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AssetsModule } from '../assets/assets.module';
import { InventoryModule } from '../inventory/inventory.module';
import { FeesModule } from '../fees/fees.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { RatesModule } from '../rates/rates.module';
import { LedgerModule } from '../ledger/ledger.module';
import { GiftCardsModule } from '../giftcards/giftcards.module';
import { QUEUES } from '../common/queues';

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
  ],
  controllers: [AdminController, AdminAuthController],
  providers: [AdminService, UsersAdminService, AdminsService, OverviewService, EarningsService, AdminTransactionsService, SiteSettingsService, AdminSessionsService, AdminOtpService, AdminGuard],
  exports: [AdminService, UsersAdminService, AdminsService, AdminSessionsService, OverviewService, EarningsService, AdminTransactionsService, SiteSettingsService],
})
export class AdminModule {}
