-- The band boundaries are no longer always dollars.
--
-- Three ladders price a coin and band in dollars; the naira cash-out ladder
-- bands in naira. Pegging a naira band to a dollar amount meant a ₦50,000
-- withdrawal could change what it costs because the exchange rate moved, which
-- is not a fee anybody agreed to.
ALTER TABLE "fee_bands" RENAME COLUMN "minUsd" TO "minAmount";
ALTER TABLE "fee_bands" RENAME COLUMN "maxUsd" TO "maxAmount";

-- Any naira ladder configured before this was entered as dollars and cannot be
-- reinterpreted — "50" meant fifty dollars and now means fifty naira. Removing
-- them is the honest move: an admin sets the ladder again in the currency the
-- screen now asks for, rather than inheriting numbers that mean something else.
--
-- The other three ladders are untouched: their bands were dollars and still are.
DELETE FROM "fee_bands"
WHERE "scheduleId" IN (SELECT "id" FROM "fee_schedules" WHERE "kind" = 'NGN_WITHDRAWAL');
DELETE FROM "fee_schedules" WHERE "kind" = 'NGN_WITHDRAWAL';
