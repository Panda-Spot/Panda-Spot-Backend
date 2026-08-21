-- AlterTable: studio-wide branding on User
ALTER TABLE "User" ADD COLUMN "studioName" TEXT;
ALTER TABLE "User" ADD COLUMN "logoPath" TEXT;
ALTER TABLE "User" ADD COLUMN "brandColor" TEXT;

-- AlterTable: per-event adjustable match threshold
ALTER TABLE "Event" ADD COLUMN "matchThreshold" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "GuestSearch" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "embedding" vector(512) NOT NULL,
    "facesDetected" INTEGER NOT NULL,
    "matchCount" INTEGER NOT NULL,
    "guestClientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchFeedback" (
    "id" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZipDownload" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "photoIds" JSONB NOT NULL,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "filePath" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "ZipDownload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuestSearch_eventId_idx" ON "GuestSearch"("eventId");

-- CreateIndex
CREATE INDEX "MatchFeedback_searchId_idx" ON "MatchFeedback"("searchId");

-- CreateIndex
CREATE INDEX "ZipDownload_eventId_idx" ON "ZipDownload"("eventId");

-- AddForeignKey
ALTER TABLE "GuestSearch" ADD CONSTRAINT "GuestSearch_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchFeedback" ADD CONSTRAINT "MatchFeedback_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "GuestSearch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZipDownload" ADD CONSTRAINT "ZipDownload_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- No ANN index on GuestSearch.embedding: unlike Face, it's only ever read
-- back by primary key (for feedback lookups), never searched by similarity.
