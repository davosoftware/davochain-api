-- An owner can close a customer's account (28 Oct 2026). The records stay;
-- the email and phone are released, with the originals kept here.
ALTER TABLE "users" ADD COLUMN "closedAt" TIMESTAMP(3),
ADD COLUMN "closedReason" TEXT,
ADD COLUMN "closedBy" TEXT,
ADD COLUMN "closedEmail" TEXT,
ADD COLUMN "closedPhone" TEXT;
