ALTER TABLE "User" ADD COLUMN "driveBackupRefreshToken" TEXT;
ALTER TABLE "Event" ADD COLUMN "driveBackupEnabled" BOOLEAN NOT NULL DEFAULT false;
