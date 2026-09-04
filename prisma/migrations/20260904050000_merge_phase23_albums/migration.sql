-- CreateEnum
CREATE TYPE "AlbumStatus" AS ENUM ('DRAFT', 'SENT', 'CHANGES_REQUESTED', 'APPROVED');

-- CreateTable
CREATE TABLE "Album" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AlbumStatus" NOT NULL DEFAULT 'DRAFT',
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Album_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumSource" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumVersion" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "note" TEXT,
    "printPdfPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumPage" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "thumbnailPath" TEXT,
    "filename" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlbumComment" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "pageId" TEXT,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "pinNumber" INTEGER,
    "xPct" DOUBLE PRECISION,
    "yPct" DOUBLE PRECISION,
    "message" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlbumComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Album_eventId_idx" ON "Album"("eventId");

-- CreateIndex
CREATE INDEX "AlbumSource_albumId_idx" ON "AlbumSource"("albumId");

-- CreateIndex
CREATE UNIQUE INDEX "AlbumSource_albumId_photoId_key" ON "AlbumSource"("albumId", "photoId");

-- CreateIndex
CREATE INDEX "AlbumVersion_albumId_idx" ON "AlbumVersion"("albumId");

-- CreateIndex
CREATE UNIQUE INDEX "AlbumVersion_albumId_versionNumber_key" ON "AlbumVersion"("albumId", "versionNumber");

-- CreateIndex
CREATE INDEX "AlbumPage_versionId_idx" ON "AlbumPage"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "AlbumPage_versionId_pageNumber_key" ON "AlbumPage"("versionId", "pageNumber");

-- CreateIndex
CREATE INDEX "AlbumComment_versionId_idx" ON "AlbumComment"("versionId");

-- CreateIndex
CREATE INDEX "AlbumComment_pageId_idx" ON "AlbumComment"("pageId");

-- CreateIndex
CREATE INDEX "AlbumComment_parentId_idx" ON "AlbumComment"("parentId");

-- AddForeignKey
ALTER TABLE "Album" ADD CONSTRAINT "Album_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumSource" ADD CONSTRAINT "AlbumSource_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumSource" ADD CONSTRAINT "AlbumSource_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumVersion" ADD CONSTRAINT "AlbumVersion_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumPage" ADD CONSTRAINT "AlbumPage_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "AlbumVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumComment" ADD CONSTRAINT "AlbumComment_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "AlbumVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumComment" ADD CONSTRAINT "AlbumComment_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "AlbumPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumComment" ADD CONSTRAINT "AlbumComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlbumComment" ADD CONSTRAINT "AlbumComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AlbumComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

