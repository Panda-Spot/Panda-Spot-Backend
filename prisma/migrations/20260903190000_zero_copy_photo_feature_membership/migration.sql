-- A photo is stored once and can be exposed to Face Search, Photo Selection,
-- both, or neither by toggling these membership flags. Defaults preserve
-- current behavior for existing events and newly-ingested photos.

ALTER TABLE "Photo" ADD COLUMN "faceSearchVisible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Photo" ADD COLUMN "photoSelectionVisible" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "Photo_eventId_faceSearchVisible_approvalStatus_idx"
ON "Photo"("eventId", "faceSearchVisible", "approvalStatus");

CREATE INDEX "Photo_eventId_photoSelectionVisible_approvalStatus_idx"
ON "Photo"("eventId", "photoSelectionVisible", "approvalStatus");
