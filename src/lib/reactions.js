// The full set of reaction types a guest can leave on a photo. Kept as a
// plain string column on PhotoLike (not a DB enum) so adding a new type
// here never needs a migration — just update this list and the frontend's
// matching icon/label map.
export const REACTION_TYPES = ["heart", "laugh", "wow", "clap", "fire"];

export function isValidReactionType(value) {
  return REACTION_TYPES.includes(value);
}
