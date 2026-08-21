import multer from "multer";

// Keep files in memory; routes decide where/whether to persist them to disk
// (photo uploads only save after a successful extension check).
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
});
