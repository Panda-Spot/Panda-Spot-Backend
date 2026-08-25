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
export const beamCredentialLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, limit: 20 }); // photographer Beam FTP credential generate/rotate
export const guestAlertLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 10 }); // guest alert subscribe/unsubscribe
export const guestWhatsAppLinkLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, limit: 5 }); // guest "send my gallery link via WhatsApp"
