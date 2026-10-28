-- Broadcasts are sent by a background worker, in waves (29 Oct 2026).
CREATE TYPE "BroadcastStatus" AS ENUM ('QUEUED', 'SENDING', 'PAUSED', 'CANCELLED', 'DONE');

-- Broadcasts sent before this were sent in full at once: they are DONE.
ALTER TABLE "broadcasts" ADD COLUMN "status" "BroadcastStatus" NOT NULL DEFAULT 'DONE',
ADD COLUMN "withEmail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "userIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "cursor" TEXT,
ADD COLUMN "processedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pushSentCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pushFailedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "emailQueuedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "startedAt" TIMESTAMP(3),
ADD COLUMN "finishedAt" TIMESTAMP(3),
ADD COLUMN "controlledBy" TEXT;

UPDATE "broadcasts" SET "processedCount" = "recipientCount", "finishedAt" = "createdAt";

ALTER TABLE "broadcasts" ALTER COLUMN "status" SET DEFAULT 'QUEUED';
