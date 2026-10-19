-- AlterTable
ALTER TABLE "gift_card_trade_images" ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "storageKey" TEXT,
ALTER COLUMN "image" DROP NOT NULL;

-- AlterTable
ALTER TABLE "kyc_documents" ADD COLUMN     "serverStored" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sha256" TEXT;

-- CreateTable
CREATE TABLE "pending_uploads" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_uploads_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "pending_uploads_createdAt_idx" ON "pending_uploads"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "gift_card_trade_images_storageKey_key" ON "gift_card_trade_images"("storageKey");

-- CreateIndex
CREATE INDEX "kyc_documents_kycProfileId_sha256_idx" ON "kyc_documents"("kycProfileId", "sha256");


-- A photo lives in exactly one place: the old bytes column or the file store.
ALTER TABLE "gift_card_trade_images" ADD CONSTRAINT "gift_card_trade_images_one_source" CHECK (("image" IS NULL) <> ("storageKey" IS NULL));
