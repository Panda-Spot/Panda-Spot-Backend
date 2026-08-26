import { randomUUID } from "node:crypto";
import { getFreshAccessToken } from "./driveBackupAuth.js";

/**
 * Builds a `multipart/related` request body per Drive API v3's upload spec:
 * one JSON metadata part, one raw-bytes part, separated by a boundary.
 */
function buildMultipartBody(boundary, metadata, mimeType, buffer) {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, "utf8");
  return Buffer.concat([head, buffer, tail]);
}

/**
 * Uploads one file into a Drive folder using the platform's single
 * connected account (see lib/driveBackupAuth.js) — only works because the
 * target folder is shared as "Anyone with the link — Editor". Used by
 * lib/captureIngest.js to mirror each Beam capture; best-effort, callers
 * should catch and log failures rather than let them affect the capture.
 */
export async function uploadToDriveFolder({ folderId, filename, mimeType, buffer }) {
  const accessToken = await getFreshAccessToken();
  const boundary = `pandaspot-${randomUUID()}`;
  const body = buildMultipartBody(boundary, { name: filename, parents: [folderId] }, mimeType, buffer);

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive backup upload failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Permanently deletes a file the platform account owns (used once its
 * lib/driveBackupRetention.js grace period has elapsed, to reclaim the
 * platform account's own Drive quota). A 404 (already gone — e.g. the
 * studio owner already made their own copy and removed the original, or a
 * previous attempt partially succeeded) is treated as success.
 */
export async function deleteFileFromDrive(fileId) {
  const accessToken = await getFreshAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive delete failed (${res.status}): ${detail.slice(0, 200)}`);
  }
}
