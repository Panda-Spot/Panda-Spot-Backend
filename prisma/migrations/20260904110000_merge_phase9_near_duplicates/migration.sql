-- Phase 9 (near-duplicate detection). Additive only: perceptual hash
-- column; existing rows group once the analyze job fills it in.
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "phash" TEXT;
CREATE INDEX IF NOT EXISTS "Photo_eventId_phash_idx" ON "Photo"("eventId", "phash");
