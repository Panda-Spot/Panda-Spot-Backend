-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'USER', 'INVITED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "allowDownload" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "faceSearchEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "photoSelectionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "Role" NOT NULL DEFAULT 'ADMIN';

-- CreateTable
CREATE TABLE "EventUserMapping" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "favouriteCap" INTEGER,
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "EventUserMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientFavourite" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientFavourite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioFavourite" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioFavourite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventUserMapping_userId_idx" ON "EventUserMapping"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EventUserMapping_eventId_userId_key" ON "EventUserMapping"("eventId", "userId");

-- CreateIndex
CREATE INDEX "ClientFavourite_userId_idx" ON "ClientFavourite"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientFavourite_photoId_userId_key" ON "ClientFavourite"("photoId", "userId");

-- CreateIndex
CREATE INDEX "StudioFavourite_userId_idx" ON "StudioFavourite"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StudioFavourite_photoId_userId_key" ON "StudioFavourite"("photoId", "userId");

-- AddForeignKey
ALTER TABLE "EventUserMapping" ADD CONSTRAINT "EventUserMapping_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventUserMapping" ADD CONSTRAINT "EventUserMapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientFavourite" ADD CONSTRAINT "ClientFavourite_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientFavourite" ADD CONSTRAINT "ClientFavourite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudioFavourite" ADD CONSTRAINT "StudioFavourite_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudioFavourite" ADD CONSTRAINT "StudioFavourite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

