-- Payment usernames: send crypto to another DavoChain customer by name (28 Oct 2026).
ALTER TABLE "users" ADD COLUMN "payUsername" TEXT,
ADD COLUMN "payUsernameSetAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_payUsername_key" ON "users"("payUsername");

CREATE TABLE "pay_username_holds" (
    "username" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "heldUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_username_holds_pkey" PRIMARY KEY ("username")
);

CREATE INDEX "pay_username_holds_heldUntil_idx" ON "pay_username_holds"("heldUntil");
