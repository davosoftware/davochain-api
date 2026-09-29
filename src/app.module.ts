import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { KycLimitsModule } from './kyc/kyc-limits.module';
import { QueueModule } from './common/queue.module';
import { QuidaxModule } from './quidax/quidax.module';
import { LedgerModule } from './ledger/ledger.module';
import { ReferralsModule } from './referrals/referrals.module';
import { GiftCardsModule } from './giftcards/giftcards.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { KycModule } from './kyc/kyc.module';
import { AssetsModule } from './assets/assets.module';
import { AddressesModule } from './addresses/addresses.module';
import { RatesModule } from './rates/rates.module';
import { QuotesModule } from './quotes/quotes.module';
import { TradesModule } from './trades/trades.module';
import { DepositsModule } from './deposits/deposits.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { NotificationsModule } from './notifications/notifications.module';
import { InventoryModule } from './inventory/inventory.module';
import { FeesModule } from './fees/fees.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { AdminModule } from './admin/admin.module';
import { SiteModule } from './site/site.module';
import { CmsModule } from './cms/cms.module';
import { HealthController } from './common/health.controller';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    CommonModule,
    KycLimitsModule,
    QueueModule,
    CmsModule,
    ScheduleModule.forRoot(),
    QuidaxModule,
    LedgerModule,
    AuthModule,
    UsersModule,
    KycModule,
    AssetsModule,
    AddressesModule,
    RatesModule,
    QuotesModule,
    TradesModule,
    DepositsModule,
    WithdrawalsModule,
    WebhooksModule,
    NotificationsModule,
    InventoryModule,
    FeesModule,
    ReconciliationModule,
    ReferralsModule,
    GiftCardsModule,
    AdminModule,
    SiteModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
