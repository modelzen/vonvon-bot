const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const scheme = channel => channel === 'preview' ? 'vonvon-preview' : channel === 'stable' ? 'vonvon' : undefined;

export function recipeCreationUrl(channel) {
  const protocol = scheme(channel); return protocol ? protocol + '://recipes/create' : undefined;
}
export function recipeDraftsUrl(channel) {
  const protocol = scheme(channel); return protocol ? protocol + '://recipes/drafts' : undefined;
}
export function recipeHandoffUrl(channel, recipeId, versionId) {
  const protocol = scheme(channel);
  if (!protocol || typeof recipeId !== 'string' || typeof versionId !== 'string' || !uuid.test(recipeId) || !uuid.test(versionId)) return undefined;
  return protocol + '://recipes/' + recipeId.toLowerCase() + '/versions/' + versionId.toLowerCase() + '/handoff';
}
