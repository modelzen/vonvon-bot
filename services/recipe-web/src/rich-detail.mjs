import {createHash} from 'node:crypto';
import {z} from 'zod';
import {
  RECIPE_RICH_LIMITS, recipeDetailSchema, recipePublicSchema, recipeSummarySchema,
  recipeRichManifestObjectSchema, recipeRichReleaseSchema, recipeRichTextSchema, verifyRichRecipeRelease,
} from '../../../packages/protocol/src/index.ts';
import {staticLogoFormat} from '../../recipe-api/src/logo-format.mjs';

const detail = z.object({
  recipeId: z.string().uuid(), versionId: z.string().uuid(), revision: z.number().int().positive(),
  format: z.literal('rich-v2'), state: z.literal('listed'), visibility: z.enum(['intro', 'full']),
  public: recipePublicSchema, creator: recipeSummarySchema.shape.creator.unwrap(),
  hasDisplayLogo: z.boolean(), owned: z.boolean(), acquired: z.boolean(),
  manifest: recipeRichManifestObjectSchema.optional(), release: recipeRichReleaseSchema.optional(),
}).strict();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => {throw new Error('Invalid rich recipe response');};
function match(bytes, descriptor) {
  if (bytes.length !== descriptor.bytes || sha(bytes) !== descriptor.sha256) invalid();
}

export async function richDetail(raw, recipeId, versionId, read) {
  const data = detail.parse(raw);
  if (data.recipeId !== recipeId || data.versionId !== versionId) invalid();
  const permitted = data.public.access === 'direct' || data.owned || data.acquired;
  if (permitted !== (data.visibility === 'full')) invalid();
  const {state, visibility, manifest, release, ...view} = data;
  if (!permitted && (manifest || release)) invalid();
  if (permitted) {
    if (!manifest || !release || release.recipeId !== recipeId || release.versionId !== versionId ||
        release.revision !== data.revision || release.access !== data.public.access || release.authorId !== data.creator.authorId ||
        manifest.sha256 !== release.contentSha256) invalid();
    const bytes = await read(`/v2/versions/${versionId}/objects/${manifest.objectId}`, RECIPE_RICH_LIMITS.logicalBytes);
    match(bytes, manifest);
    const document = await verifyRichRecipeRelease(release, bytes);
    for (const [field, value] of Object.entries(document.content.public)) if (value.value !== data.public[field]) invalid();
    const texts = {};
    for (const descriptor of document.referencedParts.filter(part => part.kind === 'text')) {
      const member = await read(`/v2/versions/${versionId}/objects/${descriptor.objectId}`, descriptor.bytes);
      match(member, descriptor);
      const value = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(member);
      recipeRichTextSchema.parse({kind: 'inline', value});
      texts[descriptor.objectId] = value;
    }
    view.rich = {content: document.content, texts, canonical: ''};
  }
  if (data.hasDisplayLogo) {
    const bytes = await read(`/v2/versions/${versionId}/display-logo`, RECIPE_RICH_LIMITS.logoBytes);
    staticLogoFormat(bytes, true);
    if (view.rich?.content.finalLogo) {
      const descriptor = view.rich.content.parts.find(part => part.objectId === view.rich.content.finalLogo.objectId);
      if (!descriptor) invalid();
      match(bytes, descriptor);
    }
    view.logo = 'data:image/webp;base64,' + bytes.toString('base64');
  }
  return recipeDetailSchema.parse(view);
}
