import { prisma } from "./prisma.js";

/**
 * Loads an event accessible to req.user — either as owner or as a
 * collaborator. Returns { event, role: "owner" | "collaborator" }, or writes
 * a 404 and returns null if the event doesn't exist or isn't accessible to
 * this user (same 404-not-403 choice as the rest of this codebase's
 * owner-scoping — don't leak existence of events you can't access).
 */
export async function loadAccessibleEvent(req, res) {
  const event = await prisma.event.findUnique({ where: { id: req.params.id } });
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }
  if (event.ownerId === req.user.id) {
    return { event, role: "owner" };
  }
  const collab = await prisma.eventCollaborator.findUnique({
    where: { eventId_userId: { eventId: event.id, userId: req.user.id } },
  });
  if (collab) {
    return { event, role: "collaborator" };
  }
  res.status(404).json({ error: "Event not found" });
  return null;
}
