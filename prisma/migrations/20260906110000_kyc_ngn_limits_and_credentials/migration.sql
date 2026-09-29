-- AlterTable
ALTER TABLE "kyc_tier_limits" ADD COLUMN     "ngnDepositDaily" DECIMAL(38,18) NOT NULL DEFAULT 0,
ADD COLUMN     "ngnDepositSingle" DECIMAL(38,18) NOT NULL DEFAULT 0,
ADD COLUMN     "ngnWithdrawDaily" DECIMAL(38,18) NOT NULL DEFAULT 0,
ADD COLUMN     "ngnWithdrawSingle" DECIMAL(38,18) NOT NULL DEFAULT 0,
ADD COLUMN     "updatedBy" TEXT;

-- CreateTable
CREATE TABLE "integration_credentials" (
    "name" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "last4" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("name")
);

