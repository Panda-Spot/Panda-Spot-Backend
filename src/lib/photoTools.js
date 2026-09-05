import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import sharp from "sharp";
import exifr from "exifr";
import { prisma } from "./prisma.js";
import { existsSync } from "./storage.js";
import { downloadFile } from "./googleDrive.js";
import { isVideoExtension } from "./fileValidation.js";
import { createJob, emitJobEvent } from "./jobQueue.js";
import path from "node:path";

/// Photography tools pack (Phase 9): duplicate hashing, blur scoring,
/// EXIF snapshots, compression presets, and cover scoring. All heavy
/// work runs inside the analyze job (async, SSE progress) — never inline
/// in the upload flow. Closed-eye detection is deliberately NOT here:
/// the face-engine wrapper exposes no landmarks, so there is nothing to
/// compute it from (see the tools card note).

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/// Laplacian-variance sharpness on a 320px greyscale thumbnail — higher
/// means sharper. Null when unmeasurable (videos, tiny/corrupt files).
export async function blurScore(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .greyscale()
      .resize(320, 320, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    if (width < 3 || height < 3) return null;
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const c = data[y * width + x];
        const lap = 4 * c - data[y * width + x - 1] - data[y * width + x + 1] - data[(y - 1) * width + x] - data[(y + 1) * width + x];
        sum += lap;
        sumSq += lap * lap;
        n += 1;
      }
    }
    if (n === 0) return null;
    const variance = sumSq / n - (sum / n) ** 2;
    return Math.round(variance * 100) / 100;
  } catch {
    return null;
  }
}

function formatShutter(exposureTime) {
  if (!Number.isFinite(exposureTime) || exposureTime <= 0) return null;
  if (exposureTime < 1) return `1/${Math.round(1 / exposureTime)}`;
  return `${exposureTime}s`;
}

export async function readExif(buffer) {
  try {
    const exif = await exifr.parse(buffer);
    if (!exif) return null;
    const make = [exif.Make, exif.Model].filter(Boolean).join(" ").trim() || null;
    return {
      camera: make,
      lens: exif.LensModel || null,
      iso: Number.isFinite(exif.ISO) ? Math.round(exif.ISO) : null,
      shutter: formatShutter(exif.ExposureTime),
      aperture: Number.isFinite(exif.FNumber) ? `f/${exif.FNumber}` : null,
      capturedAt: exif.DateTimeOriginal instanceof Date && !Number.isNaN(exif.DateTimeOriginal) ? exif.DateTimeOriginal : null,
    };
  } catch {
    return null;
  }
}

export async function loadPhotoBytes(photo) {
  if (photo.storagePath && existsSync(photo.storagePath)) {
    try {
      return await readFile(photo.storagePath);
    } catch {
      return null;
    }
  }
  if (photo.driveFileId) {
    try {
      return await downloadFile(photo.driveFileId);
    } catch (err) {
      console.error(`Tools: Drive fetch failed for photo ${photo.id}:`, err.message);
      return null;
    }
  }
  return null;
}

/// Analyzes one photo and persists hash/sharpness/EXIF. Videos get a
/// hash only (no pixels are sampled). Returns "ok" | "no-bytes" | "failed".
export async function analyzePhoto(photo) {
  const buffer = await loadPhotoBytes(photo);
  if (!buffer) return "no-bytes";
  const data = { fileHash: sha256Hex(buffer) };
  if (!isVideoExtension(path.extname(photo.filename || "").toLowerCase())) {
    data.sharpness = await blurScore(buffer);
    const exif = await readExif(buffer);
    if (exif) {
      data.exifCamera = exif.camera;
      data.exifLens = exif.lens;
      data.exifIso = exif.iso;
      data.exifShutter = exif.shutter;
      data.exifAperture = exif.aperture;
      data.exifCapturedAt = exif.capturedAt;
    }
  }
  await prisma.photo.update({ where: { id: photo.id }, data });
  return "ok";
}

