import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import { storageRoot } from "./storage.js";

/** Builds a sane zip filename from an event name, e.g. "Jane's Wedding" -> "janes-wedding-photos.zip". */
export function zipFilenameForEvent(event) {
  return `${event.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "pandaspot-event"}-photos.zip`;
}

/**
 * Streams a zip of the given photos straight to an HTTP response (used by
 * the instant-download route). Caller must have already set
 * Content-Type/Content-Disposition headers.
 */
export async function streamPhotosZip(photos, res) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const donePromise = new Promise((resolve, reject) => {
    archive.on("error", reject);
    res.on("finish", resolve);
  });
  archive.pipe(res);

  for (const photo of photos) {
    if (fs.existsSync(photo.storagePath)) {
      archive.file(photo.storagePath, { name: photo.filename });
    }
  }

  await archive.finalize();
  await donePromise;
}

/** Absolute directory where pre-built zips for the email-download flow live. */
export function zipsDir() {
  return path.join(storageRoot(), "zips");
}

/** Absolute path a given ZipDownload's zip file should live at. */
export function zipDownloadPath(zipDownloadId) {
  return path.join(zipsDir(), `${zipDownloadId}.zip`);
}

/**
 * Builds a zip of the given photos to disk at zipDownloadPath(zipDownloadId),
 * for the asynchronous email-download flow. Returns the absolute path.
 */
export async function buildPhotosZipToDisk(photos, zipDownloadId) {
  await fsp.mkdir(zipsDir(), { recursive: true });
  const filePath = zipDownloadPath(zipDownloadId);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);

    for (const photo of photos) {
      if (fs.existsSync(photo.storagePath)) {
        archive.file(photo.storagePath, { name: photo.filename });
      }
    }

    archive.finalize();
  });

  return filePath;
}
