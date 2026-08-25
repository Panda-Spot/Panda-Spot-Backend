ALTER TABLE "Event" ADD COLUMN "ftpUsername" TEXT;
ALTER TABLE "Event" ADD COLUMN "ftpPassword" TEXT;
CREATE UNIQUE INDEX "Event_ftpUsername_key" ON "Event"("ftpUsername");
