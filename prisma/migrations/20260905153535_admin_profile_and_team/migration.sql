-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "avatar" BYTEA,
ADD COLUMN     "avatarType" TEXT,
ADD COLUMN     "avatarUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
