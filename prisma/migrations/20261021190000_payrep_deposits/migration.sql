-- Payrep deposits (plan 2026-10-21 Task 7). Flutterwave is removed (spec 2026-10-20 §7).
-- Local development data only: no real customers exist. Old FLUTTERWAVE transactions stay as history.
DELETE FROM "flutterwave_collections";
DELETE FROM "virtual_account_requests";
DELETE FROM "virtual_accounts";

-- DropIndex
DROP INDEX "virtual_accounts_accountNumber_idx";

-- DropIndex
DROP INDEX "virtual_accounts_orderRef_key";

-- DropIndex
DROP INDEX "virtual_accounts_txRef_idx";

-- AlterTable
ALTER TABLE "virtual_accounts" DROP COLUMN "flwRef",
DROP COLUMN "lastSyncedAt",
DROP COLUMN "orderRef",
DROP COLUMN "syncError",
DROP COLUMN "syncFailures",
DROP COLUMN "txRef",
ADD COLUMN     "providerRef" TEXT,
ALTER COLUMN "provider" SET DEFAULT 'PAYREP';

-- DropTable
DROP TABLE "flutterwave_collections";

-- CreateTable
CREATE TABLE "naira_collections" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'PAYREP',
    "providerTransactionId" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "sessionId" TEXT,
    "accountNumber" TEXT,
    "amount" DECIMAL(38,18),
    "fee" DECIMAL(38,18),
    "amountSettled" DECIMAL(38,18),
    "channel" TEXT,
    "providerStatus" TEXT,
    "payerName" TEXT,
    "payerBankName" TEXT,
    "payerAccountMasked" TEXT,
    "providerCreatedAt" TIMESTAMP(3),
    "outcome" "CollectionOutcome" NOT NULL,
    "previousOutcome" "CollectionOutcome",
    "userId" TEXT,
    "transactionId" TEXT,
    "firstSource" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),
    "checkCount" INTEGER NOT NULL DEFAULT 0,
    "webhookHint" JSONB,
    "assignedBy" TEXT,
    "assignReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "naira_collections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "naira_collections_providerTransactionId_key" ON "naira_collections"("providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "naira_collections_transactionId_key" ON "naira_collections"("transactionId");

-- CreateIndex
CREATE INDEX "naira_collections_outcome_lastCheckedAt_idx" ON "naira_collections"("outcome", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "naira_collections_userId_idx" ON "naira_collections"("userId");

-- CreateIndex
CREATE INDEX "naira_collections_accountNumber_idx" ON "naira_collections"("accountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_accounts_providerRef_key" ON "virtual_accounts"("providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_accounts_accountNumber_key" ON "virtual_accounts"("accountNumber");

