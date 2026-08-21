/**
 * Sniffs the actual image type from file content (magic bytes), independent
 * of the filename's extension — a renamed .exe with a .jpg extension won't
 * pass this. Returns ".jpg", ".png", ".webp", or null if none match.
 */
export function sniffedImageExtension(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return ".png";
  if (buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

/** True if the file's actual content (via sniffedImageExtension) matches its claimed extension. */
export function contentMatchesExtension(buffer, declaredExt) {
  const sniffed = sniffedImageExtension(buffer);
  if (!sniffed) return false;
  const ext = declaredExt.toLowerCase();
  if (sniffed === ".jpg") return ext === ".jpg" || ext === ".jpeg";
  return sniffed === ext;
}
