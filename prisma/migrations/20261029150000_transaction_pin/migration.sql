-- Transaction PIN: asked for before money leaves the wallet or a swap runs (29 Oct 2026).
ALTER TABLE "users" ADD COLUMN "transactionPinHash" TEXT,
ADD COLUMN "transactionPinSetAt" TIMESTAMP(3),
ADD COLUMN "pinFailedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pinLockedUntil" TIMESTAMP(3);

ALTER TYPE "UserOtpPurpose" ADD VALUE 'PIN_RESET';
