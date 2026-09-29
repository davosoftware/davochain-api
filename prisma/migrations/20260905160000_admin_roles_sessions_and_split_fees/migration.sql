-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'SUB_ADMIN');

-- CreateEnum
CREATE TYPE "AdminOtpPurpose" AS ENUM ('PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "FeeKind" AS ENUM ('RATE', 'SWAP');

-- DropIndex
DROP INDEX "fee_schedules_assetCode_effectiveFrom_idx";

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "role" "AdminRole" NOT NULL DEFAULT 'SUB_ADMIN';

-- AlterTable: every existing schedule priced the rate, so RATE is the default.
ALTER TABLE "fee_schedules" ADD COLUMN     "kind" "FeeKind" NOT NULL DEFAULT 'RATE';

-- The two fees split into two ladders. Done in stages so nothing configured is
-- lost: add the new column, move both fees into their own schedules, and only
-- then drop the originals.
ALTER TABLE "fee_bands" ADD COLUMN "value" DECIMAL(38,18);

-- 1. The rate fee stays on the schedule it is already attached to.
UPDATE "fee_bands" SET "value" = "gateNgnPerUsd";

-- The old column is about to be dropped, but the SWAP rungs inserted below
-- have nothing to put in it, so its NOT NULL has to go first.
ALTER TABLE "fee_bands" ALTER COLUMN "gateNgnPerUsd" DROP NOT NULL;

-- 2. Every schedule that set a swap fee gets a SWAP twin, carrying the same
--    boundaries and the same provenance, so today's prices survive the split.
INSERT INTO "fee_schedules" ("id", "kind", "assetCode", "effectiveFrom", "setBy", "note", "createdAt")
SELECT
  gen_random_uuid(),
  'SWAP',
  s."assetCode",
  s."effectiveFrom",
  s."setBy",
  COALESCE(s."note" || ' ', '') || '(split from the combined ladder)',
  s."createdAt"
FROM "fee_schedules" s
WHERE s."kind" = 'RATE'
  AND EXISTS (
    SELECT 1 FROM "fee_bands" b
    WHERE b."scheduleId" = s."id" AND b."swapFeeUsd" IS NOT NULL
  );

-- 3. Their rungs. Matched back by coin and timestamp, which is unique per
--    schedule because a schedule is created one at a time.
INSERT INTO "fee_bands" ("id", "scheduleId", "minUsd", "maxUsd", "value", "sortOrder")
SELECT
  gen_random_uuid(),
  swap."id",
  b."minUsd",
  b."maxUsd",
  b."swapFeeUsd",
  b."sortOrder"
FROM "fee_schedules" swap
JOIN "fee_schedules" rate
  ON rate."kind" = 'RATE'
 AND rate."effectiveFrom" = swap."effectiveFrom"
 AND rate."assetCode" IS NOT DISTINCT FROM swap."assetCode"
JOIN "fee_bands" b
  ON b."scheduleId" = rate."id"
WHERE swap."kind" = 'SWAP'
  AND b."swapFeeUsd" IS NOT NULL;

-- 4. Now the originals can go.
ALTER TABLE "fee_bands" ALTER COLUMN "value" SET NOT NULL;
ALTER TABLE "fee_bands" DROP COLUMN "gateNgnPerUsd";
ALTER TABLE "fee_bands" DROP COLUMN "swapFeeUsd";

-- The bootstrap admin is the owner. Without this every existing account would
-- come back as a SUB_ADMIN with no permissions and nobody could sign in to
-- grant any — the migration would lock the dashboard.
UPDATE "admin_users" SET "role" = 'OWNER'
WHERE "id" = (
  SELECT "id" FROM "admin_users" WHERE "isActive" = true ORDER BY "createdAt" ASC LIMIT 1
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedWhy" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_otps" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "purpose" "AdminOtpPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "sentTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_jti_key" ON "admin_sessions"("jti");

-- CreateIndex
CREATE INDEX "admin_sessions_adminUserId_revokedAt_idx" ON "admin_sessions"("adminUserId", "revokedAt");

-- CreateIndex
CREATE INDEX "admin_sessions_lastSeenAt_idx" ON "admin_sessions"("lastSeenAt");

-- CreateIndex
CREATE INDEX "admin_otps_adminUserId_purpose_consumedAt_idx" ON "admin_otps"("adminUserId", "purpose", "consumedAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_adminUserId_createdAt_idx" ON "admin_audit_log"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_action_createdAt_idx" ON "admin_audit_log"("action", "createdAt");

-- CreateIndex
CREATE INDEX "fee_schedules_kind_assetCode_effectiveFrom_idx" ON "fee_schedules"("kind", "assetCode", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_otps" ADD CONSTRAINT "admin_otps_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

