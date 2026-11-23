import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect, it} from 'vitest';
import {canonicalizeRichRecipeContent} from '../src/recipe-rich-codec.js';
import {RECIPE_RICH_LIMITS, type RecipeRichContent} from '../src/recipe-rich.js';
import {
  RESOURCE_INDEX_PAGE_BYTES, RESOURCE_SNAPSHOT_WIRE_BYTES, RESOURCE_TEXT_PAGE_BYTES, openResourceSnapshot, readResourcePage,
  roleResourceDigest, type ResourceDocuments, type ResourceIndexEntry,
} from '../src/recipe-resource-context.js';
import {createInitiator, createResponder, decodeFrame, encodeFrame, FRAME, generateStaticKey} from '../src/secure-channel.js';

const id = (n: number) => '70000000-0000-4000-8000-' + String(n).padStart(12, '0');
const identity = (n: number) => ({itemId: id(n), originId: id(n)});
const sha = (bytes: Buffer | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const target = {recipeId: id(1), versionId: id(2)};
const publicInfo = {name: '配方', summary: '说明', overview: '正文', version: 'v1', access: 'coded' as const};
function fresh(): RecipeRichContent {
  const content = JSON.parse(readFileSync(new URL('./fixtures/recipe-rich-v2.content.json', import.meta.url), 'utf8')) as RecipeRichContent;
  content.memories = []; content.parts = [];
  return content;
}
function packed(content: RecipeRichContent, members: Record<string, string>) {
  const bytes = canonicalizeRichRecipeContent(content);
  const release = {format: 'rich-v2' as const, ...target, authorId: id(3), revision: 3, access: 'direct' as const,
    logicalBytes: bytes.logicalBytes, contentSha256: sha(bytes.canonicalUTF8)};
  const fields = content.public;
  return {format: release.format, target, revision: release.revision, release, contentSha256: release.contentSha256,
    public: {name: fields.name.value, summary: fields.summary.value, overview: fields.overview.value, version: fields.version.value, access: release.access},
    canonical: Buffer.from(bytes.canonicalUTF8).toString('base64url'), members};
}
async function role(body: string) {
  const config = {role: body, setup: {steps: [{title: '手工操作', kind: 'config' as const, instructions: '参考说明', required: false}]}};
  const data = {target, revision: 1, public: publicInfo, config};
  return {...data, format: 'role-v1' as const, contentSha256: await roleResourceDigest(data)};
}
function index(docs: ResourceDocuments) {
  let cursor: string | undefined;
  const entries: ResourceIndexEntry[] = [];
  do {
    const page = readResourcePage(docs, {kind: 'index', cursor});
    if (page.kind !== 'index') throw new Error('index expected');
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(RESOURCE_INDEX_PAGE_BYTES);
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}
function read(docs: ResourceDocuments, entry: ResourceIndexEntry) {
  let cursor: string | undefined, value = '';
  do {
    const page = readResourcePage(docs, {kind: 'text', documentId: entry.documentId, cursor});
    if (page.kind !== 'text') throw new Error('text expected');
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(RESOURCE_TEXT_PAGE_BYTES);
    value += page.text;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(Buffer.byteLength(value)).toBe(entry.bytes);
  return value;
}
it('round trips role/setup and UTF-8 at a page boundary, refusing foreign documents, cursors and modified config', async () => {
  const body = 'a'.repeat(4095) + '😀末尾', snapshot = await role(body);
  const docs = await openResourceSnapshot(snapshot);
  const entries = index(docs), entry = entries.find(e => e.kind === 'role')!;
  expect(read(docs, entry)).toBe(body);
  expect(JSON.parse(read(docs, entries.find(e => e.kind === 'setup')!))).toEqual(snapshot.config.setup.steps[0]);
  const first = docs.readPage({kind: 'text', documentId: entry.documentId});
  expect(first.nextCursor).toBeTruthy();
  for (const cursor of [first.nextCursor!.replace(/\.\d+$/, '.4096'), first.nextCursor + '0', '/etc/passwd'])
    expect(() => docs.readPage({kind: 'text', documentId: entry.documentId, cursor})).toThrow();
  expect(() => docs.readPage({kind: 'text', documentId: entries[0]!.documentId, cursor: first.nextCursor!})).toThrow();
  await expect(openResourceSnapshot({...snapshot, config: {...snapshot.config, role: '改动'}})).rejects.toThrow();
  const other = await openResourceSnapshot(await role(body + 'x'));
  expect(() => other.readPage({kind: 'text', documentId: entry.documentId})).toThrow();
  expect(() => docs.readPage({kind: 'index', path: '/private'} as never)).toThrow();
});

function largePackage() {
  const content = fresh(), members: Record<string, string> = {};
  const fileBodies = new Map<string, string>();
  function part(n: number, bytes: Buffer, logo = false) {
    const objectId = id(1000 + n);
    const fields = {objectId, bytes: bytes.length, sha256: sha(bytes)};
    content.parts.push(logo ? {...fields, kind: 'finalLogo', mediaType: 'image/webp'} : {...fields, kind: 'text', mediaType: 'text/plain;charset=utf-8'});
    members[objectId] = bytes.toString('base64url');
    return {kind: 'part' as const, objectId};
  }
  content.role = {...identity(10), text: part(10, Buffer.from('角色'))};
  for (let i = 0; i < 32; i++) {
    content.rules.push({...identity(20+i), purpose: i % 2 ? 'smartRespond' : 'work', text: part(20+i, Buffer.from('规则' + i))});
    content.tasks.push({...identity(60+i), name: '任务' + i, instruction: part(60+i, Buffer.from('操作说明' + i)),
      spec: {kind: 'daily', time: '09:00'}, timeZone: {kind: 'targetChoice'}, placement: 'follow'});
  }
  for (let i = 0; i < 64; i++) {
    const name = i === 0 ? 'SKILL.md' : '参考/' + '文'.repeat(44) + i + '.md';
    const value = '😀'.repeat(3500) + '末' + i;
    content.files.push({...identity(110+i), name, use: i === 0 ? 'skillDescription' : 'reference', text: part(110+i, Buffer.from(value))});
    fileBodies.set(name, value);
  }
  content.skills.push({...identity(200), name: '技能', entryFileId: id(110), fileIds: content.files.map(file => file.itemId)});
  content.setup.push({...identity(201), kind: 'context', title: '手工', instructions: '仅供参考', action: {kind: 'manual'}, required: false});
  content.settings.push({...identity(202), field: 'response.noMention', value: false});
  content.finalLogo = {...identity(203), objectId: part(203, Buffer.from('logo'), true).objectId};
  const manifest = canonicalizeRichRecipeContent(content);
  const first = content.parts.find(p => p.objectId === id(1110))!;
  const missing = RECIPE_RICH_LIMITS.logicalBytes - manifest.logicalBytes;
  // The byte-count field expands with the new length. Preserve the exact 1 MiB logical boundary.
  const extra = missing - (String(first.bytes + missing).length - String(first.bytes).length);
  const value = 'a'.repeat(extra) + fileBodies.get('SKILL.md')!;
  const bytes = Buffer.from(value);
  Object.assign(first, {bytes: bytes.length, sha256: sha(bytes)});
  members[first.objectId] = bytes.toString('base64url');
  fileBodies.set('SKILL.md', value);
  return {snapshot: packed(content, members), fileBodies};
}

it('delivers 1 MiB with all 130 memory-free member references through the encrypted frame and traverses every document', async () => {
  const {snapshot, fileBodies} = largePackage();
  expect(snapshot.release.logicalBytes).toBe(1048576);
  expect(Object.keys(snapshot.members)).toHaveLength(130);
  const body = Buffer.from(JSON.stringify({type: 'request', id: id(1), params: {snapshot}}));
  const key = generateStaticKey().key;
  const init = createInitiator(generateStaticKey().key, key.publicKey), remote = createResponder(key);
  remote.readMessage1(init.message1());
  const reply = remote.message2();
  const frame = init.finish(reply.bytes).channel.encrypt(encodeFrame(FRAME.json, body));
  expect(frame.length).toBe(body.length + 25);
  expect(frame.length).toBeLessThan(RESOURCE_SNAPSHOT_WIRE_BYTES);
  expect(frame.length).toBeLessThan(4_000_000);
  const received = JSON.parse(decodeFrame(reply.channel.decrypt(frame)).body.toString('utf8')).params.snapshot;
  const docs = await openResourceSnapshot(received);
  const first = docs.readPage({kind:'index'});
  expect(first.nextCursor).toBeTruthy();
  const entries = index(docs), text = new Map(entries.map(entry => [entry.documentId, read(docs, entry)]));
  expect(entries.filter(e => e.kind === 'rule' && e.label === 'smartRespond')).toHaveLength(16);
  const skill = JSON.parse(text.get(entries.find(e => e.kind === 'skill')!.documentId)!);
  expect(skill.files).toHaveLength(64);
  for (const file of skill.files) expect(text.get(file.documentId)).toBe(fileBodies.get(file.name));
  expect(text.get(skill.entryDocumentId)).toBe(fileBodies.get('SKILL.md'));
  const logo = text.get(entries.find(e => e.kind === 'logo')!.documentId)!;
  expect(JSON.parse(logo)).toEqual({mediaType:'image/webp', bytes:4, sha256:sha(Buffer.from('logo'))});
  expect(entries.filter(e => e.kind === 'task')).toHaveLength(32);
  expect(entries.map(e => e.kind)).toEqual(expect.arrayContaining(['setting','setup','public','role']));
});

it('checks exact release, member set, digest, equality with public fields, UTF-8 and portable filenames', async () => {
  const content = fresh(), objectId = id(100), data = Buffer.from('文本');
  content.parts.push({kind: 'text', objectId, sha256: sha(data), bytes: data.length, mediaType: 'text/plain;charset=utf-8'});
  content.role!.text = {kind: 'part', objectId};
  const snapshot = packed(content, {[objectId]: data.toString('base64url')});
  const changed: unknown[] = [
    {...snapshot, canonical: snapshot.canonical + 'A'}, {...snapshot, members: {}}, {...snapshot, members: {...snapshot.members, [id(456)]: ''}},
    {...snapshot, public: {...snapshot.public, name: '错配'}}, {...snapshot, release: {...snapshot.release, versionId: id(500)}},
    {...snapshot, members: {[objectId]: Buffer.alloc(data.length).toString('base64url')}}, {...snapshot, url:'https://outside.test'},
  ];
  for (const value of changed) await expect(openResourceSnapshot(value)).rejects.toThrow();
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0]), Buffer.from([127])]) {
    Object.assign(content.parts[0]!, {sha256: sha(bytes), bytes: bytes.length});
    await expect(openResourceSnapshot(packed(content, {[objectId]: bytes.toString('base64url')}))).rejects.toThrow();
  }
  const badPath = structuredClone(content);
  badPath.files.push({...identity(200), name: '../SKILL.md', use: 'skillDescription', text: {kind: 'inline', value: ''}});
  const forged = Buffer.from(JSON.stringify(badPath)), badDigest = sha(forged);
  await expect(openResourceSnapshot({...snapshot, canonical: forged.toString('base64url'), contentSha256: badDigest,
    release: {...snapshot.release, contentSha256: badDigest}})).rejects.toThrow();
  const memories = fresh();
  memories.memories = [{...identity(200), text:{kind:'inline', value:'记忆'}}];
  await expect(openResourceSnapshot(packed(memories, {}))).rejects.toThrow('含有记忆');
});
