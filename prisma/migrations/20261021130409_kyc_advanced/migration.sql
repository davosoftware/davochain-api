-- CreateEnum
CREATE TYPE "AdvancedStep" AS ENUM ('IDENTITY', 'ADDRESS');

-- CreateEnum
CREATE TYPE "AdvancedState" AS ENUM ('CHECKING', 'APPROVED', 'IN_REVIEW', 'REJECTED', 'FAILED_SYSTEM');

-- CreateEnum
CREATE TYPE "AdvancedIdType" AS ENUM ('NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE');

-- CreateEnum
CREATE TYPE "AddressKind" AS ENUM ('UTILITY_BILL', 'BANK_STATEMENT', 'GOVERNMENT_LETTER', 'TENANCY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "KycDocumentType" ADD VALUE 'NATIONAL_ID';
ALTER TYPE "KycDocumentType" ADD VALUE 'ID_BACK';

-- CreateTable
CREATE TABLE "advanced_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "step" "AdvancedStep" NOT NULL,
    "activeFor" TEXT,
    "lagosDay" TEXT NOT NULL,
    "state" "AdvancedState" NOT NULL DEFAULT 'CHECKING',
    "idType" "AdvancedIdType",
    "addressKind" "AddressKind",
    "frontDocumentId" TEXT,
    "backDocumentId" TEXT,
    "selfieDocumentId" TEXT,
    "addressDocumentId" TEXT,
    "docHash" TEXT,
    "docLast4" TEXT,
    "docDateOfBirth" TEXT,
    "readOutcome" "DojahCallOutcome",
    "readStartedAt" TIMESTAMP(3),
    "readSends" INTEGER NOT NULL DEFAULT 0,
    "readHttpStatus" INTEGER,
    "livenessOutcome" "DojahCallOutcome",
    "livenessStartedAt" TIMESTAMP(3),
    "livenessSends" INTEGER NOT NULL DEFAULT 0,
    "livenessHttpStatus" INTEGER,
    "matchOutcome" "DojahCallOutcome",
    "matchStartedAt" TIMESTAMP(3),
    "matchSends" INTEGER NOT NULL DEFAULT 0,
    "matchHttpStatus" INTEGER,
    "addressOutcome" "DojahCallOutcome",
    "addressStartedAt" TIMESTAMP(3),
    "addressSends" INTEGER NOT NULL DEFAULT 0,
    "addressHttpStatus" INTEGER,
    "findings" JSONB NOT NULL DEFAULT '{}',
    "reviewReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rejectCode" TEXT,
    "customerMessage" TEXT,
    "possiblyCharged" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "advanced_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "advanced_verifications_activeFor_key" ON "advanced_verifications"("activeFor");

-- CreateIndex
CREATE INDEX "advanced_verifications_userId_step_state_idx" ON "advanced_verifications"("userId", "step", "state");

-- CreateIndex
CREATE INDEX "advanced_verifications_state_createdAt_idx" ON "advanced_verifications"("state", "createdAt");

-- CreateIndex
CREATE INDEX "advanced_verifications_docHash_idx" ON "advanced_verifications"("docHash");

-- AddForeignKey
ALTER TABLE "advanced_verifications" ADD CONSTRAINT "advanced_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

