import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
  canonicalizeRichRecipeContent, decodeRichRecipeContent, digestRichRecipeContent, verifyRichRecipeRelease, validatePublishableRichRecipeContent,
  recipeRichAuthoringPayloadSchema, recipeRichOriginRecordSchema, recipeRichReleaseSchema,
  recipeAuthorizationSchema, recipeManifestSchema, authoringChangeSchema,
  RECIPE_RICH_LIMITS, defaultCardDisplay,
  type RecipeRichContent,
} from '../src/index.js';

const id = (number: number) => `10000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
const identity = (number: number) => ({itemId: id(number), originId: id(number + 10000)});
const fixture = JSON.parse(readFileSync(new URL('./fixtures/recipe-rich-v2.content.json', import.meta.url), 'utf8')) as RecipeRichContent;
const golden = JSON.parse(readFileSync(new URL('./fixtures/recipe-rich-v2.golden.json', import.meta.url), 'utf8')) as {
  canonical: string; canonicalHex: string; sha256: string; canonicalBytes: number; logicalBytes: number;
  logoCanonical: string; logoSha256: string; logoLogicalBytes: number;
};
function content(): RecipeRichContent {
  const value = structuredClone(fixture);
  value.memories = [];
  value.parts = [];
  return value;
}
const inline = (value: string) => ({kind: 'inline' as const, value});
function files(count: number, bytes = 1): RecipeRichContent {
  const value = content();
  value.files = Array.from({length: count}, (_, index) => ({...identity(100 + index), name: index ? `ref-${index}.txt` : 'SKILL.md',
    use: index ? 'reference' : 'skillDescription', text: {kind: 'part', objectId: id(1000 + index)}}));
  value.parts = value.files.map((file, index) => ({objectId: id(1000 + index), kind: 'text',
    sha256: 'a'.repeat(64), bytes, mediaType: 'text/plain;charset=utf-8'}));
  value.skills = [{...identity(200), name: 'Help', entryFileId: value.files[0]!.itemId, fileIds: value.files.map(file => file.itemId)}];
  return value;
}
const release = (sha256: string, logicalBytes: number) => ({format: 'rich-v2' as const, recipeId: id(600), versionId: id(601),
  authorId: id(602), revision: 1, access: 'coded' as const, contentSha256: sha256, logicalBytes});

describe('rich-v2 exact canonical content', () => {
  it('matches independently serialized UTF-8 bytes, digest and distinct referenced bytes', async () => {
    const encoded = canonicalizeRichRecipeContent(fixture);
    expect(encoded.canonical).toBe(golden.canonical);
    expect(Buffer.from(encoded.canonicalUTF8).toString('hex')).toBe(golden.canonicalHex);
    expect(encoded.canonicalUTF8.byteLength).toBe(golden.canonicalBytes);
    expect(encoded.logicalBytes).toBe(golden.logicalBytes);
    expect(encoded.logicalBytes).toBe(encoded.canonicalUTF8.byteLength + 4);
    expect(encoded.referencedParts).toHaveLength(1);
    expect(await digestRichRecipeContent(encoded)).toBe(golden.sha256);
    expect(createHash('sha256').update(encoded.canonicalUTF8).digest('hex')).toBe(golden.sha256);
    expect(decodeRichRecipeContent(encoded.canonicalUTF8).content).toEqual(fixture);
  });
  it('preserves author Unicode, array ordering, newlines and absent recommendations', () => {
    const encoded = canonicalizeRichRecipeContent(fixture);
    expect(encoded.content.public.summary.value).toBe('é 与 é 保留原样');
    expect(encoded.canonical).not.toBe(encoded.canonical.normalize('NFC'));
    const reversed = {...fixture, memories: [...fixture.memories].reverse()};
    expect(canonicalizeRichRecipeContent(reversed).canonical).not.toBe(encoded.canonical);
    const empty = canonicalizeRichRecipeContent(content());
    expect(empty.content.settings).toEqual([]);
    expect(empty.content.setup).toEqual([]);
    expect(empty.content).not.toHaveProperty('finalLogo');
  });
  it('matches independent golden bytes with an optional final Logo descriptor', async () => {
    const value = structuredClone(fixture); value.finalLogo = {...identity(51), objectId: id(52)};
    value.parts.push({objectId: id(52), kind: 'finalLogo', sha256: 'c'.repeat(64), bytes: 128, mediaType: 'image/webp'});
    const encoded = canonicalizeRichRecipeContent(value);
    expect(encoded.canonical).toBe(golden.logoCanonical);
    expect(await digestRichRecipeContent(encoded)).toBe(golden.logoSha256);
    expect(encoded.logicalBytes).toBe(golden.logoLogicalBytes);
    expect(encoded.logicalBytes).toBe(encoded.canonicalUTF8.byteLength + 4 + 128);
  });
  it('rejects alternate bytes, duplicate keys, BOM and malformed UTF-8', () => {
    const canonical = golden.canonical;
    for (const value of [` ${canonical}`, `${canonical}\n`, canonical.replace('"format":', '"format" :'),
      canonical.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'), `\ufeff${canonical}`]) {
      expect(() => decodeRichRecipeContent(value)).toThrow();
    }
    for (const bytes of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xff]]) {
      expect(() => decodeRichRecipeContent(Uint8Array.from(bytes))).toThrow('utf8');
    }
    expect(() => decodeRichRecipeContent(Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from(canonical)]))).toThrow();
  });
  it('rejects lone surrogates, controls, getters, non-JSON values and depth bombs before decoding', () => {
    for (const value of ['\ud800', '\udfff', 'a\u0000b', 'a\u0007b']) {
      const input = content(); input.public.overview.value = value;
      expect(() => canonicalizeRichRecipeContent(input)).toThrow();
    }
    expect(() => canonicalizeRichRecipeContent({...content(), unknown: undefined})).toThrow();
    expect(() => canonicalizeRichRecipeContent({...content(), unknown: NaN})).toThrow();
    const getter = content(); Object.defineProperty(getter, 'role', {get: () => {throw new Error('getter ran');}, enumerable: true});
    expect(() => canonicalizeRichRecipeContent(getter)).toThrow('invalid_json');
    expect(() => decodeRichRecipeContent('['.repeat(17) + '0' + ']'.repeat(17))).toThrow('json.depth');
    let nested: unknown = 0;
    for (let index = 0; index < 18; index++) nested = {child: nested};
    expect(() => canonicalizeRichRecipeContent(nested)).toThrow('limit_exceeded');
    expect(() => canonicalizeRichRecipeContent(Array(RECIPE_RICH_LIMITS.nodes + 1).fill(0))).toThrow('limit_exceeded');
    expect(() => decodeRichRecipeContent(' '.repeat(RECIPE_RICH_LIMITS.logicalBytes + 1))).toThrow('limit_exceeded');
  });
  it('binds a separate release envelope to exact canonical bytes and byte count', async () => {
    await expect(verifyRichRecipeRelease(release(golden.sha256, golden.logicalBytes), golden.canonical)).resolves.toMatchObject({logicalBytes: golden.logicalBytes});
    await expect(verifyRichRecipeRelease(release('0'.repeat(64), golden.logicalBytes), golden.canonical)).rejects.toThrow();
    await expect(verifyRichRecipeRelease(release(golden.sha256, golden.logicalBytes + 1), golden.canonical)).rejects.toThrow();
    expect(recipeRichReleaseSchema.safeParse({...release(golden.sha256, golden.logicalBytes), content: fixture}).success).toBe(false);
    expect(() => canonicalizeRichRecipeContent({...fixture, releaseId: id(60)})).toThrow();
    expect(() => canonicalizeRichRecipeContent({...fixture, contentSha256: golden.sha256})).toThrow();
  });
  it('allows unfinished private drafts and checks required public and setup text only at publication', async () => {
    const draft = content();
    Object.values(draft.public).forEach(field => {field.value = '';});
    draft.setup = [{...identity(90), kind: 'config', title: '', instructions: '', required: true, action: {kind: 'manual'}}];
    const encoded = canonicalizeRichRecipeContent(draft);
    expect(decodeRichRecipeContent(encoded.canonicalUTF8).canonical).toBe(encoded.canonical);
    expect(recipeRichAuthoringPayloadSchema.safeParse({format: 'rich-v2', purpose: 'prepareDraft', sourceIntentId: id(91), content: draft}).success).toBe(true);
    expect(() => validatePublishableRichRecipeContent(draft)).toThrow('public.name');
    await expect(verifyRichRecipeRelease(release(await digestRichRecipeContent(encoded), encoded.logicalBytes), encoded.canonicalUTF8)).rejects.toThrow('public.name');
    for (const field of ['name','summary','version'] as const) {
      const invalid = content(); invalid.public[field].value = ' \t\r\n';
      expect(() => validatePublishableRichRecipeContent(invalid)).toThrow(`public.${field}`);
    }
    expect(() => validatePublishableRichRecipeContent({...content(), setup: draft.setup})).toThrow('setup.0');
    expect(validatePublishableRichRecipeContent(fixture).canonical).toBe(golden.canonical);
  });
});

describe('rich-v2 identity, references and inert native fields', () => {
  it('requires immutable origin handles and globally unique item IDs including public and card items', () => {
    const value = content();
    value.role!.itemId = value.public.name.itemId;
    expect(() => canonicalizeRichRecipeContent(value)).toThrow('itemId');
    const noOrigin = content() as unknown as Record<string, unknown>;
    noOrigin.role = {itemId: id(20), text: inline('role')};
    expect(() => canonicalizeRichRecipeContent(noOrigin)).toThrow();
    const card = defaultCardDisplay();
    const blocks = card.blocks.map(({source: _source, script: _script, language: _language, sample: _sample, ...block}, index) => ({...identity(700 + index), ...block}));
    const withCard = content();
    withCard.settings = [{...identity(710), field: 'presentation.cardDisplay', value: {version: 1, blocks}}];
    expect(() => canonicalizeRichRecipeContent(withCard)).not.toThrow();
    withCard.settings[0]!.itemId = blocks[0]!.itemId;
    expect(() => canonicalizeRichRecipeContent(withCard)).toThrow('itemId');
  });
  it('rejects UUID case aliases before identity and reference comparisons', () => {
    const value = content();
    value.public.name.itemId = 'abcdef00-0000-4000-8000-000000000001';
    value.role!.itemId = 'ABCDEF00-0000-4000-8000-000000000001';
    expect(() => canonicalizeRichRecipeContent(value)).toThrow();
    const reference = structuredClone(fixture);
    reference.parts[0]!.objectId = 'abcdef00-0000-4000-8000-000000000001';
    reference.memories[0]!.text = {kind: 'part', objectId: 'ABCDEF00-0000-4000-8000-000000000001'};
    expect(() => canonicalizeRichRecipeContent(reference)).toThrow();
  });
  it('rejects missing, duplicate, wrong-kind and unreferenced descriptors', () => {
    const missing = structuredClone(fixture); missing.parts = [];
    const duplicate = structuredClone(fixture); duplicate.parts.push(duplicate.parts[0]!);
    const wrongKind = structuredClone(fixture); wrongKind.parts = [{...fixture.parts[0]!, kind: 'finalLogo', mediaType: 'image/webp'}];
    const unreferenced = content(); unreferenced.parts = fixture.parts;
    for (const value of [missing, duplicate, wrongKind, unreferenced]) expect(() => canonicalizeRichRecipeContent(value)).toThrow('invalid_reference');
    const forged = structuredClone(fixture) as unknown as {parts: Record<string, unknown>[]};
    forged.parts[0]!.verified = true;
    expect(() => canonicalizeRichRecipeContent(forged)).toThrow();
  });
  it('keeps native communication settings and independent field identities', () => {
    const value = content();
    value.settings = [
      {...identity(20), field: 'sessionMode', value: 'smart'},
      {...identity(21), field: 'response.noMention', value: false},
      {...identity(22), field: 'run.pendingPolicy', value: 'queue'},
      {...identity(23), field: 'permission.requirement', value: {mode: 'qa'}},
      {...identity(24), field: 'permission.codex.requirement', value: {sandbox: 'read-only', network: false}},
      {...identity(25), field: 'permission.claude.requirement', value: {permissionMode: 'default', sandbox: true, network: 'off'}},
      {...identity(26), field: 'model.recommendation', value: {backend: 'codex-appserver', selection: {kind: 'explicit', model: 'gpt-6.1-sol', effort: 'high'}}},
      {...identity(27), field: 'judge.recommendation', value: {kind: 'provider', provider: 'typesafe'}},
    ];
    value.rules = [{...identity(30), purpose: 'smartRespond', text: inline('提问时回应')}, {...identity(31), purpose: 'smartNewTopic', text: inline('新任务开话题')}];
    const encoded = canonicalizeRichRecipeContent(value);
    expect(encoded.content.settings).toEqual(value.settings);
    expect(encoded.content.rules).toEqual(value.rules);
    value.settings.push({...identity(32), field: 'response.noMention', value: true});
    expect(() => canonicalizeRichRecipeContent(value)).toThrow('settings.response.noMention');
  });
  it('rejects local identities, allowlists, custom maps and script-backed card data', () => {
    for (const setting of [
      {...identity(20), field: 'workspace', value: {primary: '/tmp/project'}},
      {...identity(20), field: 'permission.requirement', value: {mode: 'qa', allowedChats: ['oc_private']}},
      {...identity(20), field: 'permission.claude.requirement', value: {permissionMode: 'default', sandbox: true, network: 'domains', domains: ['example.com']}},
      {...identity(20), field: 'permission.requirement', value: {mode: 'qa', custom: {anything: true}}},
      {...identity(20), field: 'presentation.cardDisplay', value: {version: 1, blocks: [{...defaultCardDisplay().blocks[0], ...identity(21)}]}},
    ]) expect(() => canonicalizeRichRecipeContent({...content(), settings: [setting]})).toThrow();
    for (const field of ['botId','chatId','cwd','tenantKey','sourceAttested','hooks']) {
      expect(() => canonicalizeRichRecipeContent({...content(), [field]: 'private'})).toThrow();
    }
    const polluted = JSON.parse('{"__proto__":["high"]}') as unknown;
    expect(() => canonicalizeRichRecipeContent({...content(), settings: [{...identity(20), field: 'modelAccess.recommendation',
      value: {backend: 'codex-appserver', models: [], efforts: [], modelEfforts: polluted}}]})).toThrow('invalid_json');
  });
  it('preserves bounded native model access and rejects inconsistent model maps', () => {
    const access = {backend: 'codex-appserver', models: ['gpt-6.1-sol'], efforts: ['high'], modelEfforts: {'gpt-6.1-sol': ['high']},
      modelServiceTiers: {'gpt-6.1-sol': ['fast']}, defaultModel: 'gpt-6.1-sol', defaultEffort: 'high'};
    expect(() => canonicalizeRichRecipeContent({...content(), settings: [{...identity(35), field: 'modelAccess.recommendation', value: access}]})).not.toThrow();
    for (const patch of [{models: []}, {models: ['gpt-6.1-sol', 'gpt-6.1-sol']}, {defaultModel: 'missing'}, {defaultEffort: 'missing'},
      {modelEfforts: {missing: ['high']}}, {modelServiceTiers: {'gpt-6.1-sol': ['fast','fast']}},
      {modelEfforts: {constructor: ['high']}}]) {
      expect(() => canonicalizeRichRecipeContent({...content(), settings: [{...identity(35), field: 'modelAccess.recommendation', value: {...access, ...patch}}]})).toThrow();
    }
    const privateKey = 'private-model-key';
    let failure: unknown;
    try {
      canonicalizeRichRecipeContent({...content(), settings: [{...identity(35), field: 'modelAccess.recommendation',
        value: {...access, modelEfforts: {[privateKey]: [false]}}}]});
    } catch (error) {failure = error;}
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(privateKey);
  });
  it('bounds and types lineage declarations without treating them as authorship proof', () => {
    const record = {originId: id(900), accountId: id(901), kind: 'role', sourceIntentId: id(902), sourceItemId: id(903), baselineSha256: 'a'.repeat(64),
      parents: Array.from({length: 64}, (_, index) => ({versionId: id(1000 + index), itemId: id(2000 + index), baselineSha256: 'b'.repeat(64)}))};
    expect(recipeRichOriginRecordSchema.safeParse(record).success).toBe(true);
    expect(recipeRichOriginRecordSchema.safeParse({...record, parents: [...record.parents, record.parents[0]]}).success).toBe(false);
    expect(recipeRichOriginRecordSchema.safeParse({...record, parents: [record.parents[0], record.parents[0]]}).success).toBe(false);
    expect(recipeRichOriginRecordSchema.safeParse({...record, authorshipProven: true}).success).toBe(false);
  });
  it('permits only manually acknowledged or existing native setup actions', () => {
    const value = content();
    const step = {...identity(40), kind: 'config' as const, title: '选择模型', instructions: '打开模型设置。', required: true,
      action: {kind: 'nativeSettings' as const, entry: 'model' as const}};
    value.setup = [step, {...identity(41), kind: 'tool', title: '人工确认', instructions: '检查工具可用。', required: false, action: {kind: 'manual'}}];
    expect(() => canonicalizeRichRecipeContent(value)).not.toThrow();
    for (const action of [{kind: 'exec', command: 'touch /tmp/ran'}, {kind: 'nativeSettings', entry: 'shell'}, {kind: 'manual', completed: true}]) {
      expect(() => canonicalizeRichRecipeContent({...value, setup: [{...step, action}]})).toThrow();
    }
  });
  it('validates skill membership and cross-platform inert filenames', () => {
    const value = files(2);
    expect(() => canonicalizeRichRecipeContent(value)).not.toThrow();
    for (const filename of ['../outside.txt','/tmp/a.txt','C:/a.txt','folder\\a.txt','con.txt','a.txt:stream','.claude/a.md','file.sh','plugin.json','a.js','a.txt.']) {
      expect(() => canonicalizeRichRecipeContent({...value, files: [value.files[0], {...value.files[1], name: filename}]})).toThrow();
    }
    expect(() => canonicalizeRichRecipeContent({...value, skills: [{...value.skills[0], fileIds: [id(9999)]}]})).toThrow();
    expect(() => canonicalizeRichRecipeContent({...value, skills: []})).toThrow();
    expect(() => canonicalizeRichRecipeContent({...value, files: [value.files[0], {...value.files[1], name: 'skill.MD'}]})).toThrow();
    const unicode = files(3); unicode.files[1]!.name = 'é.txt'; unicode.files[2]!.name = 'é.txt';
    expect(() => canonicalizeRichRecipeContent(unicode)).toThrow('skills.files.name');
  });
});

describe('rich-v2 exact capacity boundaries', () => {
  it('accepts exactly 1 MiB and rejects the next byte using logical verified bytes', () => {
    const value = files(8, 131072);
    value.parts[7]!.bytes = 100000;
    let encoded = canonicalizeRichRecipeContent(value);
    value.parts[7]!.bytes += RECIPE_RICH_LIMITS.logicalBytes - encoded.logicalBytes;
    encoded = canonicalizeRichRecipeContent(value);
    expect(encoded.logicalBytes).toBe(RECIPE_RICH_LIMITS.logicalBytes);
    expect(decodeRichRecipeContent(encoded.canonicalUTF8).logicalBytes).toBe(RECIPE_RICH_LIMITS.logicalBytes);
    value.parts[7]!.bytes++;
    expect(() => canonicalizeRichRecipeContent(value)).toThrow('logicalBytes');
  });
  it('uses UTF-8 bytes for files, memories, setup and optional final Logo', () => {
    const value = files(1);
    value.files[0]!.text = inline('a'.repeat(131072)); value.parts = [];
    expect(() => canonicalizeRichRecipeContent(value)).not.toThrow();
    value.files[0]!.text = inline('a'.repeat(131073));
    expect(() => canonicalizeRichRecipeContent(value)).toThrow();
    const memory = content(); memory.memories = [{...identity(50), text: inline('😀'.repeat(1024))}];
    expect(() => canonicalizeRichRecipeContent(memory)).not.toThrow();
    memory.memories[0]!.text = inline('😀'.repeat(1024) + 'a');
    expect(() => canonicalizeRichRecipeContent(memory)).toThrow();
    const partMemory = structuredClone(fixture); partMemory.parts[0]!.bytes = 4096;
    expect(() => canonicalizeRichRecipeContent(partMemory)).not.toThrow();
    partMemory.parts[0]!.bytes++;
    expect(() => canonicalizeRichRecipeContent(partMemory)).toThrow();
    const logo = content(); logo.finalLogo = {...identity(51), objectId: id(52)};
    logo.parts = [{objectId: id(52), kind: 'finalLogo', sha256: 'c'.repeat(64), bytes: 131072, mediaType: 'image/webp'}];
    expect(canonicalizeRichRecipeContent(logo).logicalBytes).toBe(canonicalizeRichRecipeContent(logo).canonicalUTF8.byteLength + 131072);
    logo.parts[0]!.bytes++;
    expect(() => canonicalizeRichRecipeContent(logo)).toThrow();
    const setup = {...identity(53), kind: 'context', title: 'A', instructions: 'é'.repeat(1024), check: '😀'.repeat(128), required: false, action: {kind: 'manual'}};
    expect(() => canonicalizeRichRecipeContent({...content(), setup: [setup]})).not.toThrow();
    expect(() => canonicalizeRichRecipeContent({...content(), setup: [{...setup, instructions: setup.instructions + 'a'}]})).toThrow();
    expect(() => canonicalizeRichRecipeContent({...content(), setup: [{...setup, check: setup.check + 'a'}]})).toThrow();
  });
  it('limits selected rule and task bodies in inline and referenced forms', () => {
    const value = content(); value.rules = [{...identity(60), purpose: 'work', text: inline('a'.repeat(16384))}];
    value.tasks = [{...identity(61), name: 'Task', instruction: inline('a'.repeat(4000)), spec: {kind: 'daily', time: '09:00'},
      timeZone: {kind: 'recommended', iana: 'Asia/Shanghai'}, placement: 'follow'}];
    expect(() => canonicalizeRichRecipeContent(value)).not.toThrow();
    expect(() => canonicalizeRichRecipeContent({...value, rules: [{...value.rules[0], text: inline('a'.repeat(16385))}]})).toThrow();
    expect(() => canonicalizeRichRecipeContent({...value, tasks: [{...value.tasks[0], instruction: inline('a'.repeat(4001))}]})).toThrow();
    expect(() => canonicalizeRichRecipeContent({...value, tasks: [{...value.tasks[0], name: '😀'.repeat(21)}]})).toThrow();
    value.parts = [{objectId: id(1000), kind: 'text', sha256: 'a'.repeat(64), bytes: 4000, mediaType: 'text/plain;charset=utf-8'}];
    value.tasks[0]!.instruction = {kind: 'part', objectId: id(1000)};
    expect(() => canonicalizeRichRecipeContent(value)).not.toThrow();
    value.parts[0]!.bytes++;
    expect(() => canonicalizeRichRecipeContent(value)).toThrow();
  });
  it('uses code points for public names and the combined decoded readable budget', () => {
    const value = content(); value.public.name.value = '😀'.repeat(60);
    expect(() => canonicalizeRichRecipeContent(value)).not.toThrow();
    value.public.name.value += 'a';
    expect(() => canonicalizeRichRecipeContent(value)).toThrow();
    const readable = content(); delete readable.role;
    const otherBytes = Object.entries(readable.public).filter(([key]) => key !== 'overview').reduce((sum, [, entry]) => sum + Buffer.byteLength(entry.value), 0);
    readable.public.overview.value = 'a'.repeat(32768 - otherBytes);
    expect(() => canonicalizeRichRecipeContent(readable)).not.toThrow();
    readable.public.overview.value += 'a';
    expect(() => canonicalizeRichRecipeContent(readable)).toThrow('readableBytes');
  });
  it.each(['rules','tasks','memories','skills','files','setup'] as const)('enforces %s count at the cap and cap plus one', collection => {
    let value = content();
    const limit = RECIPE_RICH_LIMITS[collection];
    if (collection === 'files') value = files(limit);
    else if (collection === 'skills') {
      value = files(limit);
      value.skills = value.files.map((file, index) => ({...identity(300 + index), name: `Skill ${index}`, entryFileId: file.itemId, fileIds: [file.itemId]}));
      value.files.forEach(file => {file.name = 'SKILL.md'; file.use = 'skillDescription';});
    } else if (collection === 'rules') value.rules = Array.from({length: limit}, (_, index) => ({...identity(300 + index), purpose: 'work', text: inline('a')}));
    else if (collection === 'memories') value.memories = Array.from({length: limit}, (_, index) => ({...identity(300 + index), text: inline('a')}));
    else if (collection === 'setup') value.setup = Array.from({length: limit}, (_, index) => ({...identity(300 + index), kind: 'context', title: 'A', instructions: 'A', required: false, action: {kind: 'manual'}}));
    else value.tasks = Array.from({length: limit}, (_, index) => ({...identity(300 + index), name: 'Task', instruction: inline('A'), spec: {kind: 'every', minutes: 1}, timeZone: {kind: 'targetChoice'}, placement: 'follow'}));
    expect(() => canonicalizeRichRecipeContent(value)).not.toThrow();
    const increased: unknown[] = [...value[collection], {...value[collection][0], ...identity(900)}];
    expect(() => canonicalizeRichRecipeContent({...value, [collection]: increased})).toThrow();
  });
});

describe('explicit v2 dispatch and unchanged legacy contracts', () => {
  it('dispatches rich prepare and edit by an explicit purpose', () => {
    const prepare = {format: 'rich-v2', purpose: 'prepareDraft', sourceIntentId: id(70), content: content()};
    const edit = {format: 'rich-v2', purpose: 'editDraft', draftId: id(71), baseRevision: 2, content: content()};
    expect(recipeRichAuthoringPayloadSchema.safeParse(prepare).success).toBe(true);
    expect(recipeRichAuthoringPayloadSchema.safeParse(edit).success).toBe(true);
    for (const payload of [{...prepare, purpose: undefined}, {...prepare, schemaVersion: 2}, {...prepare, draftId: id(71)}, {...edit, purpose: 'prepareDraft'}]) {
      expect(recipeRichAuthoringPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });
  it('keeps v1 manifests, install purpose/generation and edit changes unchanged', () => {
    const manifestBytes = `{"role": "你好", "access": "coded", "schema": 1, "authorId": "${id(80)}", "recipeId": "${id(81)}", "revision": 1, "versionId": "${id(82)}"}`;
    const manifest = JSON.parse(manifestBytes) as unknown;
    expect(recipeManifestSchema.parse(manifest)).toEqual(manifest);
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe('31e5bcac8a7c12e6d25b486b37626d05493f1f8a195d09dcf164825e692bbe1e');
    const authorization = {operationId: id(83), accountId: id(84), purpose: 'installBoundRole', generation: 1, deadline: 1000,
      versionId: id(82), manifestSha256: 'f'.repeat(64), targetPublicKey: 'A'.repeat(43), nonceCommitment: 'A'.repeat(43), serverPublicKey: 'A'.repeat(43), ticket: 'A'.repeat(43), status: 'authorized'};
    expect(recipeAuthorizationSchema.parse(authorization)).toEqual(authorization);
    expect(recipeAuthorizationSchema.safeParse({...authorization, generation: 2}).success).toBe(false);
    expect(recipeManifestSchema.safeParse(fixture).success).toBe(false);
    expect(() => canonicalizeRichRecipeContent(manifest)).toThrow();
    expect(authoringChangeSchema.parse({op: 'setDraftRole', value: '旧版角色'})).toEqual({op: 'setDraftRole', value: '旧版角色'});
  });
});
