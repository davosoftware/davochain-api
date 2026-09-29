-- CreateEnum
CREATE TYPE "BroadcastAudience" AS ENUM ('ALL', 'SELECTED');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "broadcastId" TEXT;

-- CreateTable
CREATE TABLE "fee_schedules" (
    "id" TEXT NOT NULL,
    "assetCode" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "setBy" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_bands" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "minUsd" DECIMAL(38,18) NOT NULL,
    "maxUsd" DECIMAL(38,18),
    "gateNgnPerUsd" DECIMAL(38,18) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "fee_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" "BroadcastAudience" NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_schedules_assetCode_effectiveFrom_idx" ON "fee_schedules"("assetCode", "effectiveFrom");

-- CreateIndex
CREATE INDEX "fee_bands_scheduleId_sortOrder_idx" ON "fee_bands"("scheduleId", "sortOrder");

-- CreateIndex
CREATE INDEX "broadcasts_createdAt_idx" ON "broadcasts"("createdAt");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "broadcasts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_assetCode_fkey" FOREIGN KEY ("assetCode") REFERENCES "assets"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_bands" ADD CONSTRAINT "fee_bands_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "fee_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
