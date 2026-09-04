-- Phase 8 (live TV wall + slideshow polish). Additive only: TV settings
-- + sponsor branding on Event (safe on-air defaults), highlight flag on
-- Photo (off for everything existing).
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "tvMode" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "tvTransitionMs" INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "tvShowQr" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "sponsorName" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "sponsorLogoPath" TEXT;
ALTER TABLE "Photo" ADD COLUMN IF NOT EXISTS "highlighted" BOOLEAN NOT NULL DEFAULT false;
