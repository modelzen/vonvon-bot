// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash, webcrypto} from 'node:crypto';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {canonicalizeRichRecipeContent, communityRequestSchema, recipeRichDraftSchema, type CommunityRequest, type RecipeRichDraft} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {ClientProvider} from '../src/client-context';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {RichRecipeEditor, type RichDraftContinuationProps} from '../src/community/RichRecipeEditor';
import {RecipeDetails} from '../src/community/RecipeContent';

const accountId = '44444444-4444-4444-8444-444444444444';
const draftId = '55555555-5555-4555-8555-555555555555';
let root: Root;
let draft: RecipeRichDraft;
let requests: CommunityRequest[];
let send: (request: CommunityRequest) => Promise<unknown>;
let facade: ReturnType<typeof createDesktopFacades>;
let emit: (value: unknown) => void;
let back: ReturnType<typeof vi.fn>;
function richDraft(revision = 1, patch: Partial<RecipeRichDraft['public']> = {}): RecipeRichDraft {
  const content = JSON.parse(readFileSync(resolve(process.cwd(), '../protocol/test/fixtures/recipe-rich-v2.content.json'), 'utf8'));
  content.parts = []; content.memories = []; delete content.finalLogo;
  const info = {name: '产品群待办', summary: '把群里约定的下一步整理成待办', overview: '## 什么时候使用\n讨论结束后，整理刚刚确认的行动项。', version: '1.0', access: 'direct', ...patch};
  for (const field of ['name', 'summary', 'overview', 'version']) content.public[field].value = Reflect.get(info, field);
  const doc = canonicalizeRichRecipeContent(content);
  return recipeRichDraftSchema.parse({draftId, recipeId: null, revision, public: info, format: 'rich-v2', sourceIntentId: '019a8000-0000-7000-8000-000000000001', rich: {content: doc.content, texts: {}, canonical: Buffer.from(doc.canonicalUTF8).toString('base64url')}});
}
function committed(request: Extract<CommunityRequest, {type: 'saveRichDraftMetadata'}>) {
  draft = richDraft(request.revision + 1, request.public);
  return {status: 'committed', receipt: {requestId: request.requestId, draftId, revision: draft.revision, manifestSha256: createHash('sha256').update(Buffer.from(draft.rich.canonical, 'base64url')).digest('hex')}};
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label);
  expect(found, label).toBeDefined(); return found!;
}
async function click(label: string) {
  expect(button(label).disabled).toBe(false); await act(async () => button(label).click());
  await vi.waitFor(async () => {await act(async () => {}); expect(document.querySelector('.rich-draft-page[aria-busy="true"]')).toBeNull();});
}
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  await act(async () => {Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', {bubbles: true}));});
}
async function draw(props: RichDraftContinuationProps = {}) {
  await act(async () => root.render(<ClientProvider client={facade.client} shell={facade.shell}><DraftGuardProvider><RichRecipeEditor shell={facade.shell.community!} accountId={accountId} draft={draft} onBack={back} onPublished={() => {}} {...props}/></DraftGuardProvider></ClientProvider>));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById('root')!);
  draft = richDraft(); requests = []; back = vi.fn();
  send = async request => {if (request.type === 'draft') return draft; if (request.type === 'saveRichDraftMetadata') return committed(request); throw new Error('Unexpected request ' + request.type);};
  facade = createDesktopFacades({receive: listener => {emit = listener; return () => {};}, invoke: async (channel, ...args) => {
    if (channel !== desktopChannels.community) throw new Error('Unexpected channel ' + channel);
    const request = communityRequestSchema.parse(args[0]); requests.push(request);
    return {ok: true, value: await send(request)};
  }});
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks();});

it('keeps the named draft, six tabs and in-place metadata form without duplicated detail or engineering controls', async () => {
  await draw(); expect([...document.querySelectorAll('h1')].map(item => item.textContent)).toEqual(['产品群待办']);
  expect(document.querySelector('.rich-draft-heading p')?.textContent).toBe('配方草稿');
  expect(document.querySelector('.rich-draft-page')?.firstElementChild?.className).toBe('today-back');
  expect(document.querySelectorAll('[aria-label="配方详细信息"] button')).toHaveLength(6);
  await click('能力'); await click('编辑发布信息');
  expect(document.querySelector('[aria-current="page"]')?.textContent).toBe('概览');
  expect(document.querySelector('.community-detail-content .rich-draft-metadata')).not.toBeNull();
  expect(document.querySelectorAll('[aria-label="配方名称"]')).toHaveLength(1);
  expect(document.body.textContent).not.toMatch(/允许聊天修改|选择 Bot|选择设备|本次允许|操作历史/);
  await fill('配方名称', '取消的输入'); await click('取消'); expect(document.querySelector('.rich-draft-metadata')).toBeNull();
  expect(requests.some(item => item.type === 'saveRichDraftMetadata')).toBe(false);
});

