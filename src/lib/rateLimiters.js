import rateLimit from "express-rate-limit";

// In-memory store — single Node process, same documented limitation as
// lib/jobQueue.js's in-memory job registry. Counts reset on restart and
// aren't shared across multiple instances; that's an accepted MVP
// limitation, not an oversight (see server/README.md).

function makeLimiter({ windowMs, limit }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
      res.status(429).json({ error: "Too many requests — please try again later." });
    },
  });
}

export const authLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 10 }); // login + password-reset request
export const registerLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 5 }); // register
export const guestSearchLimiter = makeLimiter({ windowMs: 5 * 60 * 1000, limit: 10 }); // guest selfie search
export const guestDownloadLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 20 }); // guest zip download (instant + email)
export const guestFeedbackLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 30 }); // guest "not me" feedback
export const uploadLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 30 }); // photographer bulk photo upload
export const driveImportLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 30 }); // photographer Google Drive folder import
export const shootsCredentialLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 20 }); // photographer Shoots FTP credential generate/rotate
export const guestAlertLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 10 }); // guest alert subscribe/unsubscribe
export const guestWhatsAppLinkLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 5 }); // guest "send my gallery link via WhatsApp"
export const guestUploadLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 10 }); // guest crowdsourced photo upload
export const guestLikeLimiter = makeLimiter({ windowMs: 5 * 60 * 1000, limit: 60 }); // guest like/unlike toggle
export const guestCommentLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 20 }); // guest comment post

// MERGE (Studio-Verse Photo Selection, Phase 15 security review): the
// client-invite accept endpoint is public/unauthenticated and creates a
// real account from a user-supplied password — same risk profile as
// /auth/register, which already has registerLimiter. This was a real gap
// (added in Phase 7, no limiter applied) found during this review pass.
export const clientInviteLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 10 }); // client-invite preview + accept
