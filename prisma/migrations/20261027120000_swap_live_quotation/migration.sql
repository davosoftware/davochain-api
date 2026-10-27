-- Swap pricing (27 Oct 2026): a swap quote keeps the Quidax swap quotation it was priced from, so the swap confirms that same quotation.
ALTER TABLE "rate_quotes" ADD COLUMN "quidaxQuotationId" TEXT;
ALTER TABLE "rate_quotes" ADD COLUMN "quidaxQuotationExpiresAt" TIMESTAMP(3);
