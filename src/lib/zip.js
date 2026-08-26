import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import { storageRoot } from "./storage.js";
import { downloadFile } from "./googleDrive.js";

/** Builds a sane zip filename from an event name, e.g. "Jane's Wedding" -> "janes-wedding-photos.zip". */
export function zipFilenameForEvent(event) {
  return `${event.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "pandaspot-event"}-photos.zip`;
}

/**
 * `Photo.filename` is attacker-controllable (a browser upload's original
 * filename, a Google Drive file's name, or a camera's own filename via
 * Shoots) and was never restricted beyond its extension — used verbatim as
 * a zip entry name, a crafted value like `../../../etc/whatever` would be a
 * classic zip-slip path-traversal on extraction. Strips any directory
 * components before it becomes an entry name.
 */
function safeZipEntryName(filename) {
  // Explicitly path.posix (not the host-OS-dependent path.basename) after
  // normalizing backslashes to forward slashes first — this needs to strip
  // both separator styles regardless of which OS this process runs on,
  // since the zip can be extracted on any OS.
  const normalized = String(filename || "photo").replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  return !base || base === "." || base === ".." ? "photo" : base;
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
    const entryName = safeZipEntryName(photo.filename);
    if (photo.storagePath && fs.existsSync(photo.storagePath)) {
      archive.file(photo.storagePath, { name: entryName });
    } else if (photo.driveFileId) {
      try {
        const buffer = await downloadFile(photo.driveFileId);
        archive.append(buffer, { name: entryName });
      } catch (err) {
        console.error(`Skipping photo ${photo.id} in zip — Drive download failed:`, err.message);
      }
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

  // Drive downloads are async and archiver's write pipeline is callback-
  // driven, so resolve every Drive-backed photo's bytes up front (outside
  // the Promise executor below, which can't itself be async) before
  // building the archive.
  const driveBuffers = new Map(); // photo.id -> Buffer, only for successful Drive fetches
  for (const photo of photos) {
    if (!(photo.storagePath && fs.existsSync(photo.storagePath)) && photo.driveFileId) {
      try {
        driveBuffers.set(photo.id, await downloadFile(photo.driveFileId));
      } catch (err) {
        console.error(`Skipping photo ${photo.id} in zip — Drive download failed:`, err.message);
      }
    }
  }

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);

    for (const photo of photos) {
      const entryName = safeZipEntryName(photo.filename);
      if (photo.storagePath && fs.existsSync(photo.storagePath)) {
        archive.file(photo.storagePath, { name: entryName });
      } else if (driveBuffers.has(photo.id)) {
        archive.append(driveBuffers.get(photo.id), { name: entryName });
      }
    }

    archive.finalize();
  });

  return filePath;
}
