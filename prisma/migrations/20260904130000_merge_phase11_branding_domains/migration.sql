-- Phase 11 (branding, themes, subdomains, custom domains). Additive
-- only: theme + domain tables, slug/default-theme wiring. No backfill —
-- studios claim slugs and pick themes going forward; everything resolves
-- to the built-in default until they do.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "studioSlug" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "defaultGalleryThemeId" TEXT;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS "User_studioSlug_key" ON "User"("studioSlug");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "GalleryTheme" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT,
  "name" TEXT NOT NULL,
  "preset" TEXT NOT NULL DEFAULT 'custom',
  "primaryColor" TEXT NOT NULL DEFAULT '#D4AF37',
  "accentColor" TEXT NOT NULL DEFAULT '#D4AF37',
  "backgroundColor" TEXT NOT NULL DEFAULT '#0A0A0B',
  "textColor" TEXT NOT NULL DEFAULT '#F5F1E8',
  "fontFamily" TEXT NOT NULL DEFAULT 'sans',
  "buttonStyle" TEXT NOT NULL DEFAULT 'rounded',
  "galleryLayout" TEXT NOT NULL DEFAULT 'grid',
  "watermarkStyle" TEXT NOT NULL DEFAULT 'text',
  "hidePandaSpotBrand" BOOLEAN NOT NULL DEFAULT false,
  "customShareCard" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GalleryTheme_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "GalleryTheme_ownerId_idx" ON "GalleryTheme"("ownerId");
DO $$ BEGIN
  ALTER TABLE "GalleryTheme" ADD CONSTRAINT "GalleryTheme_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "User" ADD CONSTRAINT "User_defaultGalleryThemeId_fkey"
    FOREIGN KEY ("defaultGalleryThemeId") REFERENCES "GalleryTheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "galleryThemeId" TEXT;
DO $$ BEGIN
  ALTER TABLE "Event" ADD CONSTRAINT "Event_galleryThemeId_fkey"
    FOREIGN KEY ("galleryThemeId") REFERENCES "GalleryTheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "StudioDomain" (
  "id" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "verificationToken" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudioDomain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StudioDomain_host_key" ON "StudioDomain"("host");
CREATE INDEX IF NOT EXISTS "StudioDomain_ownerId_idx" ON "StudioDomain"("ownerId");
DO $$ BEGIN
  ALTER TABLE "StudioDomain" ADD CONSTRAINT "StudioDomain_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
