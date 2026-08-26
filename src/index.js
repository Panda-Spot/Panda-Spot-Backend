import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.js";
import eventsRoutes from "./routes/events.js";
import guestRoutes from "./routes/guest.js";
import filesRoutes from "./routes/files.js";
import brandingRoutes from "./routes/branding.js";
import invitesRoutes from "./routes/invites.js";
import adminRoutes from "./routes/admin.js";
import { startAutoSyncScheduler } from "./lib/driveSync.js";
import { startShootsServer } from "./lib/ftpShoots.js";
import { startDriveBackupRetentionScheduler } from "./lib/driveBackupRetention.js";

const app = express();

// Running behind a single reverse proxy on the VPS (adds X-Forwarded-For).
// Without this, express-rate-limit throws on every request instead of
// computing a client IP, since Express doesn't trust that header by default
// — this was silently breaking every rate-limited route (login, register,
// uploads, guest search/download/feedback) in production.
app.set("trust proxy", 1);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth", authRoutes);
app.use("/events", eventsRoutes);
app.use("/e", guestRoutes);
app.use("/files", filesRoutes);
app.use("/branding", brandingRoutes);
app.use("/invites", invitesRoutes);
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
});
