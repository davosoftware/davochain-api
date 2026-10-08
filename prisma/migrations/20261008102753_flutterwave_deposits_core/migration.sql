-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('QUIDAX', 'FLUTTERWAVE');

-- CreateEnum
CREATE TYPE "VirtualAccountStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CollectionOutcome" AS ENUM ('UNVERIFIED', 'PENDING_PROVIDER', 'PROVIDER_FAILED', 'CREDITED', 'HELD', 'UNMATCHED', 'NON_CUSTOMER', 'REFUND_PENDING', 'REFUNDED', 'DISPUTED', 'NOT_FOUND');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AlertType" ADD VALUE 'FLUTTERWAVE_CONFIG';
ALTER TYPE "AlertType" ADD VALUE 'FLUTTERWAVE_WEBHOOK_REJECTED';
ALTER TYPE "AlertType" ADD VALUE 'NGN_DEPOSIT_UNMATCHED';
ALTER TYPE "AlertType" ADD VALUE 'NGN_RECONCILIATION';
ALTER TYPE "AlertType" ADD VALUE 'VIRTUAL_ACCOUNT_SYNC';

-- AlterEnum
ALTER TYPE "LedgerAccount" ADD VALUE 'PROVIDER_FEE';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "counterpartyAccountMasked" TEXT,
ADD COLUMN     "counterpartyBank" TEXT,
ADD COLUMN     "counterpartyName" TEXT,
ADD COLUMN     "nameMismatch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "provider" "PaymentProvider" NOT NULL DEFAULT 'QUIDAX',
ADD COLUMN     "providerFee" DECIMAL(38,18),
ADD COLUMN     "providerRef" TEXT,
ADD COLUMN     "providerSettledAmount" DECIMAL(38,18);

-- CreateTable
CREATE TABLE "virtual_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'FLUTTERWAVE',
    "orderRef" TEXT,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "txRef" TEXT NOT NULL,
    "flwRef" TEXT,
    "identityType" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "desiredStatus" "VirtualAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "providerStatus" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "syncFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_account_requests" (
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "stateSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowStartedAt" TIMESTAMP(3),
    "attemptsInWindow" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_account_requests_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "flutterwave_collections" (
    "id" TEXT NOT NULL,
    "flwTransactionId" TEXT NOT NULL,
    "txRef" TEXT,
    "flwRef" TEXT,
    "virtualAccountNumber" TEXT,
    "amount" DECIMAL(38,18),
    "chargedAmount" DECIMAL(38,18),
    "appFee" DECIMAL(38,18),
    "merchantFee" DECIMAL(38,18),
    "amountSettled" DECIMAL(38,18),
    "currency" TEXT,
    "paymentType" TEXT,
    "providerStatus" TEXT,
    "payerName" TEXT,
    "payerBankName" TEXT,
    "payerBankCode" TEXT,
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
    "settlementId" TEXT,
    "settlementStatus" TEXT,
    "settlementAmount" DECIMAL(38,18),
    "settledAt" TIMESTAMP(3),
    "assignedBy" TEXT,
    "assignReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flutterwave_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_leases" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "virtual_accounts_orderRef_key" ON "virtual_accounts"("orderRef");

-- CreateIndex
CREATE INDEX "virtual_accounts_userId_idx" ON "virtual_accounts"("userId");

-- CreateIndex
CREATE INDEX "virtual_accounts_accountNumber_idx" ON "virtual_accounts"("accountNumber");

-- CreateIndex
CREATE INDEX "virtual_accounts_txRef_idx" ON "virtual_accounts"("txRef");

-- CreateIndex
CREATE UNIQUE INDEX "flutterwave_collections_flwTransactionId_key" ON "flutterwave_collections"("flwTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "flutterwave_collections_transactionId_key" ON "flutterwave_collections"("transactionId");

-- CreateIndex
CREATE INDEX "flutterwave_collections_outcome_providerCreatedAt_idx" ON "flutterwave_collections"("outcome", "providerCreatedAt");

-- CreateIndex
CREATE INDEX "flutterwave_collections_outcome_lastCheckedAt_idx" ON "flutterwave_collections"("outcome", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "flutterwave_collections_userId_idx" ON "flutterwave_collections"("userId");

-- CreateIndex
CREATE INDEX "flutterwave_collections_txRef_idx" ON "flutterwave_collections"("txRef");

-- CreateIndex
CREATE INDEX "flutterwave_collections_settlementId_idx" ON "flutterwave_collections"("settlementId");

-- CreateIndex
CREATE INDEX "transactions_provider_providerRef_idx" ON "transactions"("provider", "providerRef");

-- AddForeignKey
ALTER TABLE "virtual_accounts" ADD CONSTRAINT "virtual_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
