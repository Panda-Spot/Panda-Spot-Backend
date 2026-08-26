import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { FtpSrv } from "ftp-srv";
import chokidar from "chokidar";
import { prisma } from "./prisma.js";
import { storageRoot } from "./storage.js";
import { ingestCapturedFile } from "./captureIngest.js";

const FTP_PORT = parseInt(process.env.FTP_PORT, 10) || 2121;
const FTP_PASV_MIN = parseInt(process.env.FTP_PASV_MIN, 10) || 30100;
const FTP_PASV_MAX = parseInt(process.env.FTP_PASV_MAX, 10) || 30110;
// The public host/IP cameras connect to — required for passive mode to work
// through the VPS's firewall/NAT (without it, PASV replies would advertise
// the server's internal address, and camera data connections would fail).
const FTP_PUBLIC_HOST = process.env.FTP_PUBLIC_HOST;

function stagingRoot() {
  return path.join(storageRoot(), "shoots-incoming");
}

function stagingDirFor(eventId) {
  return path.join(stagingRoot(), eventId);
}

/** Generates a fresh, unique username + random password for Shoots. Called
 * once per event (on first setup) or again on demand (regenerate). */
export function generateShootsCredentials() {
  return {
    username: `evt_${randomBytes(6).toString("hex")}`,
    password: randomBytes(9).toString("base64url"),
  };
}

let started = false;

/**
 * Starts the Shoots FTP server (once) plus a chokidar watcher over its
 * staging directory. Each authenticated camera session is rooted at its own
 * event's staging folder — ftp-srv serves that folder as the connection's
 * whole filesystem, so a camera can only ever write into (and see) its own
 * event's incoming photos, never another event's or anything else on disk.
 * Files are picked up by the watcher once they stop changing size (a file
 * mid-FTP-transfer isn't touched), run through the same detection/thumbnail
 * pipeline as a browser upload (see lib/captureIngest.js), then deleted from
 * staging — the processed copy lives under the normal photo storage path.
 */
export function startShootsServer() {
  if (started) return;
  started = true;

  fs.mkdirSync(stagingRoot(), { recursive: true });

  const tlsCertPath = process.env.FTP_TLS_CERT_PATH;
  const tlsKeyPath = process.env.FTP_TLS_KEY_PATH;
  const tls =
    tlsCertPath && tlsKeyPath
      ? { cert: fs.readFileSync(tlsCertPath), key: fs.readFileSync(tlsKeyPath) }
      : undefined;

  if (!tls) {
    console.warn(
      "Shoots FTP server starting WITHOUT TLS (FTP_TLS_CERT_PATH/FTP_TLS_KEY_PATH not set) — " +
        "credentials travel in plaintext. Acceptable short-term since each event's credentials " +
        "are scoped to write-only access to just that event's own folder, but set up FTPS before " +
        "relying on this for real events."
    );
  }

  const ftpServer = new FtpSrv({
    url: `ftp://0.0.0.0:${FTP_PORT}`,
    pasv_url: FTP_PUBLIC_HOST,
    pasv_min: FTP_PASV_MIN,
    pasv_max: FTP_PASV_MAX,
    anonymous: false,
    tls,
  });

  ftpServer.on("login", async ({ username, password }, resolve, reject) => {
    try {
      const event = await prisma.event.findUnique({ where: { ftpUsername: username } });
      if (!event || !event.ftpPassword || event.ftpPassword !== password) {
        return reject(new Error("Invalid Shoots credentials"));
      }
      const root = stagingDirFor(event.id);
      await fsp.mkdir(root, { recursive: true });
      resolve({ root, cwd: "/" });
    } catch (err) {
      reject(err);
    }
  });

  ftpServer.on("client-error", ({ context, error }) => {
    console.error("Shoots FTP client error:", context, error?.message);
  });

  ftpServer
    .listen()
    .then(() => console.log(`Shoots FTP server listening on port ${FTP_PORT}${tls ? " (TLS)" : ""}`))
    .catch((err) => console.error("Shoots FTP server failed to start:", err));

  const watcher = chokidar.watch(stagingRoot(), {
    ignoreInitial: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  });

  watcher.on("add", async (filePath) => {
    const eventId = path.basename(path.dirname(filePath));
    const filename = path.basename(filePath);
    try {
      const event = await prisma.event.findUnique({ where: { id: eventId } });
      if (!event) {
        await fsp.unlink(filePath).catch(() => {});
        return;
      }
      const buffer = await fsp.readFile(filePath);
      await ingestCapturedFile(event, filename, buffer);
    } catch (err) {
      console.error(`Shoots ingestion failed for ${filePath}:`, err);
    } finally {
      await fsp.unlink(filePath).catch(() => {});
    }
  });

  watcher.on("error", (err) => console.error("Shoots file watcher error:", err));
}
