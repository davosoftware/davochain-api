-- Profile photo: avatars/<avatarId>.webp in R2, served at /v1/avatars/<avatarId> (29 Oct 2026).
ALTER TABLE "users" ADD COLUMN "avatarId" TEXT,
ADD COLUMN "avatarUpdatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_avatarId_key" ON "users"("avatarId");
