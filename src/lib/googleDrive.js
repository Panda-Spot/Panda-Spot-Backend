const DRIVE_API_KEY = process.env.GOOGLE_DRIVE_API_KEY;

/**
 * Parses a Drive folder share link (e.g.
 * https://drive.google.com/drive/folders/<ID>?usp=sharing) into just the
 * folder ID. Throws if the URL doesn't match.
 */
export function extractFolderId(url) {
  const match = /folders\/([a-zA-Z0-9_-]+)/.exec(url || "");
  if (!match) {
    throw new Error(
      "That doesn't look like a Google Drive folder link. It should look like https://drive.google.com/drive/folders/..."
    );
  }
  return match[1];
}

function ensureConfigured() {
  if (!DRIVE_API_KEY) {
    const err = new Error("Google Drive import isn't configured yet");
    err.isDriveConfigError = true;
    throw err;
  }
}

/**
 * Lists every image file directly inside the given public Drive folder,
 * paginating via nextPageToken. Returns [{ id, name, mimeType, size }].
 * A 403/404 from the Drive API means the folder isn't actually public —
 * surface that as a clear, specific error, not a generic failure.
 */
export async function listImageFiles(folderId) {
  ensureConfigured();
  const files = [];
  let pageToken;
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
    url.searchParams.set("fields", "files(id,name,mimeType,size),nextPageToken");
    url.searchParams.set("key", DRIVE_API_KEY);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) {
        throw new Error(
          "Couldn't access that Google Drive folder — make sure it's shared as \"Anyone with the link can view\"."
        );
      }
      throw new Error(`Google Drive API error (${res.status})`);
    }
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

/** Downloads one Drive file's raw bytes as a Buffer. */
export async function downloadFile(fileId) {
  ensureConfigured();
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("key", DRIVE_API_KEY);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Could not download file ${fileId} from Google Drive (${res.status}) — it may have been deleted or the folder is no longer shared publicly.`
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Best-effort mimeType -> extension mapping, falling back to the filename's own extension. */
export function guessExtension(mimeType, filename) {
  const map = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
  if (map[mimeType]) return map[mimeType];
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".jpeg") || lower.endsWith(".jpg")) return ".jpg";
  if (lower.endsWith(".png")) return ".png";
  if (lower.endsWith(".webp")) return ".webp";
  return null;
}
