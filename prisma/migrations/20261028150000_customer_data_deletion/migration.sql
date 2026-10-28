-- A closed customer's personal data can be deleted now or on a set day (28 Oct 2026).
ALTER TABLE "users" ADD COLUMN "dataDeleteAt" TIMESTAMP(3),
ADD COLUMN "dataDeletedAt" TIMESTAMP(3);

CREATE INDEX "users_dataDeleteAt_idx" ON "users"("dataDeleteAt");
