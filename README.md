# server — PandaSpot API

The central PandaSpot backend: photographer auth, events, bulk photo upload,
and guest selfie search. Owns Postgres (via Prisma) and local disk storage.
Delegates only the actual face detection/embedding math to the internal
`face-engine` Python microservice (`../face-engine`) — this app never touches
InsightFace directly.

**Milestone note**: the MVP is feature-complete. Billing is a "coming soon"
placeholder — there's no real Stripe integration yet — but the free-tier
limits below (event count, per-event storage) are hard-enforced in the
meantime, not just cosmetic. See "Plan limits" and "Event expiry" below.

## Architecture 

- **Auth**: photographer accounts (email/password via bcrypt). `POST /auth/register`,
  `/login`, and `/google` all return a JWT in the response body as `token` —
  the frontend stores it (localStorage) and sends it back as
  `Authorization: Bearer <token>` on every request. This is the primary auth
  mechanism; an httpOnly cookie is also still set as a harmless bonus (works
  fine if this API is ever made same-site with its frontend) but isn't relied
  on, since a cross-site cookie between two unrelated domains (this API vs. a
  frontend on a different domain, e.g. Vercel) gets silently dropped by
  third-party-cookie blocking in Safari (default) and increasingly Chrome —
  that class of bug is what motivated the switch. `requireAuth`
  (`src/middleware/auth.js`) checks, in order: the `Authorization` header,
  then a `?token=` query param (for the SSE upload-progress stream, since
  `EventSource` can't set custom headers), then the cookie as a last resort.
  No guest accounts — guests reach an event via its public `guestSlug` link
  and never log in.
- **Storage**: uploaded photos are saved to `STORAGE_DIR/events/{eventId}/`
  on local disk (this app's own VPS, no S3).
- **Face data**: every uploaded photo is sent to `face-engine`'s `POST /detect`,
  and each detected face's 512-d embedding is stored in Postgres in a `Face`
  row using the `pgvector` extension (`vector(512)` column). Guest selfie
  search runs a cosine-distance SQL query (`embedding <=> ...`) scoped to one
  event, instead of scanning every face in process memory.

## Setup

1. **Postgres with `pgvector` >= 0.5.0** — you need a Postgres instance where
   the `vector` extension is installable, at version 0.5.0 or later (needed
   for the HNSW index the migration creates). Options: the
   `pgvector/pgvector` Docker image, or installing the `pgvector` extension
   package on an existing Postgres (e.g. `CREATE EXTENSION vector;` requires
   the extension's shared library to be present on the server first — see
   https://github.com/pgvector/pgvector#installation). Check the installed
   version with `SELECT extversion FROM pg_extension WHERE extname = 'vector';`
   after creating the extension.

2. **Install deps**:
   ```bash
   cd server
   npm install
   cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, etc.
   ```

3. **Run the migration** — the checked-in migration at
   `prisma/migrations/20260820000000_init/migration.sql` includes a manual
   `CREATE EXTENSION IF NOT EXISTS vector;` line before the `Face` table is
   created (Prisma doesn't generate this automatically). Apply it with:
   ```bash
   npx prisma migrate deploy
   npx prisma generate
   ```
   (Use `npx prisma migrate dev` instead if you want Prisma to track further
   schema changes interactively during development.)

4. **Start `face-engine` first** (see its own README — it must be running,
   bound to `127.0.0.1`, before this app can process uploads or searches):
   ```bash
   cd ../face-engine
   uvicorn app.main:app --port 8001
   ```

5. **Start this server**:
   ```bash
   npm run dev
   ```

## Env vars (`.env.example`)

| Var | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string (must have `pgvector` available) |
| `JWT_SECRET` | Signs the auth cookie's JWT — use a long random string |
| `FACE_ENGINE_URL` | Base URL of the face-engine microservice, default `http://127.0.0.1:8001` |
| `STORAGE_DIR` | Where uploaded photos are saved, default `./storage` |
| `FACE_MATCH_THRESHOLD` | Cosine-similarity cutoff for a guest selfie match, default `0.36` |
| `PORT` | This server's port, default `4000` |
| `CORS_ORIGIN` | The frontend's origin — required (not `*`) since auth uses cookies with `credentials: true` |
| `SMTP_HOST` | SMTP host for emailing guests their zip download link; unset = no-op (logs the link instead) |
| `SMTP_PORT` | SMTP port, default `587` |
| `SMTP_SECURE` | `"true"`/`"false"`, default `false` |
| `SMTP_USER` / `SMTP_PASS` | SMTP auth, optional |
| `SMTP_FROM` | From header for zip-ready emails |
| `PUBLIC_SERVER_URL` | This server's own public base URL, used to build the emailed zip download link, default `http://localhost:4000` |
| `PUBLIC_WEB_URL` | The frontend web app's public base URL, used to build collaborator invite links (`${PUBLIC_WEB_URL}/invites/:token`), default `http://localhost:5173` |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID for "Sign in with Google" (Google Cloud Console > APIs & Services > Credentials). Unset by default — `POST /auth/google` responds `503` cleanly until this is configured. |
| `ADMIN_EMAILS` | Comma-separated allowlist of email addresses allowed to hit `/admin/*` (the platform-operator overview — not a general role system). e.g. `"you@example.com,teammate@example.com"`. Unset = nobody can access `/admin/*`. |
| `GOOGLE_DRIVE_API_KEY` | Google Drive API key (Cloud Console > APIs & Services > Credentials > API key, with the Drive API enabled) for the "import from a public Google Drive folder" feature — see "Google Drive import" below. This is a **separate** credential from `GOOGLE_CLIENT_ID` above (that one is Sign-In OAuth; this one is a plain read-only Drive API v3 key). Unset by default — `POST /events/:id/import/drive` responds a clean `400` until this is configured. |
| `FTP_PORT`, `FTP_PASV_MIN`, `FTP_PASV_MAX`, `FTP_PUBLIC_HOST`, `FTP_TLS_CERT_PATH`, `FTP_TLS_KEY_PATH` | Beam (camera-to-cloud live upload) FTP server config — see "Beam" below. `FTP_PUBLIC_HOST` and the passive port range must be reachable through the VPS firewall/NAT for camera uploads to work over the internet. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | WhatsApp delivery (see "WhatsApp delivery" below) — Twilio's WhatsApp Business API, called directly via REST (no SDK). Unset by default — `lib/whatsapp.js` logs instead of sending. |
| `GOOGLE_CLIENT_SECRET`, `GOOGLE_DRIVE_BACKUP_REDIRECT_URI`, `GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN`, `DRIVE_BACKUP_BETA_EMAILS` | **Advanced/beta** Drive backup — see "Drive backup" below. One platform-wide Drive account (not per-photographer): `GOOGLE_CLIENT_SECRET` pairs with `GOOGLE_CLIENT_ID` for the one-time admin OAuth setup; `GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN` is that setup's actual result and IS the credential used for every upload; `DRIVE_BACKUP_BETA_EMAILS` gates which photographers can enable the per-event toggle. |

## API

### Auth

Every user response (`register`/`login`/`me`/`google`) now includes
`email_verified: boolean`. Verification is **soft/non-blocking** — it never
gates login or feature access, it's purely a UI nudge (see `emailVerifiedAt`
on `User`). `POST /auth/login` returns a clear 401 if the account is
Google-only (no `passwordHash` set) rather than attempting a password check.

Every user response also now includes `is_admin: boolean` — `true` only if
the account's email is in the `ADMIN_EMAILS` allowlist (see "Platform admin"
below). This is purely so the frontend knows whether to show an Admin nav
link; the real gate is server-side on `/admin/*`.

Every user response also includes `drive_backup_beta: boolean` (true if this
email is in `DRIVE_BACKUP_BETA_EMAILS` — lets this photographer see the
per-event Drive backup toggle) and `drive_backup_configured: boolean` (true
once the platform's single Drive backup account is set up — not per-user)
— see "Drive backup" below. Same UI-nicety-only pattern as `is_admin`; the
real gates are server-side.

| Method | Path | Auth | Rate limit | What |
|---|---|---|---|---|
| POST | `/auth/register` | — | 5/hour/IP | `{ email, password, name }` → creates account, response includes `token` (the primary auth mechanism — see "Auth" above), also sets the bonus cookie, sends a (non-blocking) verification email |
| POST | `/auth/login` | — | 10/15min/IP | `{ email, password }` → response includes `token`, also sets the bonus cookie |
| POST | `/auth/logout` | — | — | Clears the cookie |
| GET | `/auth/me` | required | — | Current user, or 401 |
| POST | `/auth/email-verification/request` | required | — | Sends a fresh verification email. `{ ok: true }`, or `{ ok: true, already_verified: true }` if already verified (no email sent) |
| POST | `/auth/email-verification/:token/confirm` | — | — | Marks the account verified. `{ ok: true }`; `404` if the token is invalid/expired/already used |
| POST | `/auth/password-reset/request` | — | 10/15min/IP | `{ email }` → **always** responds `{ ok: true }` regardless of whether the account exists (no user-enumeration); emails a reset link if it does |
| POST | `/auth/password-reset/:token/confirm` | — | — | `{ password }` (min 8 chars) → sets the new password. `{ ok: true }`; `404` if the token is invalid/expired/already used |
| POST | `/auth/google` | — | — | `{ id_token }` (a Google Identity Services credential) → verifies it server-side, creates the account on first sign-in or links `googleId` to a matching existing email, response includes `token`. `503` if `GOOGLE_CLIENT_ID` isn't configured; `401` if the token doesn't verify |
| GET | `/auth/google/drive-backup/connect` | required (admin) | — | **Advanced/beta, one-time setup** — see "Drive backup" below. A full-page redirect (not a fetch) to Google's consent screen for the platform's single Drive backup account. `403` if this account isn't in `ADMIN_EMAILS`; `503` if `GOOGLE_CLIENT_ID`/`SECRET` aren't set. |
| GET | `/auth/google/drive-backup/callback` | — | — | Google's redirect target — exchanges the code for a refresh token and renders it once as plain text for the admin to copy into `.env` as `GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN` (never stored in the database). |

### Events (photographer)

An event has one **owner** and, optionally, any number of **collaborators**
(a "second shooter"/assistant granted upload+view access to that one event
without ever getting the owner's login credentials — see `src/lib/access.js`).
Routes marked "owner or collaborator" below accept either; routes marked
"owner-only" 404 for a collaborator just as they would for an unrelated user
(same not-403 existence-hiding convention as the rest of this API).

| Method | Path | Auth | What |
|---|---|---|---|
| POST | `/events` | required | `{ name }` → creates an event with a unique `guestSlug` and `expiresAt` stamped 90 days out (see "Event expiry" below). `403 { error }` if you already own `FREE_EVENT_LIMIT` (15) events — see "Plan limits" below. |
| GET | `/events` | required | List events you own AND events you collaborate on, each tagged with `role: "owner" \| "collaborator"`, with photo counts and `expires_at`. (No per-event storage numbers here — that would be an N+1 aggregation; the frontend can compute "X/15 events used" from this list's own length.) |
| GET | `/events/:id` | owner or collaborator | One event: `{ id, name, guestSlug, guestLink, createdAt, expires_at, photo_count, storage_used_bytes, storage_limit_bytes, role, drive_folder_url, drive_sync_enabled, last_drive_sync_at, beam_connected, drive_backup_enabled, drive_backup_available }` |
| DELETE | `/events/:id` | owner-only | Permanently deletes the event and everything under it (photos, faces, guest searches/feedback, zip downloads, collaborators, invites) plus the event's entire photo/thumbnail directory on disk. `204` on success |
| POST | `/events/:id/photos` | owner or collaborator | 30/hour/IP · **Breaking change:** multipart `files` (multiple) → now responds immediately with `202 { job_id }` instead of the old synchronous body; processing happens in-process, sequentially, in the background. Follow up with the SSE stream below to get progress and the final `photos_processed`/`faces_found`/`skipped` result (delivered as the terminal `done` event, same field names as the old response body). Each file is also checked against the event's 10GB free-plan storage cap (see "Plan limits" below) — a file that would push the event over the cap is skipped (added to `skipped`, reason `"... (event storage limit reached — 10GB free plan cap)"`) rather than blocking the rest of the batch. |
| GET | `/events/:id/uploads/:jobId/stream` | owner or collaborator | Server-Sent Events stream of `progress` events (`total`, `completed`, `current_file`, `photos_per_second`, `eta_seconds`, `faces_found_so_far`, `skipped_so_far`) for an upload job started above, ending in a terminal `done` or `error` event. If the job already finished before you connect, sends that last event immediately and closes. Also used for Drive import jobs (see below) — identical event shape. |
| POST | `/events/:id/import/drive` | owner or collaborator · 30/hour/IP | `{ folder_url }` (a public Google Drive folder share link) → lists every image in the folder and responds `202 { job_id, files_found }` immediately, then imports them in the background — same job/SSE mechanism as `POST /events/:id/photos` above (poll the same `/uploads/:jobId/stream` route with this `job_id`, identical `progress`/`done`/`error` event field names, so the frontend's upload-progress UI is reused unchanged). `400 { error }` if `folder_url` isn't a Drive folder link, if the folder isn't publicly viewable (Drive 403/404), or if `GOOGLE_DRIVE_API_KEY` isn't configured — fails fast before creating any job. Each file is still checked against the event's 10GB storage cap and content-sniffed, exactly like a direct upload. See "Google Drive import" below for the storage model. |
| GET | `/events/:id/photos` | owner or collaborator | List photos in an event |
| DELETE | `/events/:id/photos/:photoId` | owner or collaborator | Deletes one photo (its faces, DB row, and both the original + thumbnail files on disk). `204` on success, `404` if not found |
| GET | `/events/:id/analytics` | owner or collaborator | `{ total_searches, unique_guests, match_rate, feedback_count, daily_searches, daily_matches }` — the first four aggregated from that event's `GuestSearch`/`MatchFeedback` rows; `daily_searches`/`daily_matches` are zero-filled 30-day `[{ date: "YYYY-MM-DD", count }]` series (see `src/lib/dailyBuckets.js`) for trend charts |
| POST | `/events/:id/collaborators` | owner-only | `{ email }` → if a `User` with that email already exists, adds them as a collaborator immediately (`{ status: "added", email }`); otherwise creates (or reuses) a pending `EventInvite` and emails them an invite link (`{ status: "invited", email }`, a no-op console warning if `SMTP_HOST` isn't configured). 400 if `email` is missing/malformed or matches the owner's own email. |
| GET | `/events/:id/collaborators` | owner-only | `{ collaborators: [{ user_id, email, name }], pending_invites: [{ invite_id, email, invited_at }] }` |
| DELETE | `/events/:id/collaborators/:userId` | owner-only | Removes that collaborator. `204` on success, `404` if not a collaborator |
| DELETE | `/events/:id/invites/:inviteId` | owner-only | Cancels that pending invite. `204` on success, `404` if missing or already accepted (use the collaborator-removal route above for someone who already accepted) |
| GET | `/events/:id/beam/credentials` | owner or collaborator | `{ connected: false }`, or `{ connected: true, ftp_host, ftp_port, ftp_username, ftp_password }` if Beam (camera-to-cloud live upload) is already set up — see "Beam" below. |
| POST | `/events/:id/beam/credentials` | owner or collaborator · 20/hour/IP | Generates fresh Beam credentials (first setup, or a "Regenerate" — this simply overwrites the previous ones, which stop working immediately). Same response shape as the `GET` above. |
| DELETE | `/events/:id/beam/credentials` | owner or collaborator | Revokes Beam access — the camera's saved FTP settings stop authenticating. Doesn't touch photos already ingested. `204` on success. |
| GET | `/events/:id/live/stream` | owner or collaborator | Server-Sent Events stream of `photo_added`/`photo_skipped` events as Beam ingests camera captures — lets an open event page update its gallery live during a shoot. Purely additive; the gallery still loads fine without ever opening this stream. |
| POST | `/events/:id/drive-backup/toggle` | owner or collaborator | **Advanced/beta** — see "Drive backup" below. `{ enabled }` → turns on/off mirroring Beam captures into this event's connected Drive folder using the platform's single Drive account. `400` if no Drive folder is connected yet or that platform account isn't configured; `403` if the event's owner isn't on `DRIVE_BACKUP_BETA_EMAILS`. |
| POST | `/events/:id/drive-backup/reclaim-now` | owner or collaborator | **Advanced/beta** — "I've made my copies, free up space." Immediately reclaims (Drive→VPS, then deletes the Drive copy) every eligible photo in this event, regardless of the automatic 2-day timer. `{ reclaimed_count }` |

### Guest (public)

Every route below is unauthenticated by design (guests never log in), so
each is rate-limited per-IP and — for anything that accepts a file — content
is validated by sniffing actual magic bytes, not just trusting the declared
extension (`src/lib/fileValidation.js`; a renamed non-image file is rejected
even with a `.jpg` name). This is deliberately lightweight (no ClamAV/real
antivirus scanning) — see "What this deliberately does NOT do yet" below.

**Expiry**: every event soft-closes to guests 90 days after creation (see
"Event expiry" below). `GET /e/:slug` still returns `200` for an expired
event (with `expired: true`) so the frontend can render a graceful
"this event's search window has closed" message. Every other guest route in
this section — search/feedback/download/download-by-email/download-status —
enforces this server-side too: `410 { error: "This event's guest access has
closed." }` if the event has expired. This is defense-in-depth in case the
frontend doesn't check the `expired` flag first.

| Method | Path | Rate limit | What |
|---|---|---|---|
| GET | `/e/:slug` | — | Event's public name + owning photographer's branding: `{ id, name, studio_name, logo_url, brand_color, expired }`. 404 if the slug doesn't exist |
| POST | `/e/:slug/search` | 10/5min/IP | **Breaking change:** multipart `selfies` (1-3 files, repeated field — replaces the old single `selfie` field) + optional text field `guest_client_id` → averages each selfie's largest-face embedding (renormalized to unit length) as the query, using the event's adjustable match threshold. A selfie that fails the extension/content-type check is skipped (not the whole request); if all selfies fail or none have a detectable face, `422`. Response: `{ search_id, faces_detected_in_selfie, matches: [...] }` — same match shape as before, with `search_id` added. Persists a `GuestSearch` row per call (used by feedback + analytics below). `410` if the event has expired. |
| POST | `/e/:slug/feedback` | 30/15min/IP | `{ search_id, photo_id }` → guest reporting a match as wrong; nudges that event's match threshold up slightly and records a `MatchFeedback` row. Responds `{ ok: true, new_threshold }`. 404 if the search doesn't exist or belongs to a different event. `410` if the event has expired. |
| POST | `/e/:slug/download` | 20/15min/IP | `{ photo_ids: [...] }` (from a prior search's matches) → streams a zip of those photos immediately. `410` if the event has expired. |
| POST | `/e/:slug/download/email` | 20/15min/IP | `{ photo_ids: [...], email }` → for large/slow selections: creates a `ZipDownload` row and responds `{ ok: true }` right away, then builds the zip to disk in the background and emails the guest a download link (a no-op console warning if `SMTP_HOST` isn't configured yet). `410` if the event has expired. |
| GET | `/e/:slug/downloads/:downloadId` | — | Streams the pre-built zip once ready. `409 { error }` if the `ZipDownload` isn't `status: "ready"` yet, `404` if it doesn't exist or belongs to a different event, `410` if the event has expired |
| POST | `/e/:slug/alerts/subscribe` | 10/15min/IP | `{ guest_client_id, channel: "email" \| "whatsapp", contact }` → opts this guest in to being notified if more photos of them show up later in this event (see "Guest match alerts" below). Upserts — searching again and subscribing again just updates the same subscription. `400` if `contact` isn't a valid email/E.164 phone number for the chosen channel. |
| POST | `/e/:slug/alerts/unsubscribe` | 10/15min/IP | `{ guest_client_id }` → turns off alerts for this guest on this event. Idempotent, `{ ok: true }` even if there was no subscription. |
| POST | `/e/:slug/whatsapp/send-link` | 5/15min/IP | `{ phone }` → sends this event's gallery link to that phone number over WhatsApp, once, right now — distinct from the alert subscription above (no ongoing notifications). A no-op console warning if Twilio isn't configured yet (see "WhatsApp delivery" below). `410` if the event has expired. |

### Invites (collaborator invite acceptance)
| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/invites/:token` | — | Public preview of a pending invite: `{ event_id, event_name, email }`. 404 if the token doesn't exist or has already been accepted |
| POST | `/invites/:token/accept` | required | Accepts the invite for the currently logged-in user. 403 if the logged-in user's email doesn't match the invite's email (`{ error: "This invite was sent to a different email address" }`). 404 if missing/already accepted. On success, adds an `EventCollaborator` row, stamps `acceptedAt`, and responds `{ ok: true, event_id }`. Note: a brand-new user's matching pending invites are also auto-accepted right at registration (`POST /auth/register`) as a convenience — this route is a redundant safety net for that case and the primary path for an invite sent to an existing account. |

### Branding (photographer)
| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/branding` | required | `{ studio_name, logo_url, brand_color }` for the current user |
| POST | `/branding` | required | Multipart: text fields `studio_name`, `brand_color` (hex, e.g. `#aa3bff`), optional file field `logo` → updates the photographer's studio-wide branding (applies to all of their events' guest pages), overwriting any previous logo. Responds with the same shape as `GET /branding` |

### Files
| Method | Path | What |
|---|---|---|
| GET | `/files/events/:eventId/photos/:photoId` | Serves the actual image file |
| GET | `/files/branding/:userId/logo` | Public — serves a photographer's studio logo (guests need to see it on the guest page without logging in). 404 if no logo is set |

## Plan limits (free tier, billing coming soon)

There's no real Stripe integration yet, but two free-tier limits are
hard-enforced in the meantime (`src/lib/planLimits.js`):

- **Event count**: a photographer can own at most `FREE_EVENT_LIMIT` (15)
  events. `POST /events` responds `403 { error: "You've reached the free plan
  limit of 15 events. Upgrade coming soon." }` once that's hit, and the event
  is not created. This only counts events you *own* — events you collaborate
  on don't count against your own limit.
- **Per-event storage**: each event has a `FREE_EVENT_STORAGE_BYTES` (10GB)
  cap on original photo bytes (thumbnails aren't counted — negligible size).
  During `POST /events/:id/photos`, each file is checked against the running
  total *before* it's sent to face-engine; a file that would push the event
  over the cap is skipped (same `skipped[]` mechanism as unsupported-type/
  bad-content skips) with reason `"... (event storage limit reached — 10GB
  free plan cap)"` — it doesn't fail the rest of the batch. `GET /events/:id`
  exposes `storage_used_bytes` and `storage_limit_bytes` so the frontend can
  show a usage meter.

## Event expiry (90-day soft close)

Every event gets an `expiresAt` stamped at creation (`createdAt` + 90 days,
`EVENT_EXPIRY_DAYS` in `src/lib/expiry.js`). Once past that date:

- **Nothing is deleted.** The photographer (owner or collaborator) keeps
  full access to the event, its photos, and analytics regardless of expiry —
  `GET/DELETE /events/:id` and friends are completely unaffected.
- **Guest access soft-closes.** `GET /e/:slug` still returns `200` with an
  `expired: true` flag so the frontend can show a "this event's search
  window has closed" message instead of a bare error. Every other
  guest-facing route (search/feedback/download/download-by-email/
  download-status) enforces this server-side with a `410 { error: "This
  event's guest access has closed." }`, checked immediately after loading the
  event — before any other work.

`GET /events` and `GET /events/:id` both expose `expires_at` to the
photographer so the frontend can show "closes in N days" ahead of time.

## Platform admin (operator-only, not a general role system)

A small `/admin/*` surface for the platform operator (you) to see aggregate
usage — total users/events/photos/storage/searches and the 20 most recently
created events. Gated by `ADMIN_EMAILS` (comma-separated allowlist env var),
checked against the JWT's `email` claim — no DB round-trip needed
(`src/middleware/admin.js`). This is deliberately *not* a general role/permission
system; it's a hardcoded allowlist for the operator's own use.

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/admin/overview` | admin allowlist only | `{ total_users, total_events, total_photos, total_storage_bytes, total_searches, daily_signups, daily_events, recent_events: [{ id, name, owner_email, photo_count, created_at }] }` — `daily_signups`/`daily_events` are zero-filled 30-day `[{ date, count }]` series (`src/lib/dailyBuckets.js`) for trend charts. `403 { error: "Admin access required" }` for any authenticated non-admin user; `401` if not authenticated at all. |

## Verifying the full flow (do this on the VPS)

This wasn't run end-to-end locally — no pgvector-capable Postgres was
available on the dev machine (native Windows Postgres doesn't have prebuilt
pgvector binaries, and installing the build toolchain / WSL2 for a one-time
local test wasn't worth it given the real target is this Linux VPS, where
`pgvector` is a normal `apt`/build install). Once deployed there:

1. `psql` in and confirm the extension is actually usable:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   SELECT extversion FROM pg_extension WHERE extname = 'vector';  -- must be >= 0.5.0 for the HNSW index
   ```
2. `npx prisma migrate deploy` — applies the schema + the HNSW index.
3. Start `face-engine` (`uvicorn app.main:app --port 8001`, bound to `127.0.0.1`), then this server (`npm start`), then `web` (built + served, pointed at this server's public URL).
4. Manual smoke test:
   - `POST /auth/register` (or the web `/register` page) → confirm the session cookie is set and `GET /auth/me` returns the new user.
   - Create an event, bulk-upload a handful of test photos → response should show `faces_found > 0` for photos with visible faces.
   - Open the event's guest link in an incognito window (no auth) → `GET /e/:slug` should return the event name.
   - Upload a selfie of someone in the test photos → matches should come back sorted by similarity, all >= `FACE_MATCH_THRESHOLD`.
   - Upload a selfie of someone *not* in the photos → expect zero or near-zero matches.
   - Confirm a second photographer account can't see or upload to the first one's events (owner-scoping check).

## Thumbnails

Every uploaded photo gets a resized JPEG preview (~480px on the long edge,
quality 78) generated at upload time via `sharp`/libvips (`src/lib/thumbnails.js`),
saved alongside the original under `STORAGE_DIR/events/{eventId}/thumbs/`.
`GET /events/:id/photos` and `POST /e/:slug/search`'s matches both include a
`thumbnail_url` field for gallery grids; `GET /files/events/:eventId/photos/:photoId/thumb`
serves it, falling back to the full-size original if generation failed or a
photo predates this feature. Downloads/zips/watermarked shares still use the
full-size original (`url`) — only grid previews use the thumbnail.

## Google Drive import

An alternative to browser upload: a photographer pastes a public Google
Drive folder link (`POST /events/:id/import/drive`, see the table above)
instead of picking files from disk. `src/lib/googleDrive.js` lists every
image directly inside that folder via Drive API v3, then for each one:
downloads its bytes just long enough to run face detection
(`lib/faceEngine.js`, identical to a direct upload) and generate a thumbnail
(`lib/thumbnails.js`, completely unchanged) — **but the full-resolution
original is never written to local disk.** Only the thumbnail and the
detected faces' embeddings are kept permanently; the `Photo` row gets
`storagePath: null` and `driveFileId: <the Drive file's id>` instead of a
local path. Each file still counts against the event's 10GB free-plan
storage cap (`lib/planLimits.js`) using the byte size Drive reports for it,
exactly like a direct upload.

When the full-resolution original is needed later — viewing it full-size,
downloading it, or zipping a guest's selected matches — the server re-fetches
it live from Drive on demand instead of reading it off disk:

- `GET /files/events/:eventId/photos/:photoId` falls back to a Drive
  download (streamed back as the response body) when `storagePath` isn't set
  or the file is missing on disk, as long as `driveFileId` is set. If the
  Drive fetch fails (folder made private, file deleted, key unconfigured),
  responds a clean `404` rather than erroring.
- `lib/zip.js`'s `streamPhotosZip` and `buildPhotosZipToDisk` do the same
  fallback per-photo when building a zip (instant guest download or the
  email-download flow) — a Drive-backed photo whose download fails is simply
  left out of that zip rather than failing the whole download.

This means a Drive import trades a slower/network-dependent full-res fetch
for zero local disk usage on originals — appropriate for photographers who
already have their shoot backed up to Drive and don't want PandaSpot to
duplicate gigabytes of full-res files on its own VPS.

**Not verified against a real Drive folder.** No `GOOGLE_DRIVE_API_KEY` or
public test folder was available in this environment — `GOOGLE_DRIVE_API_KEY`
is unset here, so only the "unconfigured key" error path
(`POST /events/:id/import/drive` responding a clean `400`, not crashing) was
verified live. The actual Drive API v3 request shapes in
`listImageFiles`/`downloadFile` (the `files.list` query/fields params and the
`files.get?alt=media` download) were implemented by careful reading of the
Drive API v3 docs but need a real end-to-end test — a real API key and a
real public folder with a mix of file types/sizes — before this feature ships
to real users.

## Beam (camera-to-cloud live upload)

A third way photos get into an event, alongside browser upload and Drive
import: the photographer's own camera uploads directly, over FTP, the
instant each shot is taken — the same mechanism FotoOwl's "Beam" and
press/sports photography workflows use. No proprietary hardware or
companion app is needed; most professional mirrorless/DSLR bodies (Sony
a9/a7 IV+, Canon R3/R5/R6 II, Nikon Z8/Z9/D5/D6, and others) have "FTP
transfer" built into their own network settings menu, and older/consumer
bodies can add it via an aftermarket WiFi transmitter grip.

**How it works:**

1. The photographer generates event-scoped credentials
   (`POST /events/:id/beam/credentials`, see the table above) — a random
   `evt_...` username and password, stored as **plaintext** in
   `Event.ftpUsername`/`ftpPassword` (see `schema.prisma`'s comment on those
   columns for why — unlike a login password, the photographer needs to read
   it back to type into their camera, and it's a scoped upload-only token,
   not an account credential).
2. Those go into the camera's FTP transfer settings (host = `FTP_PUBLIC_HOST`,
   port = `FTP_PORT`, plus the username/password).
3. `src/lib/ftpBeam.js` runs an in-process FTP server (`ftp-srv`). On login,
   it looks up the event by username/password and roots that connection's
   entire filesystem view at a staging directory unique to that event
   (`storage/beam-incoming/<eventId>/`) — a camera can only ever write into
   (or see) its own event's folder, never anything else on disk.
4. A `chokidar` watcher on that staging tree picks up each file once it
   stops changing size (`awaitWriteFinish`, so a file mid-transfer is never
   read early), then runs it through `lib/captureIngest.js` — the exact same
   validation/`detectFaces`/`generateThumbnail`/`Photo.create` pipeline as a
   direct browser upload (unlike a Drive import, the original **is** kept in
   normal on-disk storage, since there's no external Drive folder backing
   it up). The staging file is deleted afterward either way.
5. On success, `lib/liveEvents.js` publishes a `photo_added` event; an open
   event page (subscribed via `GET /events/:id/live/stream`) prepends it to
   the gallery immediately, no polling or refresh needed.

**Infra requirements before relying on this for a real event:**

- `FTP_PORT` (control) and the whole `FTP_PASV_MIN`–`FTP_PASV_MAX` passive
  range need to be opened on the VPS firewall — this is a hosting/network
  task, not a code change, and the feature silently can't accept uploads
  from outside the VPS until it's done.
- `FTP_PUBLIC_HOST` must be set to the VPS's public IP/hostname, or passive
  transfers (which almost every camera and FTP client use) will fail even
  with the ports open.
- Plain FTP sends the event's username/password unencrypted. Set
  `FTP_TLS_CERT_PATH`/`FTP_TLS_KEY_PATH` to run FTPS instead — left unset,
  the server logs a startup warning and runs unencrypted, an accepted
  short-term risk since each credential is scoped to write-only access to
  one event's folder.

**Verified locally**: FTP login against real event credentials, per-event
root isolation, file upload via `curl`, the chokidar pickup +
`captureIngest.js` pipeline invocation, and staging-file cleanup — all
confirmed working end-to-end (the only failure seen was `detectFaces`
correctly erroring because no local face-engine instance was running,
which is unrelated to Beam itself). **Not yet verified against a real
camera** or over a real network with `FTP_PUBLIC_HOST`/passive ports
configured — do that once deployed.

## Guest match alerts

After a guest's first search, they can opt in (`POST /e/:slug/alerts/subscribe`
— see the table above) to be notified if more photos of them show up later
in the same event, instead of needing to remember to come back and re-search
manually. This is the natural follow-up to Beam: photos can now keep landing
live during a shoot, but until this feature nothing outside the
photographer's own screen knew that happened.

`src/lib/guestAlerts.js` is the whole feature: a `GuestAlertSubscription` row
per `(eventId, guestClientId)` pair (upserted, so re-subscribing just updates
it), and `checkAndNotifyForNewPhotos(event, newPhotoIds)` — called after
every photo-ingestion path finishes a batch (`processUploadJob` in
`routes/events.js`, `processDriveImportJob`/`processDriveSyncJob` in
`lib/driveSync.js`) and after each single Beam capture
(`lib/captureIngest.js`). For every active subscription, it re-checks that
guest's most recent search embedding against only the newly-added photos'
faces (a single pgvector query — the embedding itself never leaves
Postgres, same reasoning as `lib/faces.js`'s `searchSimilarPhotos`), and
sends an email or WhatsApp message if any of them clear the event's match
threshold. A guest is never notified more than once every 15 minutes, so a
burst of Beam captures during a shoot produces one ping, not a flood.

Notification failures (unconfigured SMTP/Twilio, a bad phone number, a
transient send error) are logged and swallowed — never allowed to affect the
upload/import/capture they were triggered by.

## WhatsApp delivery

`src/lib/whatsapp.js` is a small REST wrapper around Twilio's WhatsApp
messaging API (a plain `fetch` with Basic Auth — no SDK dependency, same
lightweight style as `lib/googleDrive.js`'s raw Drive API calls). Left
unconfigured (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_WHATSAPP_FROM`
unset), `sendWhatsAppMessage` logs what it would have sent instead of
sending — same safe no-op pattern as `lib/mailer.js` when `SMTP_HOST` is
unset, so every route that uses it still responds normally during local dev.

Two features use it: the `whatsapp` channel option on guest match alerts
above, and the standalone `POST /e/:slug/whatsapp/send-link` — a guest
tapping "send me this link on WhatsApp" once, with no ongoing subscription.

**Verified locally** (server responding correctly, logging the would-be
message) with Twilio left unconfigured — an actual Twilio account, a
WhatsApp-enabled sender, and (for a non-sandbox number) template approval are
needed before this can send a real message; get those before relying on it
for a real event.

## Drive backup (advanced, beta)

The other direction from Drive import/sync: mirroring photos PandaSpot
*produces* — specifically, Beam camera captures — into an event's connected
Drive folder. Deliberately gated behind `DRIVE_BACKUP_BETA_EMAILS` (same
allowlist pattern as `ADMIN_EMAILS`) — it hasn't been tested against a real
Google account yet, and its storage model (below) is a real, disclosed
tradeoff rather than a permanent archive.

**One platform-wide Drive account, not per-photographer OAuth.** This
deliberately does *not* ask each photographer to connect their own Google
account. Instead, a single Google account — the operator's own — is
connected once (`GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN`), and every event's Beam
captures upload through that one account. This works because Drive's
"Anyone with the link — Editor" folder permission grants write access to
*any* authenticated Google account holding the link, not just explicitly
named collaborators — so the platform account's uploads succeed in a
photographer's folder the same way a person opening the link and dragging a
file in would, with no per-photographer consent flow needed at all.

**Setup (one-time, admin-only):** an `ADMIN_EMAILS` account visits
`GET /auth/google/drive-backup/connect` in a browser (a full-page redirect
to Google's consent screen, requesting only the narrow `drive.file` scope —
access limited to files/folders this account creates, never its whole
Drive), then `GET /auth/google/drive-backup/callback` renders the resulting
refresh token once for the admin to copy into the server's `.env` as
`GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN` and restart — the token is never stored
in the database, matching every other credential in this file. Per event,
`POST /events/:id/drive-backup/toggle` (photographer, beta-gated) turns
mirroring on/off — 400s if no Drive folder is connected yet or the platform
account itself isn't configured. When on, each Beam capture
(`lib/captureIngest.js`) skips saving the full-res original locally at all
and instead calls `lib/driveBackup.js`'s `uploadToDriveFolder` (falling
back to normal local storage if the Drive upload fails, so a capture is
never lost) — the `Photo` row gets `driveFileId` set and
`platformDriveBackup: true`, the same shape as a Drive *import* but flagged
distinctly, since these rows are NOT kept forever.

**Why not forever — the reclaim/purge lifecycle (`lib/driveBackupRetention.js`):**
because every uploaded file is owned by the one platform account, its bytes
count against *that one account's* Drive quota — shared across every event
using the feature, not scoped per photographer. So the platform's Drive
storage is treated as a temporary relay, not a permanent archive, on a fixed
clock from each photo's capture time:

- **Day 0** — captured, uploaded to the photographer's Drive folder.
- **~6 hours after the last capture** (inferred "this shoot looks
  finished" from `Event.lastBeamCaptureAt` going quiet) — a one-time email
  to the studio owner (`sendDriveBackupReclaimNoticeEmail`): open the Drive
  folder, select all, **Make a copy** — Drive's own native action, which
  creates copies owned by *them*, in *their* storage, fully independent of
  the platform account's copy. No API work needed for the copy itself.
- **Day 2** — any photo not yet copied gets its Drive file deleted (to
  reclaim the platform account's quota) but first downloaded back to the
  VPS as a last-resort safety net — still recoverable via a normal PandaSpot
  download, just no longer sitting in Drive.
- **Day 7** — deleted everywhere, for good: the VPS copy, its thumbnail, its
  `Face` rows, the `Photo` row itself. This also removes it from guest
  search, not just full-res access — a photographer who hasn't saved their
  own copy by day 7 has genuinely lost it, by design (the platform was
  never the archive).

`POST /events/:id/drive-backup/reclaim-now` lets the studio owner (or a
collaborator) trigger the day-2 step immediately — "I've already made my
copies, free up space now" — rather than waiting for the automatic sweep;
it doesn't skip the day-7 purge, so there's still a window to just download
directly from PandaSpot if needed. The retention sweep itself
(`runDriveBackupRetentionSweep`) runs hourly via
`startDriveBackupRetentionScheduler`.

**Not yet verified against a real Google account** — the OAuth
exchange/refresh/upload/delete code was written against Google's documented
APIs but needs a real `GOOGLE_CLIENT_SECRET` + refresh token and a real Beam
capture to confirm end-to-end before trusting it for a real event.

## What this deliberately does NOT do yet

Same spirit as the original face-search spike this replaces: no *real*
billing (Stripe et al) — free-tier event count and per-event storage limits
are hard-enforced (see "Plan limits" above), but there's no payment flow to
actually upgrade past them yet. Also still missing: real antivirus scanning
(upload validation is content-type/magic-byte sniffing only — a deliberate
lightweight choice over standing up a ClamAV daemon on the VPS for this
pass), no CDN. Rate limiting, upload content validation, password reset,
soft email verification, Google Sign-In, thumbnailing, event expiry, and a
platform admin overview are now in place (see the tables/sections above) —
MVP first, these were the deliberately-deferred items from previous passes,
now done; the ones above remain the next steps before a real public launch.
