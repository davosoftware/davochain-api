-- Crypto addresses (spec 2026-10-26): stuck alert, made-in-advance switch and marker.
ALTER TYPE "AlertType" ADD VALUE 'CRYPTO_ADDRESS_STUCK';
ALTER TABLE "asset_networks" ADD COLUMN "autoCreate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deposit_addresses" ADD COLUMN "autoCreated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "deposit_addresses" ADD COLUMN "failedAt" TIMESTAMP(3);
-- The owner's choice (26 Oct): BTC, USDT on Tron, USDT on BNB Smart Chain.
UPDATE "asset_networks" SET "autoCreate" = true
  WHERE ("assetCode", "networkId") IN (('btc', 'btc'), ('usdt', 'trc20'), ('usdt', 'bep20'));
