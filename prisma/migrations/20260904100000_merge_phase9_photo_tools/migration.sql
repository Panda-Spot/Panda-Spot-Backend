-- Phase 9 (photography tools pack). Additive only: analysis + curation
-- columns on Photo, all nullable/defaulted so existing rows just show
-- "not analyzed yet" until the tools job runs.
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "fileHash" TEXT;
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "sharpness" DOUBLE PRECISION;
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "exifCamera" TEXT;
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "exifLens" TEXT;
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "exifIso" INTEGER;
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "exifShutter" TEXT;
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "exifAperture" TEXT;
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "exifCapturedAt" TIMESTAMP(3);
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "colorTag" TEXT;
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "rating" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "Photo_eventId_fileHash_idx" ON "Photo"("eventId", "fileHash");
