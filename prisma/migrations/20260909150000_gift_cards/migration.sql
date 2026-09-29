-- CreateEnum
CREATE TYPE "GiftCardTradeStatus" AS ENUM ('PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "TxType" ADD VALUE 'GIFT_CARD';

-- CreateTable
CREATE TABLE "gift_card_brand_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "gift_card_brand_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_card_brands" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image" BYTEA,
    "imageType" TEXT,
    "imageUpdatedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "gift_card_brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_card_types" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "minAmount" DECIMAL(38,18) NOT NULL,
    "maxAmount" DECIMAL(38,18) NOT NULL,
    "rateNgn" DECIMAL(38,18) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "gift_card_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_card_trades" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "faceValue" DECIMAL(38,18) NOT NULL,
    "currency" TEXT NOT NULL,
    "rateNgn" DECIMAL(38,18) NOT NULL,
    "expectedNgn" DECIMAL(38,18) NOT NULL,
    "codeSealed" TEXT,
    "status" "GiftCardTradeStatus" NOT NULL DEFAULT 'PENDING',
    "approvedValue" DECIMAL(38,18),
    "approvedRateNgn" DECIMAL(38,18),
    "actualRateNgn" DECIMAL(38,18),
    "creditedNgn" DECIMAL(38,18),
    "profitNgn" DECIMAL(38,18),
    "reason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gift_card_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_card_trade_images" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "image" BYTEA NOT NULL,
    "imageType" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_card_trade_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gift_card_brand_categories_name_key" ON "gift_card_brand_categories"("name");

-- CreateIndex
CREATE INDEX "gift_card_brand_categories_isActive_name_idx" ON "gift_card_brand_categories"("isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "gift_card_brands_name_key" ON "gift_card_brands"("name");

-- CreateIndex
CREATE INDEX "gift_card_brands_categoryId_isActive_idx" ON "gift_card_brands"("categoryId", "isActive");

-- CreateIndex
CREATE INDEX "gift_card_types_isActive_idx" ON "gift_card_types"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "gift_card_types_brandId_name_key" ON "gift_card_types"("brandId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "gift_card_trades_transactionId_key" ON "gift_card_trades"("transactionId");

-- CreateIndex
CREATE INDEX "gift_card_trades_userId_createdAt_idx" ON "gift_card_trades"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "gift_card_trades_status_createdAt_idx" ON "gift_card_trades"("status", "createdAt");

-- CreateIndex
CREATE INDEX "gift_card_trade_images_tradeId_sortOrder_idx" ON "gift_card_trade_images"("tradeId", "sortOrder");

-- AddForeignKey
ALTER TABLE "gift_card_brands" ADD CONSTRAINT "gift_card_brands_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "gift_card_brand_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_card_types" ADD CONSTRAINT "gift_card_types_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "gift_card_brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_card_trades" ADD CONSTRAINT "gift_card_trades_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_card_trades" ADD CONSTRAINT "gift_card_trades_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "gift_card_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_card_trades" ADD CONSTRAINT "gift_card_trades_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_card_trade_images" ADD CONSTRAINT "gift_card_trade_images_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "gift_card_trades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

