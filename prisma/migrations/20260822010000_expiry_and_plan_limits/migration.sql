-- AlterTable: Photo.fileSize (bytes, used for the per-event storage cap)
ALTER TABLE "Photo" ADD COLUMN "fileSize" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: Event.expiresAt — added nullable, backfilled, then made NOT NULL
-- so this is safe whether the table is empty or already has rows.
ALTER TABLE "Event" ADD COLUMN "expiresAt" TIMESTAMP(3);
UPDATE "Event" SET "expiresAt" = "createdAt" + INTERVAL '90 days' WHERE "expiresAt" IS NULL;
ALTER TABLE "Event" ALTER COLUMN "expiresAt" SET NOT NULL;
