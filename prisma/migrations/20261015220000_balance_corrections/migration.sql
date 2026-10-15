-- AlterEnum
ALTER TYPE "LedgerAccount" ADD VALUE 'ADJUSTMENT';

-- AlterEnum
ALTER TYPE "TxType" ADD VALUE 'ADJUSTMENT';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "adjustedBy" TEXT,
ADD COLUMN     "adjustmentReason" TEXT;

