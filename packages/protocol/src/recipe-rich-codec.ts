import {
  RECIPE_RICH_LIMITS, recipeRichContentSchema, recipeRichReleaseSchema, recipeRichIsUnicode, recipeRichUtf8Bytes,
  type RecipeRichContent, type RecipeRichPartDescriptor, type RecipeRichText,
} from './recipe-rich.js';
import {canonicalCaselessSegment} from './recipe-rich-filename.js';

export class RecipeRichValidationError extends Error {
  constructor(readonly code: 'invalid_json' | 'invalid_content' | 'noncanonical' | 'limit_exceeded' | 'invalid_reference', readonly field: string) {
    super(`${code}: ${field}`);
    this.name = 'RecipeRichValidationError';
  }
}
function fail(code: RecipeRichValidationError['code'], field: string): never {throw new RecipeRichValidationError(code, field);}

function checkJson(value: unknown, depth = 0, budget = {nodes: 0, bytes: 0}): void {
  if (depth > RECIPE_RICH_LIMITS.depth || ++budget.nodes > RECIPE_RICH_LIMITS.nodes) fail('limit_exceeded', 'json');
  if (typeof value === 'string') {
    if (!recipeRichIsUnicode(value)) fail('invalid_json', 'string');
    budget.bytes += recipeRichUtf8Bytes(value);
    if (budget.bytes > RECIPE_RICH_LIMITS.logicalBytes) fail('limit_exceeded', 'json.bytes');
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') fail('invalid_json', 'value');
  if (Array.isArray(value)) {
    if (value.length > RECIPE_RICH_LIMITS.nodes) fail('limit_exceeded', 'array');
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail('invalid_json', 'array');
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) fail('invalid_json', 'array.property');
      checkJson(descriptor.value, depth + 1, budget);
    }
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('invalid_json', 'object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !recipeRichIsUnicode(key)) fail('invalid_json', 'key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) fail('invalid_json', 'property');
    checkJson(descriptor.value, depth + 1, budget);
  }
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function checkWireDepth(value: string): void {
  let quoted = false, escaped = false, depth = 0;
  for (const character of value) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      if (++depth > RECIPE_RICH_LIMITS.depth) fail('limit_exceeded', 'json.depth');
    } else if (character === '}' || character === ']') depth--;
  }
}

export interface CanonicalRichRecipeContent {
  readonly content: RecipeRichContent;
  readonly canonical: string;
  readonly canonicalUTF8: Uint8Array;
  readonly referencedParts: readonly RecipeRichPartDescriptor[];
  readonly logicalBytes: number;
}

export function canonicalizeRichRecipeContent(input: unknown): CanonicalRichRecipeContent {
  checkJson(input);
  const result = recipeRichContentSchema.safeParse(input);
  if (!result.success) fail('invalid_content', result.error.issues[0]?.path.slice(0, 4).join('.') || 'content');
  const content = result.data;
  const identities = new Set<string>();
  const addIdentity = (item: {itemId: string}, field: string) => {
    if (identities.has(item.itemId)) fail('invalid_content', `${field}.itemId`);
    identities.add(item.itemId);
  };
  for (const [field, item] of Object.entries(content.public)) addIdentity(item, `public.${field}`);
  if (content.role) addIdentity(content.role, 'role');
  for (const collection of ['settings','rules','skills','files','tasks','memories','setup'] as const) {
    content[collection].forEach((item, index) => addIdentity(item, `${collection}.${index}`));
  }
  if (content.finalLogo) addIdentity(content.finalLogo, 'finalLogo');
  const fields = new Set<string>();
  for (const item of content.settings) {
    if (fields.has(item.field)) fail('invalid_content', `settings.${item.field}`);
    fields.add(item.field);
    if (item.field === 'presentation.cardDisplay') item.value?.blocks.forEach(block => addIdentity(block, 'cardDisplay.blocks'));
    if (item.field === 'permission.claude.requirement' && item.value.permissionMode === 'bypassPermissions' && item.value.network !== 'all') {
      fail('invalid_content', 'permission.claude.requirement.network');
    }
    if (item.field === 'permission.codex.requirement' && item.value.sandbox === 'danger-full-access' && !item.value.network) {
      fail('invalid_content', 'permission.codex.requirement.network');
    }
  }
  const descriptors = new Map<string, RecipeRichPartDescriptor>();
  for (const part of content.parts) {
    if (descriptors.has(part.objectId)) fail('invalid_reference', 'parts.objectId');
    descriptors.set(part.objectId, part);
  }
  const references = new Set<string>();
  const partFor = (objectId: string, kind: RecipeRichPartDescriptor['kind'], max: number, field: string): RecipeRichPartDescriptor => {
    const part = descriptors.get(objectId);
    if (!part || part.kind !== kind) fail('invalid_reference', field);
    if (part.bytes > max) fail('limit_exceeded', field);
    references.add(objectId);
    return part;
  };
  const textBytes = (value: RecipeRichText, max: number, field: string) => {
    const size = value.kind === 'inline' ? recipeRichUtf8Bytes(value.value) : partFor(value.objectId, 'text', max, field).bytes;
    if (size > max) fail('limit_exceeded', field);
    return size;
  };
  let readableBytes = Object.values(content.public).reduce((sum, field) => sum + recipeRichUtf8Bytes(field.value), 0);
  if (content.role) readableBytes += textBytes(content.role.text, 16384, 'role');
  content.rules.forEach((item, index) => textBytes(item.text, 16384, `rules.${index}`));
  content.memories.forEach((item, index) => textBytes(item.text, RECIPE_RICH_LIMITS.memoryBytes, `memories.${index}`));
  content.files.forEach((item, index) => textBytes(item.text, RECIPE_RICH_LIMITS.fileBytes, `files.${index}`));
  content.tasks.forEach((item, index) => {
    textBytes(item.instruction, 4000, `tasks.${index}`);
    if (item.spec.kind === 'weekly' && new Set(item.spec.days).size !== item.spec.days.length) fail('invalid_content', `tasks.${index}.spec.days`);
  });
  for (const step of content.setup) readableBytes += recipeRichUtf8Bytes(step.title) + recipeRichUtf8Bytes(step.instructions) + recipeRichUtf8Bytes(step.check ?? '');
  if (readableBytes > RECIPE_RICH_LIMITS.readableBytes) fail('limit_exceeded', 'readableBytes');
  const files = new Map(content.files.map(file => [file.itemId, file]));
  const referencedFiles = new Set<string>();
  for (const skill of content.skills) {
    if (new Set(skill.fileIds).size !== skill.fileIds.length || !skill.fileIds.includes(skill.entryFileId)) fail('invalid_reference', 'skills.fileIds');
    const entry = files.get(skill.entryFileId);
    if (!entry || entry.use !== 'skillDescription' || entry.name.split('/').at(-1) !== 'SKILL.md') fail('invalid_reference', 'skills.entryFileId');
    const names = new Set<string>();
    for (const fileId of skill.fileIds) {
      const file = files.get(fileId);
      if (!file) fail('invalid_reference', 'skills.fileIds');
      const name = file.name.split('/').map(canonicalCaselessSegment).join('/');
      if ([...names].some(existing => existing === name || existing.startsWith(`${name}/`) || name.startsWith(`${existing}/`))) {
        fail('invalid_reference', 'skills.files.name');
      }
      names.add(name);
      referencedFiles.add(fileId);
    }
  }
  if (referencedFiles.size !== files.size) fail('invalid_reference', 'files');
  if (content.finalLogo) partFor(content.finalLogo.objectId, 'finalLogo', RECIPE_RICH_LIMITS.logoBytes, 'finalLogo');
  if (references.size !== descriptors.size) fail('invalid_reference', 'parts');
  const canonical = canonicalJson(content);
  const canonicalUTF8 = new TextEncoder().encode(canonical);
  const referencedParts = content.parts.filter(part => references.has(part.objectId));
  const logicalBytes = canonicalUTF8.byteLength + referencedParts.reduce((sum, part) => sum + part.bytes, 0);
  if (logicalBytes > RECIPE_RICH_LIMITS.logicalBytes) fail('limit_exceeded', 'logicalBytes');
  return {content, canonical, canonicalUTF8, referencedParts, logicalBytes};
}

