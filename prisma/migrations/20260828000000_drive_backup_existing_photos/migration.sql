ALTER TABLE "Photo" ADD COLUMN "driveBackupStartedAt" TIMESTAMP(3);

-- Already-in-flight PandaShoots-to-Drive backups keep their existing
-- effective clock (capture time was backup time for those) instead of
-- suddenly looking like they've never started.
UPDATE "Photo" SET "driveBackupStartedAt" = "createdAt" WHERE "platformDriveBackup" = true;
