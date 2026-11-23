import {createHash} from 'node:crypto';
import {canonicalCaselessSegment, isPortableDocumentName, recipeRichTextSchema, recipeRichIsUnicode, RECIPE_RICH_LIMITS} from '@vonvon/protocol';
import {recipeFileIO} from './rich-file-helper';

export interface RecipeFileSnapshot {
  readonly rootIdentity: string;
  readonly files: readonly {readonly name: string; readonly identity: string; readonly text: string; readonly bytes: number; readonly sha256: string}[];
}
export function verifiedDocumentText(bytes: Uint8Array): string {
  const value = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  if (!recipeRichTextSchema.safeParse({kind: 'inline', value}).success) throw new Error('Invalid recipe document text');
  return value;
}
export async function readSelectedRecipeFiles(approvedRoot: string, names: readonly string[], expected?: RecipeFileSnapshot): Promise<RecipeFileSnapshot> {
  if (names.length > RECIPE_RICH_LIMITS.files) throw new Error('Too many selected recipe files');
  const selected = [...names];
  const keys = new Set<string>();
  for (const name of selected) {
    if (typeof name !== 'string' || !recipeRichIsUnicode(name) || Buffer.byteLength(name) > 240 || !isPortableDocumentName(name)) throw new Error('Invalid selected document name');
    const key = name.split('/').map(canonicalCaselessSegment).join('/');
    if ([...keys].some(other => other === key || other.startsWith(key + '/') || key.startsWith(other + '/'))) throw new Error('Conflicting selected document names');
    keys.add(key);
  }
  const result = await recipeFileIO({operation: 'source', root: approvedRoot, names: selected, expectedRoot: expected?.rootIdentity});
  const files = (result.files ?? []).map((file, index) => {
    if (file.name !== selected[index]) throw new Error('Unexpected selected file');
    const bytes = Buffer.from(file.data, 'base64');
    const snapshot = {name: file.name, identity: file.identity, bytes: bytes.length, text: verifiedDocumentText(bytes), sha256: createHash('sha256').update(bytes).digest('hex')};
    const old = expected?.files[index];
    if (expected && (!old || old.identity !== file.identity || old.sha256 !== snapshot.sha256 || old.name !== file.name)) throw new Error('Selected recipe file changed');
    return Object.freeze(snapshot);
  });
  if (files.length !== selected.length || (expected && files.length !== expected.files.length)) throw new Error('Selected recipe files changed');
  return Object.freeze({rootIdentity: result.root, files: Object.freeze(files)});
}
