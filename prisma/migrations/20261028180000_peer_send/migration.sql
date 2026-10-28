-- Coins sent to another DavoChain customer's address move inside DavoChain (28 Oct 2026).
ALTER TYPE "SettlementLegKind" ADD VALUE 'PEER_TRANSFER';

ALTER TABLE "transactions" ADD COLUMN "peerUserId" TEXT;

CREATE INDEX "transactions_peerUserId_idx" ON "transactions"("peerUserId");
