import { OAuth2Client } from "google-auth-library";

// A separate OAuth flow from Sign-In-with-Google (routes/auth.js's
// /auth/google, which only ever handles an ID token client-side). This one
// is a full Authorization Code flow with `access_type: "offline"` so Google
// hands back a refresh token — needed because the actual Drive uploads
// happen later, unattended, from a background job (Beam captures), not
// synchronously in a browser tab.
//
// Advanced/beta feature: while the app's OAuth consent screen is in Google
// Cloud Console's "Testing" publishing status, only the Google accounts
// explicitly added as test users there can complete this flow at all — see
// server/README.md's "Drive backup" section for the exact console steps.
// DRIVE_BACKUP_BETA_EMAILS below is a second, app-level gate on top of
// that, so specific photographers can be enabled without touching the
// Google Cloud project.

const REDIRECT_URI =
  process.env.GOOGLE_DRIVE_BACKUP_REDIRECT_URI ||
  `${process.env.PUBLIC_SERVER_URL || "http://localhost:4000"}/auth/google/drive-backup/callback`;

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

function client() {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

export function isDriveBackupConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/** True if this email is allowed to use the feature while it's beta-gated. */
export function isDriveBackupBetaUser(email) {
  const allow = (process.env.DRIVE_BACKUP_BETA_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes((email || "").toLowerCase());
}

/** Builds the Google consent screen URL. `state` should be an opaque,
 * server-signed token (see routes/auth.js) — never a bare user id, since
 * Google echoes it back unmodified and it isn't safe to trust as-is. */
export function getConsentUrl(state) {
  return client().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token even if this user consented before
    scope: [DRIVE_FILE_SCOPE],
    state,
  });
}

/** Exchanges a one-time auth code for a long-lived refresh token. */
export async function exchangeCodeForRefreshToken(code) {
  const { tokens } = await client().getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google didn't return a refresh token. If you've connected this before, remove PandaSpot's access at " +
        "https://myaccount.google.com/permissions and try connecting again."
    );
  }
  return tokens.refresh_token;
}

/** Exchanges a stored refresh token for a short-lived access token to use against the Drive API. */
export async function getFreshAccessToken(refreshToken) {
  const oauth2 = client();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { token } = await oauth2.getAccessToken();
  return token;
}

/** Best-effort revoke, called on disconnect — Google's own record of the grant is removed too, not just our local copy. */
export async function revokeRefreshToken(refreshToken) {
  await client().revokeToken(refreshToken).catch(() => {});
}
