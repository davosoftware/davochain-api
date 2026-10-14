-- CreateEnum
CREATE TYPE "AmlStatus" AS ENUM ('NOT_SCREENED', 'PENDING', 'CLEAR', 'UNDER_REVIEW', 'RESTRICTED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "KycIdType" AS ENUM ('BVN', 'NIN');

-- CreateEnum
CREATE TYPE "KycVerificationState" AS ENUM ('CREATED', 'LOOKED_UP', 'APPROVED', 'IDENTITY_REVIEW', 'COMPLIANCE_REVIEW', 'REJECTED_NOT_FOUND', 'REJECTED_BY_REVIEW', 'FAILED_SYSTEM');

-- CreateEnum
CREATE TYPE "DojahCallOutcome" AS ENUM ('IN_FLIGHT', 'SUCCEEDED', 'DEFINITELY_FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AmlScreeningStatus" AS ENUM ('PENDING', 'CLEAR', 'POSSIBLE_MATCH', 'CONFIRMED_MATCH', 'UNKNOWN', 'ERROR');

-- CreateEnum
CREATE TYPE "AmlCaseStatus" AS ENUM ('OPEN', 'CLEARANCE_PROPOSED', 'CLEARED', 'PEP_APPROVED_EDD', 'RESTRICTED', 'SANCTIONS_CONFIRMED', 'SANCTIONS_FALSE_POSITIVE');

-- CreateEnum
CREATE TYPE "AmlCaseCategory" AS ENUM ('SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'WARNING', 'UNKNOWN', 'ERROR');

-- CreateEnum
CREATE TYPE "AmlCasePriority" AS ENUM ('CRITICAL', 'HIGH', 'NORMAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AlertType" ADD VALUE 'DOJAH_CONFIG';
ALTER TYPE "AlertType" ADD VALUE 'AML_REVIEW';
ALTER TYPE "AlertType" ADD VALUE 'AML_SANCTIONS';

-- AlterTable
ALTER TABLE "kyc_profiles" ADD COLUMN     "lga" TEXT,
ADD COLUMN     "postcode" TEXT,
ADD COLUMN     "stateOfOrigin" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "amlStatus" "AmlStatus" NOT NULL DEFAULT 'NOT_SCREENED';

-- CreateTable
CREATE TABLE "kyc_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeFor" TEXT,
    "state" "KycVerificationState" NOT NULL DEFAULT 'CREATED',
    "lagosDay" TEXT NOT NULL,
    "idType" "KycIdType" NOT NULL,
    "idHash" TEXT NOT NULL,
    "idLast4" TEXT NOT NULL,
    "typedFirstName" TEXT NOT NULL,
    "typedMiddleName" TEXT,
    "typedLastName" TEXT NOT NULL,
    "typedDateOfBirth" TEXT NOT NULL,
    "typedAddress" JSONB NOT NULL,
    "recordFirstName" TEXT,
    "recordMiddleName" TEXT,
    "recordLastName" TEXT,
    "recordDateOfBirth" TEXT,
    "recordGender" TEXT,
    "recordUsable" BOOLEAN,
    "match" JSONB,
    "reviewReason" TEXT,
    "providerCustomerRef" TEXT,
    "lookupOutcome" "DojahCallOutcome",
    "lookupHttpStatus" INTEGER,
    "lookupStartedAt" TIMESTAMP(3),
    "lookupCompletedAt" TIMESTAMP(3),
    "possiblyCharged" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "screeningId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aml_screenings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "status" "AmlScreeningStatus" NOT NULL DEFAULT 'PENDING',
    "matchStatus" TEXT,
    "riskLevel" TEXT,
    "entityId" TEXT,
    "matches" JSONB,
    "category" TEXT,
    "callOutcome" "DojahCallOutcome",
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "unknownCount" INTEGER NOT NULL DEFAULT 0,
    "definiteFailCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "screenStartedAt" TIMESTAMP(3),
    "screenCompletedAt" TIMESTAMP(3),
    "possibleDuplicateCharge" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aml_screenings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aml_review_cases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "screeningId" TEXT NOT NULL,
    "status" "AmlCaseStatus" NOT NULL DEFAULT 'OPEN',
    "category" "AmlCaseCategory" NOT NULL,
    "priority" "AmlCasePriority" NOT NULL,
    "possible" BOOLEAN NOT NULL DEFAULT false,
    "riskLevel" TEXT,
    "entityId" TEXT,
    "matches" JSONB,
    "rescreenCount" INTEGER NOT NULL DEFAULT 0,
    "rescreenResult" "AmlScreeningStatus",
    "proposedBy" TEXT,
    "proposedAt" TIMESTAMP(3),
    "proposalReason" TEXT,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "reportedToAuthority" BOOLEAN,
    "reportReference" TEXT,
    "reportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aml_review_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kyc_verifications_activeFor_key" ON "kyc_verifications"("activeFor");

-- CreateIndex
CREATE INDEX "kyc_verifications_userId_createdAt_idx" ON "kyc_verifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "kyc_verifications_state_createdAt_idx" ON "kyc_verifications"("state", "createdAt");

-- CreateIndex
CREATE INDEX "kyc_verifications_lookupOutcome_lookupStartedAt_idx" ON "kyc_verifications"("lookupOutcome", "lookupStartedAt");

-- CreateIndex
CREATE INDEX "aml_screenings_callOutcome_screenStartedAt_idx" ON "aml_screenings"("callOutcome", "screenStartedAt");

-- CreateIndex
CREATE INDEX "aml_screenings_status_nextAttemptAt_idx" ON "aml_screenings"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "aml_screenings_userId_inputFingerprint_key" ON "aml_screenings"("userId", "inputFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "aml_review_cases_screeningId_key" ON "aml_review_cases"("screeningId");

-- CreateIndex
CREATE INDEX "aml_review_cases_status_priority_createdAt_idx" ON "aml_review_cases"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "aml_review_cases_userId_idx" ON "aml_review_cases"("userId");

-- AddForeignKey
ALTER TABLE "kyc_verifications" ADD CONSTRAINT "kyc_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_verifications" ADD CONSTRAINT "kyc_verifications_screeningId_fkey" FOREIGN KEY ("screeningId") REFERENCES "aml_screenings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aml_review_cases" ADD CONSTRAINT "aml_review_cases_screeningId_fkey" FOREIGN KEY ("screeningId") REFERENCES "aml_screenings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Two people, always: the confirmer of a sanctions clearance is never its proposer (spec §14.1).
ALTER TABLE "aml_review_cases"
  ADD CONSTRAINT "aml_case_confirmer_differs"
  CHECK ("confirmedBy" IS NULL OR "proposedBy" IS NULL OR "confirmedBy" <> "proposedBy");

-- The actor for automatic actions in admin_audit_log (plan ruling 7). It can never sign in:
-- inactive, and '!' is not a password hash anything can match.
INSERT INTO "admin_users" ("id", "email", "passwordHash", "name", "isActive", "role", "permissions", "createdAt", "passwordChangedAt", "failedLogins")
VALUES ('00000000-0000-0000-0000-000000000001', 'system@davochain.invalid', '!', 'System', false, 'SUB_ADMIN', '{}', now(), now(), 0)
ON CONFLICT ("id") DO NOTHING;
