-- Enable the pgvector extension BEFORE any table that uses the `vector` type is created.
-- This line is hand-added (Prisma does not generate CREATE EXTENSION statements automatically).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "guestSlug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "faceCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Face" (
    "id" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "bbox" JSONB NOT NULL,
    "embedding" vector(512) NOT NULL,
    "detScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Face_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Event_guestSlug_key" ON "Event"("guestSlug");

-- CreateIndex
CREATE INDEX "Face_eventId_idx" ON "Face"("eventId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Face" ADD CONSTRAINT "Face_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Approximate-nearest-neighbor index for cosine search, so a guest selfie
-- search doesn't have to scan every face row in an event — Postgres can use
-- this index to find the nearest embeddings directly. HNSW (not IVFFlat):
-- IVFFlat's cluster centroids are computed once at build time from whatever
-- data exists then, and get stale as more events/faces are added afterward
-- (needing a periodic REINDEX to stay accurate); HNSW's graph is built
-- incrementally as rows are inserted, so it stays effective from an empty
-- table onward — a better fit for events that start empty and grow.
-- Requires pgvector >= 0.5.0 (HNSW support).
CREATE INDEX "Face_embedding_hnsw_idx" ON "Face" USING hnsw (embedding vector_cosine_ops);
