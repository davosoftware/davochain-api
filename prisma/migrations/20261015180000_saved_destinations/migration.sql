-- AlterTable
ALTER TABLE "platform_limits" ADD COLUMN     "maxSavedBankAccounts" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "maxSavedCryptoAddresses" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "savedBankAccountId" TEXT,
ADD COLUMN     "savedCryptoAddressId" TEXT;

-- CreateTable
CREATE TABLE "saved_bank_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "nickname" TEXT,
    "usableFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,

    CONSTRAINT "saved_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_crypto_addresses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "destinationTag" TEXT,
    "nickname" TEXT,
    "usableFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,

    CONSTRAINT "saved_crypto_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_bank_accounts_userId_removedAt_idx" ON "saved_bank_accounts"("userId", "removedAt");

-- CreateIndex
CREATE INDEX "saved_crypto_addresses_userId_removedAt_idx" ON "saved_crypto_addresses"("userId", "removedAt");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_savedBankAccountId_fkey" FOREIGN KEY ("savedBankAccountId") REFERENCES "saved_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_savedCryptoAddressId_fkey" FOREIGN KEY ("savedCryptoAddressId") REFERENCES "saved_crypto_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_bank_accounts" ADD CONSTRAINT "saved_bank_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_crypto_addresses" ADD CONSTRAINT "saved_crypto_addresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- No duplicates among live (not removed) rows; a removed destination can be saved again.
CREATE UNIQUE INDEX "saved_bank_accounts_live_key" ON "saved_bank_accounts" ("userId", "bankCode", "accountNumber") WHERE "removedAt" IS NULL;
CREATE UNIQUE INDEX "saved_crypto_addresses_live_key" ON "saved_crypto_addresses" ("userId", "assetCode", "networkId", "address", coalesce("destinationTag", '')) WHERE "removedAt" IS NULL;

-- A Nigerian account number is exactly 10 digits; each cap is at least 1.
ALTER TABLE "saved_bank_accounts" ADD CONSTRAINT "saved_bank_accounts_number_chk" CHECK ("accountNumber" ~ '^[0-9]{10}$');
ALTER TABLE "platform_limits" ADD CONSTRAINT "platform_limits_saved_caps_chk" CHECK ("maxSavedBankAccounts" >= 1 AND "maxSavedCryptoAddresses" >= 1);
