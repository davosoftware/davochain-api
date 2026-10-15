-- CreateEnum
CREATE TYPE "PolicyLevel" AS ENUM ('NONE', 'BASIC', 'ADVANCED');

-- CreateEnum
CREATE TYPE "PolicyAction" AS ENUM ('BUY', 'SELL', 'SWAP', 'CRYPTO_DEPOSIT', 'CRYPTO_WITHDRAW', 'NGN_DEPOSIT', 'NGN_WITHDRAW', 'GIFTCARD_SELL');

-- CreateEnum
CREATE TYPE "LimitCurrency" AS ENUM ('NGN', 'USD');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "credentialsChangedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "level_rules" (
    "level" "PolicyLevel" NOT NULL,
    "action" "PolicyAction" NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT false,
    "currency" "LimitCurrency" NOT NULL DEFAULT 'NGN',
    "minPerTx" DECIMAL(38,18),
    "maxPerTx" DECIMAL(38,18),
    "maxPerDay" DECIMAL(38,18),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "level_rules_pkey" PRIMARY KEY ("level","action")
);

-- CreateTable
CREATE TABLE "level_cooloffs" (
    "level" "PolicyLevel" NOT NULL,
    "afterSignupHours" INTEGER NOT NULL DEFAULT 0,
    "afterCredentialChangeHours" INTEGER NOT NULL DEFAULT 0,
    "afterNewPayeeHours" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "level_cooloffs_pkey" PRIMARY KEY ("level")
);

-- CreateTable
CREATE TABLE "platform_limits" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "tradingMaxPerDay" DECIMAL(38,18),
    "currency" "LimitCurrency" NOT NULL DEFAULT 'USD',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "platform_limits_pkey" PRIMARY KEY ("id")
);

-- Limits are never negative, and their order makes sense (spec §4.2).
ALTER TABLE "level_rules" ADD CONSTRAINT "level_rules_amounts_nonnegative"
  CHECK (COALESCE("minPerTx", 0) >= 0 AND COALESCE("maxPerTx", 0) >= 0 AND COALESCE("maxPerDay", 0) >= 0);
ALTER TABLE "level_rules" ADD CONSTRAINT "level_rules_min_le_max"
  CHECK ("minPerTx" IS NULL OR "maxPerTx" IS NULL OR "minPerTx" <= "maxPerTx");
ALTER TABLE "level_rules" ADD CONSTRAINT "level_rules_max_le_daily"
  CHECK ("maxPerTx" IS NULL OR "maxPerDay" IS NULL OR "maxPerTx" <= "maxPerDay");
ALTER TABLE "level_cooloffs" ADD CONSTRAINT "level_cooloffs_nonnegative"
  CHECK ("afterSignupHours" >= 0 AND "afterCredentialChangeHours" >= 0 AND "afterNewPayeeHours" >= 0);

-- Seed: reproduce today's behaviour exactly (spec §7.1).
-- None: everything off.
INSERT INTO "level_rules" ("level", "action", "allowed", "currency", "updatedAt", "updatedBy")
SELECT 'NONE', a::"PolicyAction", false, 'NGN', now(), 'migration'
FROM unnest(ARRAY['BUY','SELL','SWAP','CRYPTO_DEPOSIT','CRYPTO_WITHDRAW','NGN_DEPOSIT','NGN_WITHDRAW','GIFTCARD_SELL']) AS a;

-- Basic and Advanced: trading on, $5,000/day (old MAX_USER_DAILY_USD).
INSERT INTO "level_rules" ("level", "action", "allowed", "currency", "maxPerDay", "updatedAt", "updatedBy")
SELECT l::"PolicyLevel", a::"PolicyAction", true, 'USD', 5000, now(), 'migration'
FROM unnest(ARRAY['BASIC','ADVANCED']) AS l, unnest(ARRAY['BUY','SELL','SWAP']) AS a;

-- Crypto deposit, crypto withdrawal and gift cards: on, unlimited (as today).
INSERT INTO "level_rules" ("level", "action", "allowed", "currency", "updatedAt", "updatedBy")
SELECT l::"PolicyLevel", a::"PolicyAction", true, 'NGN', now(), 'migration'
FROM unnest(ARRAY['BASIC','ADVANCED']) AS l, unnest(ARRAY['CRYPTO_DEPOSIT','CRYPTO_WITHDRAW','GIFTCARD_SELL']) AS a;

-- Naira: limits copied from the old tier rows (0 there meant "cannot"; 0 is kept, so nothing changes).
INSERT INTO "level_rules" ("level", "action", "allowed", "currency", "maxPerTx", "maxPerDay", "updatedAt", "updatedBy")
SELECT v.level::"PolicyLevel", v.action::"PolicyAction", true, 'NGN', v.single, v.daily, now(), 'migration'
FROM (
  SELECT 'BASIC' AS level, 'NGN_DEPOSIT' AS action, t."ngnDepositSingle" AS single, t."ngnDepositDaily" AS daily FROM "kyc_tier_limits" t WHERE t."tier" = 'TIER_1'
  UNION ALL SELECT 'BASIC', 'NGN_WITHDRAW', t."ngnWithdrawSingle", t."ngnWithdrawDaily" FROM "kyc_tier_limits" t WHERE t."tier" = 'TIER_1'
  UNION ALL SELECT 'ADVANCED', 'NGN_DEPOSIT', t."ngnDepositSingle", t."ngnDepositDaily" FROM "kyc_tier_limits" t WHERE t."tier" = 'TIER_3'
  UNION ALL SELECT 'ADVANCED', 'NGN_WITHDRAW', t."ngnWithdrawSingle", t."ngnWithdrawDaily" FROM "kyc_tier_limits" t WHERE t."tier" = 'TIER_3'
) v;

-- A naira row missing from kyc_tier_limits: present but capped at 0 (as today: 0 = cannot).
INSERT INTO "level_rules" ("level", "action", "allowed", "currency", "maxPerTx", "maxPerDay", "updatedAt", "updatedBy")
SELECT l::"PolicyLevel", a::"PolicyAction", true, 'NGN', 0, 0, now(), 'migration'
FROM unnest(ARRAY['BASIC','ADVANCED']) AS l, unnest(ARRAY['NGN_DEPOSIT','NGN_WITHDRAW']) AS a
ON CONFLICT ("level", "action") DO NOTHING;

INSERT INTO "level_cooloffs" ("level", "updatedAt", "updatedBy")
SELECT l::"PolicyLevel", now(), 'migration' FROM unnest(ARRAY['NONE','BASIC','ADVANCED']) AS l;

INSERT INTO "platform_limits" ("id", "tradingMaxPerDay", "currency", "updatedAt", "updatedBy")
VALUES ('default', 50000, 'USD', now(), 'migration');

-- Permission rename: kyc.limits -> levels.manage (and levels.view with it).
UPDATE "admin_users"
SET "permissions" = array_append(array_replace("permissions", 'kyc.limits', 'levels.manage'), 'levels.view')
WHERE 'kyc.limits' = ANY("permissions");
