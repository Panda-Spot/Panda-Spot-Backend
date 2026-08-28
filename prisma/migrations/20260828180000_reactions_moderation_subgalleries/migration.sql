ALTER TABLE "Event" ADD COLUMN "guestUploadEnabledAt" TIMESTAMP(3);
ALTER TABLE "Event" ADD COLUMN "guestUploadWindowDays" INTEGER;
ALTER TABLE "Event" ADD COLUMN "parentEventId" TEXT;

ALTER TABLE "Event" ADD CONSTRAINT "Event_parentEventId_fkey"
  FOREIGN KEY ("parentEventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Event_parentEventId_idx" ON "Event"("parentEventId");

ALTER TABLE "Photo" ADD COLUMN "moderationFlagged" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PhotoLike" ADD COLUMN "reactionType" TEXT NOT NULL DEFAULT 'heart';

-- Any event that already has guestUploadEnabled=true (turned on before
-- this migration) gets guestUploadEnabledAt backfilled to now, so
-- guestUploadWindowDays (currently null for everyone, meaning "no
-- separate window yet") has a sane anchor if an owner sets one later.
UPDATE "Event" SET "guestUploadEnabledAt" = NOW() WHERE "guestUploadEnabled" = true;
