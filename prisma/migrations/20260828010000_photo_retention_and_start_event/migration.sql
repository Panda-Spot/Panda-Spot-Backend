ALTER TABLE "Event" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "customPhotoRetentionDays" INTEGER;
ALTER TABLE "Photo" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE "Photo" ADD COLUMN "originalExpiresAt" TIMESTAMP(3);

-- Grandfather every existing event in as already-started, so nobody's
-- current in-progress event suddenly loses its upload button.
UPDATE "Event" SET "startedAt" = "createdAt" WHERE "startedAt" IS NULL;

-- Best-effort backfill of how each existing photo arrived. Can't
-- retroactively distinguish an old PandaShoots-local capture from a plain
-- direct upload with the fields available (both just have storagePath
-- set, driveFileId null) — a one-time approximation, not a data-loss risk
-- either way since it's purely a display/filter categorization.
UPDATE "Photo" SET "source" = 'drive_import'
  WHERE "driveFileId" IS NOT NULL AND "platformDriveBackup" = false;

-- The new platform-wide retention clock's one-time grace period: every
-- existing photo with a local original not already governed by the
-- separate (stricter) Drive-backup lifecycle gets its clock reset to start
-- counting from right now, so nothing already on the platform is deleted
-- the instant this ships.
UPDATE "Photo" SET "originalExpiresAt" = NOW() + INTERVAL '7 days'
  WHERE "storagePath" IS NOT NULL AND "platformDriveBackup" = false;