export async function runAnalyzeJob(jobId, event, photoIds) {
  const total = photoIds.length;
  let completed = 0;
  let analyzed = 0;
  const skipped = [];
  const startedAt = Date.now();
  try {
    for (const photoId of photoIds) {
      const photo = await prisma.photo.findFirst({ where: { id: photoId, eventId: event.id } });
      if (!photo) {
        skipped.push(`${photoId} (not found)`);
      } else {
        try {
          const outcome = await analyzePhoto(photo);
          if (outcome === "ok") analyzed += 1;
          else skipped.push(`${photo.filename} (${outcome})`);
        } catch (err) {
          skipped.push(`${photo.filename} (${err.message || "failed"})`);
        }
      }
      completed += 1;
      const elapsed = (Date.now() - startedAt) / 1000;
      emitJobEvent(jobId, {
        type: "progress",
        job_id: jobId,
        total,
        completed,
        photos_per_second: elapsed > 0 ? Math.round((completed / elapsed) * 100) / 100 : 0,
        analyzed_so_far: analyzed,
        skipped_so_far: skipped,
      });
    }
    emitJobEvent(jobId, { type: "done", job_id: jobId, photos_processed: total, analyzed, skipped });
  } catch (err) {
    console.error(`Analyze job ${jobId} failed:`, err);
    emitJobEvent(jobId, { type: "error", job_id: jobId, message: err.message || "Unknown error while analyzing" });
  }
}

export function startAnalyzeJob(event, photoIds) {
  const { id: jobId } = createJob();
  runAnalyzeJob(jobId, event, photoIds).catch((err) => console.error(`Unhandled error in analyze job ${jobId}:`, err));
  return jobId;
}

/// Compression presets for delivery downloads. Stills are re-encoded
/// (never enlarged); anything else falls back to the original bytes.
export const COMPRESSION_PRESETS = {
  web: { width: 2048, quality: 82 },
  proof: { width: 1200, quality: 75 },
  whatsapp: { width: 1280, quality: 70 },
};

export async function renderVariant(photo, buffer, preset) {
  const spec = COMPRESSION_PRESETS[preset];
  const ext = path.extname(photo.filename || "").toLowerCase();
  if (!spec || !buffer || isVideoExtension(ext)) return null;
  try {
    const out = await sharp(buffer)
      .rotate()
      .resize({ width: spec.width, withoutEnlargement: true })
      .jpeg({ quality: spec.quality, mozjpeg: true })
      .toBuffer();
    const base = path.posix.basename(photo.filename || "photo").replace(/\.[^.]+$/, "") || "photo";
    return { buffer: out, contentType: "image/jpeg", filename: `${base}-${preset}.jpg` };
  } catch {
    return null;
  }
}

/// Smart cover shortlist: faces first, then sharpness, then landscape
/// orientation (from the cheap local thumbnail), then studio rating.
/// Only approved stills. Returns top entries with human reasons.
export async function suggestCovers(eventId, limit = 10) {
  const photos = await prisma.photo.findMany({
    where: { eventId, approvalStatus: "approved", archivedAt: null },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const scored = [];
  for (const photo of photos) {
    if (isVideoExtension(path.extname(photo.filename || "").toLowerCase())) continue;
    let score = 0;
    const reasons = [];
    if (photo.faceCount > 0) {
      const faceScore = 12 + Math.min(photo.faceCount, 5) * 2;
      score += faceScore;
      reasons.push(photo.faceCount === 1 ? "1 face" : `${photo.faceCount} faces`);
    }
    if (photo.sharpness != null) {
      const sharpScore = Math.min(photo.sharpness / 200, 10);
      score += sharpScore;
      reasons.push(`sharpness ${Math.round(photo.sharpness)}`);
    }
    if (photo.rating > 0) {
      score += photo.rating * 2;
      reasons.push(`${photo.rating}★`);
    }
    try {
      const thumbPath = photo.thumbnailPath;
      if (thumbPath && fs.existsSync(thumbPath)) {
        const meta = await sharp(thumbPath).metadata();
        if (meta.width && meta.height && meta.width > meta.height) {
          score += 4;
          reasons.push("landscape");
        }
      }
    } catch {
      // Orientation is a bonus, never a blocker.
    }
    scored.push({ photo, score: Math.round(score * 10) / 10, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ photo, score, reasons }) => ({
    photo_id: photo.id,
    filename: photo.filename,
    url: `/files/events/${eventId}/photos/${photo.id}`,
    thumbnail_url: `/files/events/${eventId}/photos/${photo.id}/thumb`,
    face_count: photo.faceCount,
    sharpness: photo.sharpness,
    rating: photo.rating,
    score,
    reasons,
  }));
}
