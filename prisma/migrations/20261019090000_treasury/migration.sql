-- CreateEnum
CREATE TYPE "TreasuryMoveStatus" AS ENUM ('SENDING', 'CHECKING', 'ARRIVED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AlertType" ADD VALUE 'TREASURY_SHORT';
ALTER TYPE "AlertType" ADD VALUE 'TREASURY_RESERVE_LOW';

-- CreateTable
CREATE TABLE "treasury_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "payoutReserveNgn" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "quidaxFundingBankCode" TEXT,
    "quidaxFundingBankName" TEXT,
    "quidaxFundingAccountNumber" TEXT,
    "quidaxFundingAccountName" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_moves" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'TO_QUIDAX',
    "status" "TreasuryMoveStatus" NOT NULL DEFAULT 'SENDING',
    "railRef" TEXT,
    "railFee" DECIMAL(38,18),
    "failureReason" TEXT,
    "toBankCode" TEXT NOT NULL,
    "toBankName" TEXT NOT NULL,
    "toAccountNumber" TEXT NOT NULL,
    "toAccountName" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "treasury_moves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "treasury_moves_reference_key" ON "treasury_moves"("reference");

-- CreateIndex
CREATE INDEX "treasury_moves_status_idx" ON "treasury_moves"("status");


-- Only one Treasury move may be open (being sent or checked) at a time.
CREATE UNIQUE INDEX "treasury_moves_one_open" ON "treasury_moves" ((true)) WHERE "status" IN ('SENDING', 'CHECKING');
ALTER TABLE "treasury_settings" ADD CONSTRAINT "treasury_settings_reserve_chk" CHECK ("payoutReserveNgn" >= 0);
INSERT INTO "treasury_settings" ("id", "updatedAt") VALUES ('default', now()) ON CONFLICT DO NOTHING;
