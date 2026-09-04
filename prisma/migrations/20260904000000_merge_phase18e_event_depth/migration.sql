-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "coverPhotoPath" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "eventDate" TIMESTAMP(3),
ADD COLUMN     "eventVenue" TEXT;

-- AlterTable
ALTER TABLE "EventUserMapping" ADD COLUMN     "accessExpires" TIMESTAMP(3),
ADD COLUMN     "revokedAt" TIMESTAMP(3);

