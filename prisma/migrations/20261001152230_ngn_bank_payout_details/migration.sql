-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "payoutAccountLast4" TEXT,
ADD COLUMN     "payoutBankCode" TEXT,
ADD COLUMN     "payoutBankName" TEXT;