export function decodeRichRecipeContent(input: string | Uint8Array): CanonicalRichRecipeContent {
  if (typeof input === 'string' ? recipeRichUtf8Bytes(input) > RECIPE_RICH_LIMITS.logicalBytes : input.byteLength > RECIPE_RICH_LIMITS.logicalBytes) fail('limit_exceeded', 'canonicalUTF8');
  let source: string;
  try {source = typeof input === 'string' ? input : new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(input);}
  catch {return fail('invalid_json', 'utf8');}
  checkWireDepth(source);
  let inputValue: unknown;
  try {inputValue = JSON.parse(source) as unknown;} catch {return fail('invalid_json', 'json');}
  const result = canonicalizeRichRecipeContent(inputValue);
  if (source !== result.canonical) fail('noncanonical', 'canonicalUTF8');
  return result;
}

export function validateWritableRichRecipeContent(input: unknown): CanonicalRichRecipeContent {
  const result = canonicalizeRichRecipeContent(input);
  if (result.content.memories.length) fail('invalid_content', 'memories');
  return result;
}

export async function digestRichRecipeContent(input: CanonicalRichRecipeContent): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(input.canonicalUTF8));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function checkPublishable(content: RecipeRichContent): void {
  for (const field of ['name','summary','version'] as const) {
    if (!content.public[field].value.trim()) fail('invalid_content', `public.${field}`);
  }
  content.setup.forEach((step, index) => {
    if (!step.title.trim() || !step.instructions.trim()) fail('invalid_content', `setup.${index}`);
  });
  content.tasks.forEach((task, index) => {
    const instruction = task.instruction;
    const emptyInstruction = instruction.kind === 'inline' ? !instruction.value.trim()
      : content.parts.find(part => part.objectId === instruction.objectId)?.bytes === 0;
    if (!task.name.trim() || emptyInstruction) fail('invalid_content', `tasks.${index}`);
  });
}

export function validatePublishableRichRecipeContent(input: unknown): CanonicalRichRecipeContent {
  const content = canonicalizeRichRecipeContent(input);
  checkPublishable(content.content);
  return content;
}

export async function verifyRichRecipeRelease(release: unknown, canonicalUTF8: string | Uint8Array): Promise<CanonicalRichRecipeContent> {
  checkJson(release);
  const parsed = recipeRichReleaseSchema.safeParse(release);
  if (!parsed.success) fail('invalid_content', 'release');
  const content = decodeRichRecipeContent(canonicalUTF8);
  checkPublishable(content.content);
  if (parsed.data.logicalBytes !== content.logicalBytes || parsed.data.contentSha256 !== await digestRichRecipeContent(content)) {
    fail('invalid_content', 'release.contentSha256');
  }
  return content;
}
