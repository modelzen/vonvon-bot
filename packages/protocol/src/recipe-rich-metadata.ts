import {z} from 'zod';
import {recipePublicSchema} from './desktop-community.js';
import {canonicalizeRichRecipeContent} from './recipe-rich-codec.js';
import {recipeRichPartDescriptorSchema, type RecipeRichContent} from './recipe-rich.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const richMetadataInputSchema = z.object({
  transformVersion:z.literal(1), baseManifestSha256:hash, public:recipePublicSchema,
  logo:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('keep')}).strict(), z.object({kind:z.literal('remove')}).strict(),
    z.object({kind:z.literal('replace'),inputSha256:hash}).strict(),
  ]),
}).strict();
export type RichMetadataInput = z.infer<typeof richMetadataInputSchema>;
export const richMetadataLogoDescriptorSchema = recipeRichPartDescriptorSchema.options[1];
export const richMetadataCommitSchema = z.object({
  input:richMetadataInputSchema, baseCanonical:z.string().min(1).max(1398102).regex(/^[A-Za-z0-9_-]+$/),
  manifestId:z.string().uuid(), logoDescriptor:richMetadataLogoDescriptorSchema.optional(),
}).strict();
export type RichMetadataCommit = z.infer<typeof richMetadataCommitSchema>;

async function digest(value:unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash), byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function richMetadataInputDigest(input:RichMetadataInput) {
  const {name,summary,overview,version,access} = input.public;
  return digest([input.transformVersion,input.baseManifestSha256,name,summary,overview,version,access,
    input.logo.kind,input.logo.kind==='replace'?input.logo.inputSha256:null]);
}

async function logoIdentity(accountId:string,requestId:string,field:'item'|'origin') {
  const h = await digest(['rich-metadata-logo',1,accountId,requestId,field]);
  return h.slice(0,8)+'-'+h.slice(8,12)+'-8'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
}
export async function applyRichMetadata(base:RecipeRichContent,accountId:string,requestId:string,input:RichMetadataInput,
  logoDescriptor?:z.infer<typeof richMetadataLogoDescriptorSchema>) {
  const next = structuredClone(base);
  for(const field of ['name','summary','overview','version'] as const) next.public[field].value=input.public[field];
  if(input.logo.kind!=='keep') {
    next.parts=next.parts.filter(part=>part.kind!=='finalLogo');
    if(input.logo.kind==='remove') delete next.finalLogo;
    else {
      if(!logoDescriptor) throw new Error('Missing normalized Logo descriptor');
      next.parts.push(logoDescriptor);
      const identity=next.finalLogo??{itemId:await logoIdentity(accountId,requestId,'item'),originId:await logoIdentity(accountId,requestId,'origin')};
      next.finalLogo={...identity,objectId:logoDescriptor.objectId};
    }
  }
  return canonicalizeRichRecipeContent(next);
}
