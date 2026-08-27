import { randomUUID } from "node:crypto";
import { getFreshAccessToken, isDriveBackupConfigured } from "./driveBackupAuth.js";

export const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

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
 * lib/captureIngest.js to mirror each Shoots capture; best-effort, callers
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

/**
 * How full the platform's single Drive backup account's own storage is —
 * the thing that quietly caps the whole Drive-backup feature, since every
 * upload is owned by this one account (see lib/driveBackupAuth.js). Used by
 * the admin metrics page. Never throws — `configured: false` if the
 * account isn't set up yet, `error` set if the Drive API call itself fails,
 * so a Drive hiccup never breaks the rest of the metrics page.
 */
export async function getDriveAccountQuota() {
  if (!isDriveBackupConfigured()) {
    return { configured: false, used_bytes: null, total_bytes: null, error: null };
  }
  try {
    const accessToken = await getFreshAccessToken();
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=storageQuota", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { configured: true, used_bytes: null, total_bytes: null, error: `Drive API error (${res.status}): ${detail.slice(0, 200)}` };
    }
    const data = await res.json();
    const quota = data.storageQuota || {};
    return {
      configured: true,
      // Google's `limit` field is entirely absent for unlimited-storage
      // (Workspace) accounts — surfaced as null, not a fake number.
      used_bytes: quota.usage != null ? Number(quota.usage) : null,
      total_bytes: quota.limit != null ? Number(quota.limit) : null,
      error: null,
    };
  } catch (err) {
    return { configured: true, used_bytes: null, total_bytes: null, error: err.message };
  }
}
