-- CreateEnum
CREATE TYPE "AdminChallengeKind" AS ENUM ('CODE', 'SETUP');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminOtpPurpose" ADD VALUE 'LOGIN';
ALTER TYPE "AdminOtpPurpose" ADD VALUE 'TWO_STEP_CHANGE';

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "twoStepEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoStepEnabledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "admin_backup_codes" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_backup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_login_challenges" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "ticketHash" TEXT NOT NULL,
    "kind" "AdminChallengeKind" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_login_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_backup_codes_adminUserId_usedAt_idx" ON "admin_backup_codes"("adminUserId", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_login_challenges_ticketHash_key" ON "admin_login_challenges"("ticketHash");

-- CreateIndex
CREATE INDEX "admin_login_challenges_adminUserId_createdAt_idx" ON "admin_login_challenges"("adminUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "admin_backup_codes" ADD CONSTRAINT "admin_backup_codes_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_login_challenges" ADD CONSTRAINT "admin_login_challenges_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

