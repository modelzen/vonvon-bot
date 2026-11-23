import {createHash} from 'node:crypto';
import {canonicalizeRichRecipeContent, decodeRichRecipeContent, RECIPE_RICH_LIMITS, recipeRichContentSchema,
  type CanonicalRichRecipeContent, type RecipeRichContent, type RecipeRichPartDescriptor} from '@vonvon/protocol';
import {verifiedDocumentText} from './rich-source-files';

export interface EffectiveRecipeSkills {
  skills: RecipeRichContent['skills'];
  files: (Omit<RecipeRichContent['files'][number], 'text'> & {text: {kind:'inline'; value:string}})[];
}
export interface RecipeSkillSelection {
  graph: CanonicalRichRecipeContent;
  documents: ReadonlyMap<string,Buffer>;
  texts: ReadonlyMap<string,string>;
}
function documentId(sha: string): string {
  const id = Buffer.from(sha.slice(0,32),'hex');
  id[6] = (id[6]! & 15) | 0x80;
  id[8] = (id[8]! & 63) | 0x80;
  const hex = id.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function selectRecipeSkills(value: EffectiveRecipeSkills, publicFields: RecipeRichContent['public']): RecipeSkillSelection {
  if (!Array.isArray(value.files) || value.files.length > RECIPE_RICH_LIMITS.files || !Array.isArray(value.skills) || value.skills.length > RECIPE_RICH_LIMITS.skills) throw new Error('Invalid effective skill count');
  const documents = new Map<string,Buffer>();
  const texts = new Map<string,string>();
  const parts: RecipeRichPartDescriptor[] = [];
  const files = value.files.map(raw => {
    const file = recipeRichContentSchema.shape.files.element.parse(raw);
    if (file.text.kind !== 'inline') throw new Error('Resolve selected file bytes before staging');
    const data = Buffer.from(file.text.value);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const objectId = documentId(sha256);
    const previous = documents.get(objectId);
    if (previous && !data.equals(previous)) throw new Error('Local document ID collision');
    if (!previous) {
      documents.set(objectId, data);
      texts.set(objectId,file.text.value);
      parts.push({kind:'text', objectId, bytes:data.length, sha256, mediaType:'text/plain;charset=utf-8'});
    }
    return {...file, text:{kind:'part' as const, objectId}};
  });
  const graph = canonicalizeRichRecipeContent({format:'rich-v2', schemaVersion:2, public:publicFields,
    settings:[], rules:[], skills:value.skills, files, tasks:[], memories:[], setup:[], parts});
  return {graph, documents, texts};
}
export async function restoreRecipeSelection(manifest: Buffer, publicFields: RecipeRichContent['public'], load: (names: string[])=>Promise<Map<string,Buffer>>): Promise<RecipeSkillSelection> {
  const parsed = decodeRichRecipeContent(manifest);
  const docs = parsed.referencedParts.length ? await load(parsed.referencedParts.map(part => `effective/${part.objectId}`)) : new Map();
  const files = parsed.content.files.map(file => {
    if (file.text.kind !== 'part') throw new Error('Invalid effective document reference');
    const bytes = docs.get(`effective/${file.text.objectId}`);
    if (!bytes) throw new Error('Missing effective document');
    return {...file,text:{kind:'inline' as const, value:verifiedDocumentText(bytes)}};
  });
  const selection = selectRecipeSkills({skills:parsed.content.skills, files}, publicFields);
  if (!Buffer.from(selection.graph.canonicalUTF8).equals(manifest)) throw new Error('Invalid effective document snapshot');
  return selection;
}
export function recipeSelectionMetadata(manifest: Buffer, publicFields: RecipeRichContent['public']): CanonicalRichRecipeContent {
  const parsed = decodeRichRecipeContent(manifest);
  const content = parsed.content;
  if (content.files.some(file=>file.text.kind!=='part') || parsed.referencedParts.some(part=>part.kind!=='text'||part.objectId!==documentId(part.sha256))) throw new Error('Invalid effective document reference');
  const expected = canonicalizeRichRecipeContent({format:'rich-v2',schemaVersion:2,public:publicFields,settings:[],rules:[],tasks:[],memories:[],setup:[],skills:content.skills,files:content.files,parts:content.parts});
  if (!Buffer.from(expected.canonicalUTF8).equals(manifest)) throw new Error('Invalid effective document snapshot');
  return parsed;
}
