import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.js";
import eventsRoutes from "./routes/events.js";
import albumsRoutes from "./routes/albums.js";
import selectionExportRoutes from "./routes/selectionExport.js";
import clientAlbumsRoutes from "./routes/clientAlbums.js";
import clientRoutes from "./routes/client.js";
import studioRoutes from "./routes/studio.js";
import guestRoutes from "./routes/guest.js";
import filesRoutes from "./routes/files.js";
import brandingRoutes from "./routes/branding.js";
import invitesRoutes from "./routes/invites.js";
import clientInvitesRoutes from "./routes/clientInvites.js";
import subscriptionsRoutes from "./routes/subscriptions.js";
import billingRoutes from "./routes/billing.js";
import supportRoutes from "./routes/support.js";
import adminRoutes from "./routes/admin.js";
import { startAutoSyncScheduler } from "./lib/driveSync.js";
import { startShootsServer } from "./lib/ftpShoots.js";
import { startDriveBackupRetentionScheduler } from "./lib/driveBackupRetention.js";
import { startPhotoRetentionScheduler } from "./lib/photoRetention.js";
import { startGuestDataRetentionScheduler } from "./lib/facePrivacy.js";
import { startTokenMaintenanceScheduler } from "./lib/tokenMaintenance.js";

const app = express();

// Running behind a single reverse proxy on the VPS (adds X-Forwarded-For).
// Without this, express-rate-limit throws on every request instead of
// computing a client IP, since Express doesn't trust that header by default
// — this was silently breaking every rate-limited route (login, register,
// uploads, guest search/download/feedback) in production.
app.set("trust proxy", 1);

const configuredOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (configuredOrigins.includes(origin) || configuredOrigins.includes("*")) {
      return callback(null, true);
    }
    // Allow any localhost / 127.0.0.1 port for local development & testing
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(null, false);
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(cookieParser());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth", authRoutes);
// Albums before events: both share the /events/:id prefix and Express
// matches routers in registration order.
app.use("/events/:id/albums", albumsRoutes);
app.use("/events/:id/selection", selectionExportRoutes);
app.use("/events", eventsRoutes);
app.use("/e", guestRoutes);
app.use("/files", filesRoutes);
app.use("/branding", brandingRoutes);
app.use("/invites", invitesRoutes);
app.use("/client-invites", clientInvitesRoutes);
app.use("/client", clientRoutes);
app.use("/client/events/:eventId/albums", clientAlbumsRoutes);
app.use("/studio", studioRoutes);
app.use("/subscriptions", subscriptionsRoutes);
app.use("/billing", billingRoutes);
app.use("/support", supportRoutes);
app.use("/admin", adminRoutes);

// Multer file-size/type errors and anything passed to next(err) lands here.
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`PandaSpot server listening on port ${PORT}`);
  startAutoSyncScheduler();
  startShootsServer();
  startDriveBackupRetentionScheduler();
  startPhotoRetentionScheduler();
  startGuestDataRetentionScheduler();
  startTokenMaintenanceScheduler();
});
