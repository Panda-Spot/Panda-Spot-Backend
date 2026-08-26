ALTER TABLE "User" DROP COLUMN "driveBackupRefreshToken";
ALTER TABLE "Event" ADD COLUMN "lastBeamCaptureAt" TIMESTAMP(3);
ALTER TABLE "Event" ADD COLUMN "driveBackupNoticeSentAt" TIMESTAMP(3);
ALTER TABLE "Photo" ADD COLUMN "platformDriveBackup" BOOLEAN NOT NULL DEFAULT false;
