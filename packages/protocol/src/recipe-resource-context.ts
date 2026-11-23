import {z} from 'zod';
import {
  acquisitionFailureSchema, acquisitionKeySchema, communityResponseSchemas, recipeConfigSchema, recipePublicSchema, recipeResourceLatestSchema,
} from './desktop-community.js';
import {
  RECIPE_RICH_LIMITS, recipeRichReleaseSchema, recipeRichTextSchema, type RecipeRichText,
} from './recipe-rich.js';
import {verifyRichRecipeRelease} from './recipe-rich-codec.js';
import {recipeBrowseDetailSchema} from './recipe-browse.js';
import {groupIdSchema} from './domain.js';

const id = z.string().uuid();
const revision = z.number().int().positive().max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const exactResourceVersionSchema = z.object({recipeId: id, versionId: id}).strict();
export type ExactResourceVersion = z.infer<typeof exactResourceVersionSchema>;
const target = exactResourceVersionSchema;
export const resourceReadTaskSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('resourcePreview'), target}).strict(),
  z.object({kind: z.literal('resourceRead'), target, groupId: groupIdSchema, groupIdentity: digest}).strict(),
  z.object({kind: z.literal('resourceLatest'), target, revision}).strict(),
]);
export type ResourceReadTask = z.infer<typeof resourceReadTaskSchema>;
export const resourceAcquireTaskSchema = z.object({kind: z.literal('resourceAcquire'), target, requestId: acquisitionKeySchema}).strict();
export type ResourceAcquireTask = z.infer<typeof resourceAcquireTaskSchema>;
export const resourceLatestSchema = recipeResourceLatestSchema;
export type ResourceLatest = z.infer<typeof resourceLatestSchema>;
export const acquisitionOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ok: z.literal(true), value: communityResponseSchemas.acquire}).strict(),
  z.object({ok: z.literal(false), error: acquisitionFailureSchema}).strict(),
]);

const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
export const RESOURCE_SNAPSHOT_WIRE_BYTES = 2 * 1024 * 1024;
export const RESOURCE_INDEX_PAGE_BYTES = 8192;
export const RESOURCE_TEXT_PAGE_BYTES = 4096;
const base64 = (limit: number) => z.string().max(Math.ceil(limit * 4 / 3)).regex(/^[A-Za-z0-9_-]*$/);
const common = {target, revision, public: recipePublicSchema};
const roleContentSchema = z.object({...common, config: recipeConfigSchema}).strict();
export const verifiedResourceSnapshotSchema = z.discriminatedUnion('format', [
  roleContentSchema.extend({format: z.literal('role-v1'), contentSha256: digest}).strict(),
  z.object({...common, format: z.literal('rich-v2'), contentSha256: digest, release: recipeRichReleaseSchema,
    canonical: base64(RECIPE_RICH_LIMITS.logicalBytes), members: z.record(id, base64(RECIPE_RICH_LIMITS.fileBytes))}).strict(),
]).superRefine((snapshot, ctx) => {
  if (snapshot.format === 'rich-v2') {
    const members = Object.values(snapshot.members);
    if (members.length > RECIPE_RICH_LIMITS.parts ||
      members.reduce((sum, v) => sum + Math.floor(v.length * 3 / 4), Math.floor(snapshot.canonical.length * 3 / 4)) > RECIPE_RICH_LIMITS.logicalBytes) {
      ctx.addIssue({code: 'custom', message: 'Resource size exceeded'});
    }
  }
});
export type VerifiedResourceSnapshot = z.infer<typeof verifiedResourceSnapshotSchema>;
async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
// Schema parsing normalizes field order before hashing this legacy JSON representation.
export function roleResourceDigest(content: z.infer<typeof roleContentSchema>): Promise<string> {
  return sha256(utf8.encode(JSON.stringify(roleContentSchema.parse(content))));
}
function invalid(): never {throw new Error('配方资源数据无效，请重新读取。');}
function unpack(encoded: string) {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  if (btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_') !== encoded) invalid();
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

const cursor = z.string().min(1).max(160).optional();
export const resourcePageQuerySchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('index'), cursor}).strict(),
  z.object({kind: z.literal('text'), documentId: z.string().regex(/^d[0-9a-f]{64}-[0-9]{1,3}$/), cursor}).strict(),
]);
export type ResourcePageQuery = z.infer<typeof resourcePageQuerySchema>;
type DocumentKind = 'public' | 'role' | 'setting' | 'rule' | 'skill' | 'file' | 'task' | 'setup' | 'logo';
export interface ResourceIndexEntry {documentId: string; kind: DocumentKind; label: string; bytes: number}
export type ResourcePage =
  | {kind: 'index'; entries: ResourceIndexEntry[]; nextCursor: string | null}
  | {kind: 'text'; documentId: string; text: string; nextCursor: string | null};
