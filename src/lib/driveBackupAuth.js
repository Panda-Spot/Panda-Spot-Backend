import { OAuth2Client } from "google-auth-library";

// A single, platform-wide Google account (the operator's own), not a
// per-photographer grant. Shoots-captured photos get uploaded into a
// photographer's Drive folder using THIS one account, which only works
// because the folder is shared as "Anyone with the link — Editor": Drive's
// link-sharing permission grants write access to any authenticated Google
// account holding the link, not just ones explicitly added as
// collaborators, so this account's writes succeed there the same as if a
// person had opened the link and dragged a file in.
//
// This is a deliberate, disclosed tradeoff for an advanced/beta feature —
// see server/README.md's "Drive backup" section: uploaded files are owned
// by this one account and count against its own Drive quota (shared across
// every event using the feature, not per-photographer), which is why
// lib/driveBackupRetention.js aggressively reclaims/purges rather than
// keeping anything here permanently.
//
// GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN is obtained ONCE by an admin running the
// /auth/google/drive-backup/connect -> .../callback flow below (admin-only),
// then pasted into the server's real .env and the process restarted — same
// "env vars only load at process start" pattern as ADMIN_EMAILS.

const REDIRECT_URI =
  process.env.GOOGLE_DRIVE_BACKUP_REDIRECT_URI ||
  `${process.env.PUBLIC_SERVER_URL || "http://localhost:4000"}/auth/google/drive-backup/callback`;

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

function client() {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

/** True once the platform's single Drive backup account is fully wired up. */
export function isDriveBackupConfigured() {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN
  );
}

/** True if this photographer's account is allowed to turn the per-event
 * toggle on — independent of whether the platform account itself is set up.
 * DRIVE_BACKUP_BETA_EMAILS="*" opts every client in at once (still gated on
 * the platform account being configured — see isDriveBackupConfigured). */
export function isDriveBackupBetaUser(email) {
  const allow = (process.env.DRIVE_BACKUP_BETA_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allow.includes("*")) return true;
  return allow.includes((email || "").toLowerCase());
}

/** Builds the Google consent screen URL for the one-time admin setup. */
export function getConsentUrl() {
  return client().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token even if this account consented before
    scope: [DRIVE_FILE_SCOPE],
  });
}

/** Exchanges a one-time auth code for a long-lived refresh token (setup only). */
export async function exchangeCodeForRefreshToken(code) {
  const { tokens } = await client().getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google didn't return a refresh token. If this account has connected before, remove PandaSpot's access at " +
        "https://myaccount.google.com/permissions and try connecting again."
    );
  }
  return tokens.refresh_token;
}

/** Exchanges the platform's stored refresh token for a short-lived access token. */
export async function getFreshAccessToken() {
  const refreshToken = process.env.GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("Drive backup isn't configured (GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN unset)");
  }
  const oauth2 = client();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { token } = await oauth2.getAccessToken();
  return token;
}
