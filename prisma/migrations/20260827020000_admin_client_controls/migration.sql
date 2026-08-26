ALTER TABLE "User" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "customEventLimit" INTEGER;
ALTER TABLE "User" ADD COLUMN "customStorageLimitBytes" BIGINT;
