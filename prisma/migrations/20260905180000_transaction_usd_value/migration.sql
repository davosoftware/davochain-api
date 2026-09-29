-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "feeUsd" DECIMAL(38,18),
ADD COLUMN     "usdValue" DECIMAL(38,18);

-- Backfill what can be known exactly.
--
-- A naira trade stores the rate it settled at, in naira per dollar, so its
-- dollar value is arithmetic on figures already in the row. Nothing is
-- estimated and no price is looked up — a repriced history would answer "what
-- would this be worth today", which is not what a record of what moved means.
UPDATE "transactions"
SET "usdValue" = "fromAmount" / "displayedRate"
WHERE "type" = 'BUY'
  AND "fromAsset" = 'ngn'
  AND "displayedRate" IS NOT NULL
  AND "displayedRate" > 0
  AND "fromAmount" IS NOT NULL;

UPDATE "transactions"
SET "usdValue" = "toAmount" / "displayedRate"
WHERE "type" = 'SELL'
  AND "toAsset" = 'ngn'
  AND "displayedRate" IS NOT NULL
  AND "displayedRate" > 0
  AND "toAmount" IS NOT NULL;

-- Swaps and transfers are left null on purpose: their dollar value was never
-- recorded, and inventing one now would put a number on the dashboard that no
-- row in this database supports. New ones carry it from the quote.
