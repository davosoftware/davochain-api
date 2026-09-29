-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'COMPLETED', 'VOID');

-- CreateEnum
CREATE TYPE "ReferralRewardKind" AS ENUM ('REFERRER', 'REFEREE');

-- CreateEnum
CREATE TYPE "ReferralRewardStatus" AS ENUM ('PENDING', 'RELEASED', 'VOID');

-- AlterEnum
ALTER TYPE "LedgerAccount" ADD VALUE 'PROMOTION';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "referralCode" TEXT,
ADD COLUMN     "username" TEXT;

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "codeUsed" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_rewards" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ReferralRewardKind" NOT NULL,
    "status" "ReferralRewardStatus" NOT NULL DEFAULT 'PENDING',
    "amountNgn" DECIMAL(38,18) NOT NULL,
    "blockedReason" TEXT,
    "releasedAt" TIMESTAMP(3),
    "transactionId" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "referrerRewardNgn" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "refereeRewardNgn" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "unlockTier" "KycTier" NOT NULL DEFAULT 'TIER_1',
    "refereeTradeVolumeNgn" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "maxPaidReferralsPerUser" INTEGER NOT NULL DEFAULT 0,
    "maxEarningsPerUserNgn" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "headline" TEXT NOT NULL DEFAULT 'Invite friends, earn naira',
    "terms" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referrals_refereeId_key" ON "referrals"("refereeId");

-- CreateIndex
CREATE INDEX "referrals_referrerId_createdAt_idx" ON "referrals"("referrerId", "createdAt");

-- CreateIndex
CREATE INDEX "referrals_status_idx" ON "referrals"("status");

-- CreateIndex
CREATE UNIQUE INDEX "referral_rewards_transactionId_key" ON "referral_rewards"("transactionId");

-- CreateIndex
CREATE INDEX "referral_rewards_userId_status_idx" ON "referral_rewards"("userId", "status");

-- CreateIndex
CREATE INDEX "referral_rewards_status_createdAt_idx" ON "referral_rewards"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "referral_rewards_referralId_kind_key" ON "referral_rewards"("referralId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

