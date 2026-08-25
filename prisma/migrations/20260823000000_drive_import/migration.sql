-- AlterTable: storagePath becomes nullable (Drive-imported photos never
-- have a local original), driveFileId added for re-fetching on demand.
ALTER TABLE "Photo" ALTER COLUMN "storagePath" DROP NOT NULL;
ALTER TABLE "Photo" ADD COLUMN "driveFileId" TEXT;