it('saves publication information directly without a source or authoring session and keeps publication separate', async () => {
  const original = draft;
  await draw({chatContinuationUnavailable: '来源群聊已不可用，仍可编辑发布信息。'});
  expect(button('在飞书私聊中修改').disabled).toBe(true);
  await click('编辑发布信息'); await fill('配方名称', '发布信息新名称'); await click('完成编辑');
  const request = requests.find(item => item.type === 'saveRichDraftMetadata');
  expect(request).toMatchObject({accountId, draftId, revision: 1, public: {name: '发布信息新名称'}, logo: {kind: 'keep'}});
  if (request?.type !== 'saveRichDraftMetadata') throw new Error('Missing metadata command');
  expect(request.requestId).toMatch(/^[a-f0-9-]{14}7[a-f0-9-]{21}$/);
  expect(request.baseManifestSha256).toBe(createHash('sha256').update(Buffer.from(original.rich.canonical, 'base64url')).digest('hex'));
  expect(document.body.textContent).toContain('发布信息已保存');
  expect(document.querySelector('h1')?.textContent).toBe('发布信息新名称');
  expect(button('预览发布').disabled).toBe(false);
  expect(requests.some(item => item.type === 'publishDraft')).toBe(false);
});

it('retains the exact pending command and UUID after an uncertain save', async () => {
  let first = true;
  send = async request => {if (request.type === 'draft') return draft; if (request.type === 'saveRichDraftMetadata') {if (first) {first = false; return {status: 'uncertain'};} return committed(request);} throw new Error('Unexpected command');};
  await draw(); await click('编辑发布信息'); await fill('配方名称', '待核对保存'); await click('保存');
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe('待核对保存');
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.matches(':disabled')).toBe(true);
  expect(button('预览发布').disabled).toBe(true);
  await click('重试保存');
  const saves = requests.filter(item => item.type === 'saveRichDraftMetadata'); expect(saves).toHaveLength(2); expect(saves[1]).toEqual(saves[0]);
  expect(button('预览发布').disabled).toBe(false);
});

it('preserves the pending input when a committed receipt belongs to a different request', async () => {
  send = async request => {if (request.type === 'draft') return draft; if (request.type === 'saveRichDraftMetadata') {const result = committed(request); return {...result, receipt: {...result.receipt, requestId: '019a8000-0000-7000-8000-000000000099'}};} throw new Error('Unexpected command');};
  await draw(); await click('编辑发布信息'); await fill('配方名称', '仍待确认的输入'); await click('保存');
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe('仍待确认的输入');
  expect(document.body.textContent).toContain('保存回执尚未与本次修改匹配'); expect(button('预览发布').disabled).toBe(true);
  expect(requests.filter(item => item.type === 'draft')).toHaveLength(0);
  await click('重试保存'); const saves = requests.filter(item => item.type === 'saveRichDraftMetadata'); expect(saves[1]).toEqual(saves[0]);
});

it('keeps committed status when reloading fails and blocks publication until fresh bytes are verified', async () => {
  let failRead = true;
  send = async request => {if (request.type === 'draft') {if (failRead) throw new Error('read offline'); return draft;} if (request.type === 'saveRichDraftMetadata') return committed(request); throw new Error('Unexpected command');};
  await draw(); await click('编辑发布信息'); await fill('配方名称', '已经保存'); await click('保存');
  expect(document.body.textContent).toContain('修改已保存，最新草稿尚未读取');
  expect(button('预览发布').disabled).toBe(true);
  failRead = false; await click('重新读取'); expect(button('预览发布').disabled, document.body.textContent ?? '').toBe(false);
  expect(requests.filter(item => item.type === 'saveRichDraftMetadata')).toHaveLength(1);
});

it('preserves input on conflict and rebases only untouched fields after rereading', async () => {
  send = async request => {if (request.type === 'draft') return draft; if (request.type === 'saveRichDraftMetadata') return {status: 'rejected', code: 'conflict'}; throw new Error('Unexpected command');};
  await draw(); await click('编辑发布信息'); await fill('公开简介', '本地未保存简介'); await click('保存');
  expect(document.querySelector<HTMLInputElement>('[aria-label="公开简介"]')?.value).toBe('本地未保存简介');
  draft = richDraft(2, {name: '云端新名称'}); await click('重新读取');
  expect(document.querySelector<HTMLInputElement>('[aria-label="公开简介"]')?.value).toBe('本地未保存简介');
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe('云端新名称');
  expect(button('预览发布').disabled).toBe(true);
});

