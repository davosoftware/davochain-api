-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "KycTier" AS ENUM ('TIER_0', 'TIER_1', 'TIER_2', 'TIER_3');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "KycDocumentType" AS ENUM ('BVN', 'NIN', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_CARD', 'SELFIE', 'PROOF_OF_ADDRESS');

-- CreateEnum
CREATE TYPE "AddressStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED', 'DISABLED');

-- CreateEnum
CREATE TYPE "TxType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'BUY', 'SELL', 'SWAP', 'FEE_CLAIM', 'INTERNAL');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('PENDING', 'PROCESSING', 'ON_HOLD', 'COMPLETED', 'FAILED', 'RECONCILING');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('USER', 'REVENUE', 'INVENTORY', 'FEE_RECEIVABLE', 'IN_FLIGHT', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "SettlementLegKind" AS ENUM ('TRANSFER_IN', 'TRANSFER_OUT', 'SWAP', 'CHAIN_WITHDRAWAL', 'BANK_PAYOUT');

-- CreateEnum
CREATE TYPE "LegState" AS ENUM ('PENDING', 'SENT', 'CONFIRMED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "QuoteSide" AS ENUM ('BUY', 'SELL', 'SWAP');

-- CreateEnum
CREATE TYPE "ClaimRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('PUSH', 'IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('REFILL_NEEDED', 'PRICE_DIP', 'COIN_EMPTY', 'NGN_FUEL_LOW', 'NGN_FUEL_CRITICAL', 'RECONCILIATION_DRIFT', 'DAILY_DIGEST', 'MONTHLY_REPORT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "phone" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "kycTier" "KycTier" NOT NULL DEFAULT 'TIER_0',
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quidax_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quidaxUserId" TEXT NOT NULL,
    "quidaxSn" TEXT NOT NULL,
    "aliasEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quidax_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isListed" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isFiat" BOOLEAN NOT NULL DEFAULT false,
    "displayScale" INTEGER NOT NULL DEFAULT 8,
    "transferMin" DECIMAL(38,18),
    "transferMax" DECIMAL(38,18),
    "transferStep" DECIMAL(38,18),
    "limitsSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "asset_networks" (
    "id" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "depositsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "withdrawsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isListed" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "confirmations" INTEGER NOT NULL DEFAULT 1,
    "addressRegex" TEXT,
    "requiresTag" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_networks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_addresses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "address" TEXT,
    "destinationTag" TEXT,
    "quidaxAddressId" TEXT,
    "status" "AddressStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "deposit_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "available" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "locked" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT,
    "account" "LedgerAccount" NOT NULL,
    "userId" TEXT,
    "assetCode" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TxType" NOT NULL,
    "status" "TxStatus" NOT NULL DEFAULT 'PENDING',
    "fromAsset" TEXT,
    "fromAmount" DECIMAL(38,18),
    "toAsset" TEXT,
    "toAmount" DECIMAL(38,18),
    "displayedRate" DECIMAL(38,18),
    "quidaxRate" DECIMAL(38,18),
    "gateApplied" DECIMAL(38,18),
    "feeAmount" DECIMAL(38,18),
    "feeAsset" TEXT,
    "rateConfigId" TEXT,
    "reference" TEXT NOT NULL,
    "quidaxRef" TEXT,
    "quidaxRawStatus" TEXT,
    "failureReason" TEXT,
    "settledFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_legs" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "kind" "SettlementLegKind" NOT NULL,
    "assetCode" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "reference" TEXT NOT NULL,
    "quidaxRef" TEXT,
    "state" "LegState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_legs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_quotes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "side" "QuoteSide" NOT NULL,
    "fromAsset" TEXT NOT NULL,
    "toAsset" TEXT NOT NULL,
    "fromAmount" DECIMAL(38,18) NOT NULL,
    "toAmount" DECIMAL(38,18) NOT NULL,
    "displayedRate" DECIMAL(38,18) NOT NULL,
    "quidaxRate" DECIMAL(38,18) NOT NULL,
    "gateApplied" DECIMAL(38,18) NOT NULL,
    "feeAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "feeAsset" TEXT,
    "rateConfigId" TEXT NOT NULL,
    "snapshotId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_snapshots" (
    "assetCode" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "ngnPerUsd" DECIMAL(38,18) NOT NULL,
    "priceUsd" DECIMAL(38,18) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'temporary_swap_quotation',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_configs" (
    "id" TEXT NOT NULL,
    "assetCode" TEXT,
    "gateNgnPerUsd" DECIMAL(38,18) NOT NULL,
    "swapFeeUsd" DECIMAL(38,18) NOT NULL DEFAULT 2,
    "floorUsd" DECIMAL(38,18) NOT NULL DEFAULT 10,
    "maxTradeUsd" DECIMAL(38,18) NOT NULL DEFAULT 2000,
    "quoteTtlSeconds" INTEGER NOT NULL DEFAULT 12,
    "withdrawalFee" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setBy" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_settings" (
    "assetCode" TEXT NOT NULL,
    "target" DECIMAL(38,18) NOT NULL,
    "floorPct" DECIMAL(38,18) NOT NULL DEFAULT 25,
    "dipAlertPct" DECIMAL(38,18) NOT NULL DEFAULT 5,
    "fallbackSwapEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_settings_pkey" PRIMARY KEY ("assetCode")
);

-- CreateTable
CREATE TABLE "refill_periods" (
    "id" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "soldQty" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "weightedAvgUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "marginForgoneNgn" DECIMAL(38,18) NOT NULL DEFAULT 0,

    CONSTRAINT "refill_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refills" (
    "id" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "pricePaidUsd" DECIMAL(38,18) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swap_fees" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "usdAtAccrual" DECIMAL(38,18) NOT NULL,
    "rateConfigId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "swap_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_receivables" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "usdAtAccrual" DECIMAL(38,18) NOT NULL,
    "claimRunId" TEXT,
    "sweptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_receivables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_claim_runs" (
    "id" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "assetCodes" TEXT[],
    "destination" TEXT NOT NULL DEFAULT 'usdt',
    "status" "ClaimRunStatus" NOT NULL DEFAULT 'QUEUED',
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "succeededCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "realisedUsd" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "summary" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_claim_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "dedupHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "readAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "assetCode" TEXT,
    "threshold" TEXT,
    "payload" JSONB NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_recipients" (
    "id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "email" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "alert_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_log" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "alertId" TEXT,
    "succeeded" BOOLEAN NOT NULL,
    "error" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_flags" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "kyc_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "KycTier" NOT NULL DEFAULT 'TIER_0',
    "status" "KycStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "dateOfBirth" TIMESTAMP(3),
    "bvnHash" TEXT,
    "bvnLast4" TEXT,
    "ninHash" TEXT,
    "ninLast4" TEXT,
    "addressLine" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT NOT NULL DEFAULT 'NG',
    "providerName" TEXT,
    "providerRef" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "rejectionReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" TEXT NOT NULL,
    "kycProfileId" TEXT NOT NULL,
    "type" "KycDocumentType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_tier_limits" (
    "tier" "KycTier" NOT NULL,
    "canTrade" BOOLEAN NOT NULL DEFAULT false,
    "canWithdrawCrypto" BOOLEAN NOT NULL DEFAULT false,
    "canWithdrawFiat" BOOLEAN NOT NULL DEFAULT false,
    "maxTradeUsd" DECIMAL(38,18) NOT NULL,
    "maxDailyTradeUsd" DECIMAL(38,18) NOT NULL,
    "maxDailyWithdrawUsd" DECIMAL(38,18) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_tier_limits_pkey" PRIMARY KEY ("tier")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_kycTier_kycStatus_idx" ON "users"("kycTier", "kycStatus");

-- CreateIndex
CREATE UNIQUE INDEX "quidax_accounts_userId_key" ON "quidax_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "quidax_accounts_quidaxUserId_key" ON "quidax_accounts"("quidaxUserId");

-- CreateIndex
CREATE UNIQUE INDEX "quidax_accounts_aliasEmail_key" ON "quidax_accounts"("aliasEmail");

-- CreateIndex
CREATE INDEX "quidax_accounts_quidaxSn_idx" ON "quidax_accounts"("quidaxSn");

-- CreateIndex
CREATE INDEX "assets_isListed_sortOrder_idx" ON "assets"("isListed", "sortOrder");

-- CreateIndex
CREATE INDEX "asset_networks_assetCode_isListed_idx" ON "asset_networks"("assetCode", "isListed");

-- CreateIndex
CREATE UNIQUE INDEX "asset_networks_assetCode_networkId_key" ON "asset_networks"("assetCode", "networkId");

-- CreateIndex
CREATE INDEX "deposit_addresses_status_idx" ON "deposit_addresses"("status");

-- CreateIndex
CREATE INDEX "deposit_addresses_address_idx" ON "deposit_addresses"("address");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_addresses_userId_assetCode_networkId_key" ON "deposit_addresses"("userId", "assetCode", "networkId");

-- CreateIndex
CREATE UNIQUE INDEX "balances_userId_assetCode_key" ON "balances"("userId", "assetCode");

-- CreateIndex
CREATE INDEX "ledger_entries_transactionId_idx" ON "ledger_entries"("transactionId");

-- CreateIndex
CREATE INDEX "ledger_entries_userId_assetCode_createdAt_idx" ON "ledger_entries"("userId", "assetCode", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_account_assetCode_createdAt_idx" ON "ledger_entries"("account", "assetCode", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_reference_key" ON "transactions"("reference");

-- CreateIndex
CREATE INDEX "transactions_userId_createdAt_idx" ON "transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "transactions_status_type_idx" ON "transactions"("status", "type");

-- CreateIndex
CREATE INDEX "transactions_quidaxRef_idx" ON "transactions"("quidaxRef");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_legs_reference_key" ON "settlement_legs"("reference");

-- CreateIndex
CREATE INDEX "settlement_legs_state_updatedAt_idx" ON "settlement_legs"("state", "updatedAt");

-- CreateIndex
CREATE INDEX "settlement_legs_transactionId_idx" ON "settlement_legs"("transactionId");

-- CreateIndex
CREATE INDEX "rate_quotes_userId_createdAt_idx" ON "rate_quotes"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "rate_quotes_expiresAt_idx" ON "rate_quotes"("expiresAt");

-- CreateIndex
CREATE INDEX "rate_snapshots_assetCode_capturedAt_idx" ON "rate_snapshots"("assetCode", "capturedAt");

-- CreateIndex
CREATE INDEX "rate_configs_assetCode_effectiveFrom_idx" ON "rate_configs"("assetCode", "effectiveFrom");

-- CreateIndex
CREATE INDEX "refill_periods_assetCode_closedAt_idx" ON "refill_periods"("assetCode", "closedAt");

-- CreateIndex
CREATE INDEX "refills_assetCode_occurredAt_idx" ON "refills"("assetCode", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "swap_fees_transactionId_key" ON "swap_fees"("transactionId");

-- CreateIndex
CREATE INDEX "fee_receivables_assetCode_sweptAt_idx" ON "fee_receivables"("assetCode", "sweptAt");

-- CreateIndex
CREATE INDEX "fee_receivables_userId_assetCode_idx" ON "fee_receivables"("userId", "assetCode");

-- CreateIndex
CREATE INDEX "fee_claim_runs_status_createdAt_idx" ON "fee_claim_runs"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_dedupHash_key" ON "webhook_events"("dedupHash");

-- CreateIndex
CREATE INDEX "webhook_events_eventName_processedAt_idx" ON "webhook_events"("eventName", "processedAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_userId_transactionId_type_channel_key" ON "notifications"("userId", "transactionId", "type", "channel");

-- CreateIndex
CREATE INDEX "alerts_type_assetCode_sentAt_idx" ON "alerts"("type", "assetCode", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "alert_recipients_type_email_key" ON "alert_recipients"("type", "email");

-- CreateIndex
CREATE INDEX "email_log_sentAt_idx" ON "email_log"("sentAt");

-- CreateIndex
CREATE INDEX "idempotency_keys_createdAt_idx" ON "idempotency_keys"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "admin_audit_log_entity_createdAt_idx" ON "admin_audit_log"("entity", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_profiles_userId_key" ON "kyc_profiles"("userId");

-- CreateIndex
CREATE INDEX "kyc_profiles_status_tier_idx" ON "kyc_profiles"("status", "tier");

-- CreateIndex
CREATE INDEX "kyc_profiles_providerRef_idx" ON "kyc_profiles"("providerRef");

-- CreateIndex
CREATE INDEX "kyc_documents_kycProfileId_type_idx" ON "kyc_documents"("kycProfileId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_revokedAt_idx" ON "refresh_tokens"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens"("family");

-- AddForeignKey
ALTER TABLE "quidax_accounts" ADD CONSTRAINT "quidax_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_networks" ADD CONSTRAINT "asset_networks_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_assetCode_networkId_fkey" FOREIGN KEY ("assetCode", "networkId") REFERENCES "asset_networks"("assetCode", "networkId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_legs" ADD CONSTRAINT "settlement_legs_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_quotes" ADD CONSTRAINT "rate_quotes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_snapshots" ADD CONSTRAINT "rate_snapshots_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_configs" ADD CONSTRAINT "rate_configs_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refill_periods" ADD CONSTRAINT "refill_periods_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refills" ADD CONSTRAINT "refills_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_fees" ADD CONSTRAINT "swap_fees_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receivables" ADD CONSTRAINT "fee_receivables_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receivables" ADD CONSTRAINT "fee_receivables_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receivables" ADD CONSTRAINT "fee_receivables_claimRunId_fkey" FOREIGN KEY ("claimRunId") REFERENCES "fee_claim_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_profiles" ADD CONSTRAINT "kyc_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_kycProfileId_fkey" FOREIGN KEY ("kycProfileId") REFERENCES "kyc_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
