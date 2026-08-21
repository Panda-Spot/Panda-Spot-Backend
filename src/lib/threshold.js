export const MIN_THRESHOLD = 0.3;
export const MAX_THRESHOLD = 0.55;
export const ADJUST_STEP = 0.01;

/**
 * Resolves the cosine-similarity cutoff to use for a given event: the
 * event's own override if a guest's "not me" feedback has nudged it,
 * otherwise the global FACE_MATCH_THRESHOLD env default.
 */
export function getEffectiveThreshold(event) {
  const base = parseFloat(process.env.FACE_MATCH_THRESHOLD || "0.36");
  return event.matchThreshold ?? base;
}

/**
 * Called when a guest reports a match as wrong. Nudges the event's threshold
 * up by ADJUST_STEP (bounded at MAX_THRESHOLD) since a false positive at or
 * above the current threshold is evidence it's a bit too permissive for this
 * specific event (lighting, camera, crowded group shots, etc). Returns the
 * new threshold.
 */
export async function adjustThresholdOnFeedback(prisma, event) {
  const current = getEffectiveThreshold(event);
  const next = Math.min(MAX_THRESHOLD, current + ADJUST_STEP);
  await prisma.event.update({ where: { id: event.id }, data: { matchThreshold: next } });
  return next;
}
