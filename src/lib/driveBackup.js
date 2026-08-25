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
 * Uploads one file into a Drive folder the connected account has access to,
 * using its stored refresh token. Used by lib/captureIngest.js to mirror
 * each Beam capture into a connected Drive folder — best-effort: callers
 * should catch and log failures, never let a backup failure affect the
 * capture it was triggered by.
 */
export async function uploadToDriveFolder({ refreshToken, folderId, filename, mimeType, buffer }) {
  const accessToken = await getFreshAccessToken(refreshToken);
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
