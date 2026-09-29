-- AlterEnum
ALTER TYPE "FeeKind" ADD VALUE 'NGN_WITHDRAWAL';

-- CreateTable
CREATE TABLE "site_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "companyName" TEXT NOT NULL DEFAULT 'Davochain',
    "supportEmail" TEXT NOT NULL DEFAULT 'support@davochain.com',
    "phone" TEXT,
    "address" TEXT,
    "iosVersion" TEXT,
    "androidVersion" TEXT,
    "iosStoreUrl" TEXT,
    "androidStoreUrl" TEXT,
    "maintenanceMode" BOOLEAN NOT NULL DEFAULT false,
    "maintenanceMessage" TEXT,
    "facebook" TEXT,
    "twitter" TEXT,
    "instagram" TEXT,
    "linkedin" TEXT,
    "youtube" TEXT,
    "tiktok" TEXT,
    "logo" BYTEA,
    "logoType" TEXT,
    "logoUpdatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

