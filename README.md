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

- **Auth**: photographer accounts (email/password via bcrypt), JWT in an
  httpOnly cookie. No guest accounts — guests reach an event via its public
  `guestSlug` link and never log in.
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

| Method | Path | Auth | Rate limit | What |
|---|---|---|---|---|
| POST | `/auth/register` | — | 5/hour/IP | `{ email, password, name }` → creates account, sets cookie, sends a (non-blocking) verification email |
| POST | `/auth/login` | — | 10/15min/IP | `{ email, password }` → sets cookie |
| POST | `/auth/logout` | — | — | Clears the cookie |
| GET | `/auth/me` | required | — | Current user, or 401 |
| POST | `/auth/email-verification/request` | required | — | Sends a fresh verification email. `{ ok: true }`, or `{ ok: true, already_verified: true }` if already verified (no email sent) |
| POST | `/auth/email-verification/:token/confirm` | — | — | Marks the account verified. `{ ok: true }`; `404` if the token is invalid/expired/already used |
| POST | `/auth/password-reset/request` | — | 10/15min/IP | `{ email }` → **always** responds `{ ok: true }` regardless of whether the account exists (no user-enumeration); emails a reset link if it does |
| POST | `/auth/password-reset/:token/confirm` | — | — | `{ password }` (min 8 chars) → sets the new password. `{ ok: true }`; `404` if the token is invalid/expired/already used |
| POST | `/auth/google` | — | — | `{ id_token }` (a Google Identity Services credential) → verifies it server-side, creates the account on first sign-in or links `googleId` to a matching existing email, sets the cookie. `503` if `GOOGLE_CLIENT_ID` isn't configured; `401` if the token doesn't verify |

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
| GET | `/events/:id` | owner or collaborator | One event: `{ id, name, guestSlug, guestLink, createdAt, expires_at, photo_count, storage_used_bytes, storage_limit_bytes, role }` |
| DELETE | `/events/:id` | owner-only | Permanently deletes the event and everything under it (photos, faces, guest searches/feedback, zip downloads, collaborators, invites) plus the event's entire photo/thumbnail directory on disk. `204` on success |
| POST | `/events/:id/photos` | owner or collaborator | 30/hour/IP · **Breaking change:** multipart `files` (multiple) → now responds immediately with `202 { job_id }` instead of the old synchronous body; processing happens in-process, sequentially, in the background. Follow up with the SSE stream below to get progress and the final `photos_processed`/`faces_found`/`skipped` result (delivered as the terminal `done` event, same field names as the old response body). Each file is also checked against the event's 10GB free-plan storage cap (see "Plan limits" below) — a file that would push the event over the cap is skipped (added to `skipped`, reason `"... (event storage limit reached — 10GB free plan cap)"`) rather than blocking the rest of the batch. |
| GET | `/events/:id/uploads/:jobId/stream` | owner or collaborator | Server-Sent Events stream of `progress` events (`total`, `completed`, `current_file`, `photos_per_second`, `eta_seconds`, `faces_found_so_far`, `skipped_so_far`) for an upload job started above, ending in a terminal `done` or `error` event. If the job already finished before you connect, sends that last event immediately and closes. |
| GET | `/events/:id/photos` | owner or collaborator | List photos in an event |
| DELETE | `/events/:id/photos/:photoId` | owner or collaborator | Deletes one photo (its faces, DB row, and both the original + thumbnail files on disk). `204` on success, `404` if not found |
| GET | `/events/:id/analytics` | owner or collaborator | `{ total_searches, unique_guests, match_rate, feedback_count }` aggregated from that event's `GuestSearch`/`MatchFeedback` rows |
| POST | `/events/:id/collaborators` | owner-only | `{ email }` → if a `User` with that email already exists, adds them as a collaborator immediately (`{ status: "added", email }`); otherwise creates (or reuses) a pending `EventInvite` and emails them an invite link (`{ status: "invited", email }`, a no-op console warning if `SMTP_HOST` isn't configured). 400 if `email` is missing/malformed or matches the owner's own email. |
| GET | `/events/:id/collaborators` | owner-only | `{ collaborators: [{ user_id, email, name }], pending_invites: [{ invite_id, email, invited_at }] }` |
| DELETE | `/events/:id/collaborators/:userId` | owner-only | Removes that collaborator. `204` on success, `404` if not a collaborator |
| DELETE | `/events/:id/invites/:inviteId` | owner-only | Cancels that pending invite. `204` on success, `404` if missing or already accepted (use the collaborator-removal route above for someone who already accepted) |

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
| GET | `/admin/overview` | admin allowlist only | `{ total_users, total_events, total_photos, total_storage_bytes, total_searches, recent_events: [{ id, name, owner_email, photo_count, created_at }] }`. `403 { error: "Admin access required" }` for any authenticated non-admin user; `401` if not authenticated at all. |

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
