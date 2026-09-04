-- Phase 4 (dedicated album proofing core): audit + spread metadata.
-- Additive only; existing rows keep working with nulls.
ALTER TABLE "Album" ADD COLUMN IF NOT EXISTS "createdById" TEXT;
ALTER TABLE "Album" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3);
DO $$ BEGIN
  ALTER TABLE "Album" ADD CONSTRAINT "Album_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "AlbumPage" ADD COLUMN IF NOT EXISTS "width" INTEGER;
ALTER TABLE "AlbumPage" ADD COLUMN IF NOT EXISTS "height" INTEGER;