it('retains newer input typed while a save is waiting for its receipt', async () => {
  let release: (() => void) | undefined;
  send = async request => {if (request.type === 'draft') return draft; if (request.type === 'saveRichDraftMetadata') {await new Promise<void>(done => {release = done;}); return committed(request);} throw new Error('Unexpected command');};
  await draw(); await click('编辑发布信息'); await fill('配方名称', '提交的名称');
  await act(async () => {button('保存').click();});
  await fill('配方名称', '回执前的新输入'); await act(async () => {release?.();});
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe('回执前的新输入');
  expect(button('预览发布').disabled).toBe(true);
  const request = requests.find(item => item.type === 'saveRichDraftMetadata'); expect(request).toMatchObject({public: {name: '提交的名称'}});
});

it('blocks old publication when a remote revision receipt cannot be read', async () => {
  send = async () => {throw new Error('offline');};
  await draw();
  await act(async () => emit({type: 'account', value: {kind: 'signedIn', accountId, displayName: '作者', provider: 'github', persistence: 'memory'}}));
  await act(async () => emit({type: 'authoringSaved', value: {accountId, draftId, revision: 2}}));
  expect(button('预览发布').disabled).toBe(true);
  draft = richDraft(2); send = async () => draft; await click('重新读取'); expect(button('预览发布').disabled).toBe(false);
});

it('keeps the highest remote revision requirement when notifications arrive out of order', async () => {
  send = async () => {throw new Error('offline');}; await draw();
  await act(async () => emit({type: 'account', value: {kind: 'signedIn', accountId, displayName: '作者', provider: 'github', persistence: 'memory'}}));
  for (const revision of [3, 2]) await act(async () => emit({type: 'authoringSaved', value: {accountId, draftId, revision}}));
  draft = richDraft(2); send = async () => draft; await click('重新读取');
  expect(button('预览发布').disabled).toBe(true);
  draft = richDraft(3); await click('重新读取'); expect(button('预览发布').disabled).toBe(false);
});

it('rejects a fresh read whose canonical bytes do not match its committed receipt', async () => {
  send = async request => {if (request.type === 'draft') return draft; if (request.type === 'saveRichDraftMetadata') {const result = committed(request); return {...result, receipt: {...result.receipt, manifestSha256: '0'.repeat(64)}};} throw new Error('Unexpected command');};
  await draw(); await click('编辑发布信息'); await fill('配方名称', '提交后的名称'); await click('保存');
  expect(document.body.textContent).toContain('修改已保存，最新草稿尚未读取'); expect(button('预览发布').disabled).toBe(true);
  await click('重新读取'); expect(button('预览发布').disabled).toBe(true);
  await act(async () => emit({type: 'account', value: {kind: 'signedIn', accountId, displayName: '作者', provider: 'github', persistence: 'memory'}}));
  await act(async () => emit({type: 'authoringSaved', value: {accountId, draftId, revision: 2}}));
  expect(button('预览发布').disabled).toBe(true);
});

it('sends replacement Logo as padded standard base64 of the original bytes', async () => {
  await draw(); await click('编辑发布信息');
  const file = new File([new Uint8Array([251, 255, 0, 1])], 'logo.png', {type: 'image/png'});
  Object.defineProperty(file, 'arrayBuffer', {value: async () => new Uint8Array([251, 255, 0, 1]).buffer});
  const input = document.querySelector<HTMLInputElement>('[aria-label="上传配方 Logo"]')!;
  Object.defineProperty(input, 'files', {value: [file]});
  await act(async () => input.dispatchEvent(new Event('change', {bubbles: true}))); await click('保存');
  expect(requests.find(item => item.type === 'saveRichDraftMetadata')).toMatchObject({logo: {kind: 'replace', base64: '+/8AAQ=='}});
});

it('removes an existing Logo with an explicit action', async () => {
  draft = {...draft, logo: 'https://example.com/logo.png'}; await draw(); await click('编辑发布信息'); await click('移除'); await click('保存');
  expect(requests.find(item => item.type === 'saveRichDraftMetadata')).toMatchObject({logo: {kind: 'remove'}});
});

it('guards navigation with unsaved inputs and delegates continuation only with a saved draft', async () => {
  const continueChat = vi.fn(); await draw({onContinueInChat: continueChat});
  await click('在飞书私聊中修改'); expect(continueChat).toHaveBeenCalledWith(draft);
  await click('编辑发布信息'); await fill('配方名称', '未保存输入'); expect(button('在飞书私聊中修改').disabled).toBe(true);
  await click('返回创作中心'); expect(back).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('有未保存的修改');
  await click('继续编辑'); expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe('未保存输入');
});

it('leaves public recipe details free of draft author controls', async () => {
  await act(async () => root.render(<RecipeDetails recipe={{recipeId: draftId, versionId: draftId, revision: 1, public: draft.public, owned: false, acquired: true, rich: draft.rich}}/>));
  expect(document.body.textContent).not.toMatch(/编辑发布信息|在飞书私聊中修改|删除草稿|保存/);
});
