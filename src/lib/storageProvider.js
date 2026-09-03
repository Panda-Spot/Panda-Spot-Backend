import * as localDisk from "./storage.js";

/**
 * MERGE (Studio-Verse merge, MERGE_PLAN.md D3): pluggable storage interface
 * for photo *originals* only — thumbnails and face-search data always stay
 * on local disk forever (see lib/photoRetention.js's own comments), so
 * they're never routed through this. Today there's exactly one provider,
 * wrapping the existing local-disk functions in lib/storage.js unchanged —
 * a future Google Drive archive-tier provider (D3: user has 5TB there,
 * "later, not now") implements this same shape and gets selected via
 * STORAGE_PROVIDER below, without any call site needing to change again.
 */
const localDiskProvider = {
  name: "local",
  writeOriginal: localDisk.saveEventPhoto,
  writeShootsOriginal: localDisk.saveEventShootsPhoto,
  deleteOriginal: localDisk.deleteFileIfExists,
};

/** The active storage provider for photo originals. Only "local" is
 * implemented today — this is the seam a future Drive-archive-tier
 * provider plugs into via STORAGE_PROVIDER, without touching any of the
 * call sites that write/delete a photo's original. */
export function getStorageProvider() {
  const name = process.env.STORAGE_PROVIDER || "local";
  if (name !== "local") {
    throw new Error(`Unknown STORAGE_PROVIDER "${name}" — only "local" is implemented today.`);
  }
  return localDiskProvider;
}
