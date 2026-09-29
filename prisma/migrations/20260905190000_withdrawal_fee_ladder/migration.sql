-- AlterEnum
ALTER TYPE "FeeKind" ADD VALUE 'WITHDRAWAL';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "networkFee" DECIMAL(38,18);

