import type {RecipePublic} from '@vonvon/protocol';

export type LogoInput = {kind: 'keep'} | {kind: 'remove'} | {kind: 'replace'; base64: string; preview: string};
type Edits = {public: Partial<RecipePublic>; logo?: LogoInput};
export type MetadataBuffer = {baseline: RecipePublic; submitted?: Edits; edits: Edits};

const publicFields = ['name', 'version', 'summary', 'overview', 'access'] as const satisfies readonly (keyof RecipePublic)[];
export function refreshMetadata(buffer: MetadataBuffer, baseline: RecipePublic): MetadataBuffer {
  if (buffer.submitted) return {...buffer, baseline};
  const patch = {...buffer.edits.public};
  for (const key of publicFields) if (patch[key] === baseline[key]) delete patch[key];
  return {baseline, edits: {...buffer.edits, public: patch}};
}
export function metadataBuffer(baseline: RecipePublic): MetadataBuffer {
  return {baseline, edits: {public: {}}};
}
export function metadataInput(buffer: MetadataBuffer) {
  const publicInfo = {...buffer.baseline, ...buffer.submitted?.public, ...buffer.edits.public};
  const logo: LogoInput = buffer.edits.logo ?? buffer.submitted?.logo ?? {kind: 'keep'};
  return {publicInfo, logo};
}
export function hasMetadataChanges(buffer: MetadataBuffer) {
  const {publicInfo, logo} = metadataInput(buffer);
  return logo.kind !== 'keep' || publicFields.some(key => publicInfo[key] !== buffer.baseline[key]);
}
export function editMetadata<K extends keyof RecipePublic>(buffer: MetadataBuffer, key: K, value: RecipePublic[K]): MetadataBuffer {
  const patch = {...buffer.edits.public, [key]: value};
  if (!buffer.submitted && value === buffer.baseline[key]) delete patch[key];
  return {...buffer, edits: {...buffer.edits, public: patch}};
}
export function editLogo(buffer: MetadataBuffer, logo: LogoInput): MetadataBuffer {
  return {...buffer, edits: {...buffer.edits, logo}};
}
export function beginMetadataSave(buffer: MetadataBuffer): MetadataBuffer {
  return {...buffer, submitted: buffer.edits, edits: {public: {}}};
}
export function rejectMetadataSave(buffer: MetadataBuffer): MetadataBuffer {
  return {baseline: buffer.baseline, edits: {public: {...buffer.submitted?.public, ...buffer.edits.public}, logo: buffer.edits.logo ?? buffer.submitted?.logo}};
}
export function acceptMetadataSave(buffer: MetadataBuffer, baseline: RecipePublic): MetadataBuffer {
  return {baseline, edits: buffer.edits};
}
