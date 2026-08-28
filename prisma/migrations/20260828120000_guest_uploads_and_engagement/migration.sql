ALTER TABLE "Event" ADD COLUMN "guestUploadEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Photo" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE "Photo" ADD COLUMN "uploadedByGuestClientId" TEXT;

CREATE TABLE "PhotoLike" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "guestClientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoLike_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PhotoLike_photoId_guestClientId_key" ON "PhotoLike"("photoId", "guestClientId");
CREATE INDEX "PhotoLike_eventId_idx" ON "PhotoLike"("eventId");

ALTER TABLE "PhotoLike" ADD CONSTRAINT "PhotoLike_photoId_fkey"
  FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PhotoComment" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "guestClientId" TEXT NOT NULL,
    "guestName" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PhotoComment_eventId_idx" ON "PhotoComment"("eventId");
CREATE INDEX "PhotoComment_photoId_idx" ON "PhotoComment"("photoId");

ALTER TABLE "PhotoComment" ADD CONSTRAINT "PhotoComment_photoId_fkey"
  FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
