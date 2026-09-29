-- AlterTable
ALTER TABLE "users" ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedBy" TEXT,
ADD COLUMN     "suspendedReason" TEXT;