export interface ResourceDocuments {readPage(query: ResourcePageQuery): ResourcePage}
export function readResourcePage(docs: ResourceDocuments, query: ResourcePageQuery): ResourcePage {return docs.readPage(query);}

type Document = {kind: DocumentKind; label: string; body: string};
function pages(scope: string, documents: Document[]): ResourceDocuments {
  const table = new Map<string, Uint8Array>();
  const shared = new Map<string, Uint8Array>();
  const entries = documents.map(({kind, label, body}, index) => {
    const documentId = 'd' + scope + '-' + index;
    const bytes = shared.get(body) ?? utf8.encode(body);
    shared.set(body, bytes);
    table.set(documentId, bytes);
    return {documentId, kind, label, bytes: bytes.byteLength};
  });
  function offset(token: string | undefined, prefix: string, length: number) {
    if (!token) return 0;
    const value = Number(token.slice(prefix.length + 1));
    if (!Number.isSafeInteger(value) || value <= 0 || value >= length || token !== prefix + '.' + value) invalid();
    return value;
  }
  // Build complete index pages once. The budget includes the cursor, labels and JSON escaping.
  const indexPages = new Map<string | undefined, Extract<ResourcePage, {kind: 'index'}>>();
  let start = 0;
  while (start < entries.length) {
    const page: Extract<ResourcePage, {kind: 'index'}> = {kind: 'index', entries: [], nextCursor: null};
    for (let n = start; n < entries.length; n++) {
      const nextCursor = n + 1 < entries.length ? scope + '.' + (n + 1) : null;
      const candidate = {...page, entries: [...page.entries, entries[n]!], nextCursor};
      if (utf8.encode(JSON.stringify(candidate)).length > RESOURCE_INDEX_PAGE_BYTES) break;
      page.entries = candidate.entries;
      page.nextCursor = nextCursor;
    }
    if (!page.entries.length) invalid();
    indexPages.set(start ? scope + '.' + start : undefined, page);
    start += page.entries.length;
  }
  return {readPage(raw) {
    const query = resourcePageQuerySchema.parse(raw);
    if (query.kind === 'index') return structuredClone(indexPages.get(query.cursor) ?? invalid());
    const bytes = table.get(query.documentId) ?? invalid();
    const from = offset(query.cursor, query.documentId, bytes.length);
    if (from && (bytes[from]! & 0xc0) === 0x80) invalid();
    let end = Math.min(from + RESOURCE_TEXT_PAGE_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return {kind: 'text', documentId: query.documentId, text: decoder.decode(bytes.subarray(from, end)),
      nextCursor: end < bytes.length ? query.documentId + '.' + end : null};
  }};
}

export async function openResourcePreview(input: unknown): Promise<ResourceDocuments> {
  const preview = recipeBrowseDetailSchema.parse(input);
  if (!preview.owned && !preview.acquired) throw new Error('请先获取这个版本。');
  const scope = await sha256(utf8.encode(JSON.stringify(preview)));
  const documents: Document[] = [
    {kind: 'public', label: preview.public.name, body: JSON.stringify({...preview.public, format: preview.format,
      fullContentRead: false,
      ...(preview.preview ? {summaryCounts: {settings: preview.preview.settings.length, skills: preview.preview.skills.length,
        rules: preview.preview.ruleCount, tasks: preview.preview.taskCount, omittedSettings: preview.preview.omittedSettingCount ?? 0}} : {}),
      detail: '只含展示摘要。缺省字段表示未展示，不能据此判断完整配方没有角色、规则、文件、任务或 Setup。新群方案应包含按所选版本完整配方配置；本人确认后创建绑定，再为该群准备完整内容。'})},
  ];
  for (const setting of preview.preview?.settings ?? []) documents.push({kind: 'setting', label: setting.field, body: JSON.stringify(setting.value)});
  for (const skill of preview.preview?.skills ?? []) documents.push({kind: 'skill', label: skill.name, body: skill.description || '未填写技能说明。'});
  return pages(scope, documents);
}

export async function openResourceSnapshot(input: unknown): Promise<ResourceDocuments> {
  const snapshot = verifiedResourceSnapshotSchema.parse(input);
  const {target, revision, public: info, contentSha256} = snapshot;
  const scope = await sha256(utf8.encode([target.recipeId, target.versionId, contentSha256].join('/')));
  const documents: Document[] = [
    {kind: 'public', label: info.name, body: JSON.stringify({name: info.name, summary: info.summary, version: info.version, access: info.access})},
    {kind: 'public', label: 'overview', body: info.overview},
  ];
  function add(kind: DocumentKind, label: string, body: string) {documents.push({kind, label, body});}
  if (snapshot.format === 'role-v1') {
    const {config} = snapshot;
    if (await roleResourceDigest({target, revision, public: info, config}) !== contentSha256) invalid();
    add('role', 'role', config.role);
    for (const step of config.setup?.steps ?? []) add('setup', step.title, JSON.stringify(step));
  } else {
    const {release} = snapshot;
    if (release.recipeId !== target.recipeId || release.versionId !== target.versionId || release.revision !== revision ||
        release.access !== info.access || release.contentSha256 !== contentSha256) invalid();
    const {content} = await verifyRichRecipeRelease(release, unpack(snapshot.canonical));
    if (content.memories.length) throw new Error('该历史版本含有记忆，无法作为配方资源交付。');
    if (Object.keys(snapshot.members).length !== content.parts.length ||
        (['name','summary','version','overview'] as const).some(k => info[k] !== content.public[k].value)) invalid();
    const texts = new Map<string, string>();
    for (const part of content.parts) {
      const encoded = snapshot.members[part.objectId];
      if (typeof encoded !== 'string' || encoded.length !== Math.ceil(part.bytes * 4 / 3)) invalid();
      const bytes = unpack(encoded);
      if (bytes.length !== part.bytes || await sha256(bytes) !== part.sha256) invalid();
      if (part.kind === 'text') {
        const value = decoder.decode(bytes);
        recipeRichTextSchema.parse({kind: 'inline', value});
        texts.set(part.objectId, value);
      } else {
        add('logo', 'image/webp', JSON.stringify({mediaType: part.mediaType, bytes: part.bytes, sha256: part.sha256}));
      }
    }
    function resolve(text: RecipeRichText) {return text.kind === 'inline' ? text.value : texts.get(text.objectId) ?? invalid();}
    if (content.role) add('role', 'role', resolve(content.role.text));
    for (const rule of content.rules) add('rule', rule.purpose, resolve(rule.text));
    for (const setting of content.settings) add('setting', setting.field, JSON.stringify(setting.value));
    const fileDocuments = new Map<string, string>();
    for (const file of content.files) {
      fileDocuments.set(file.itemId, 'd' + scope + '-' + documents.length);
      add('file', file.name, resolve(file.text));
    }
    for (const skill of content.skills) {
      const files = skill.fileIds.map(id => {
        const file = content.files.find(f => f.itemId === id)!;
        return {documentId: fileDocuments.get(id), name: file.name, use: file.use};
      });
      add('skill', skill.name, JSON.stringify({name: skill.name, entryDocumentId: fileDocuments.get(skill.entryFileId), files}));
    }
    for (const task of content.tasks) {
      add('task', task.name, JSON.stringify({name: task.name, instruction: resolve(task.instruction), spec: task.spec,
        timeZone: task.timeZone, placement: task.placement}));
    }
    for (const {itemId: _item, originId: _origin, ...step} of content.setup) add('setup', step.title, JSON.stringify(step));
  }
  return pages(scope, documents);
}
