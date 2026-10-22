-- H9 (plan 2026-10-22 Task 4): email verification before money.
ALTER TYPE "UserOtpPurpose" ADD VALUE 'EMAIL_VERIFY';
-- Accounts that existed before email verification count as verified (nobody is locked out).
UPDATE "users" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;
