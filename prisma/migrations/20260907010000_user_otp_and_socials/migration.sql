-- CreateEnum
CREATE TYPE "UserOtpPurpose" AS ENUM ('PASSWORD_RESET');

-- CreateTable
CREATE TABLE "user_otps" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "UserOtpPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_links" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "icon" BYTEA,
    "iconType" TEXT,
    "iconUpdatedAt" TIMESTAMP(3),
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_otps_userId_purpose_consumedAt_idx" ON "user_otps"("userId", "purpose", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "social_links_label_key" ON "social_links"("label");

-- CreateIndex
CREATE INDEX "social_links_isEnabled_sortOrder_idx" ON "social_links"("isEnabled", "sortOrder");

-- AddForeignKey
ALTER TABLE "user_otps" ADD CONSTRAINT "user_otps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

