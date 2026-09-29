-- AlterTable
ALTER TABLE "email_templates" ADD COLUMN     "image" BYTEA,
ADD COLUMN     "imageAlt" TEXT,
ADD COLUMN     "imageType" TEXT,
ADD COLUMN     "imageUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "site_settings" ADD COLUMN     "emailAddressLine" TEXT,
ADD COLUMN     "emailLegalName" TEXT,
ADD COLUMN     "emailOptInNote" TEXT,
ADD COLUMN     "emailUnsubscribeNote" TEXT,
ADD COLUMN     "emailUnsubscribeUrl" TEXT;

