// @vitest-environment jsdom
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
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
import {communityRequest} from '../../desktop/src/community-api';
import {MetadataJournal} from '../../desktop/src/community-metadata-journal';
import type {NativeAccount} from '../../desktop/src/account-session';
import {RecipeEditor} from '../src/community/RecipeEditor';
import {RecipeDetails} from '../src/community/RecipeContent';

const accountId = '44444444-4444-4444-8444-444444444444';
const draftId = '55555555-5555-4555-8555-555555555555';
let root: Root;
let draft: RecipeRichDraft;
let requests: CommunityRequest[];
let send: (request: CommunityRequest) => Promise<unknown>;
let recover: (request: Extract<CommunityRequest, {type: 'recoverRichDraftMetadata'}>) => Promise<unknown>;
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
  recover = async () => ({status: 'current', draft});
  send = async request => {if (request.type === 'draft') return draft; if (request.type === 'saveRichDraftMetadata') return committed(request); throw new Error('Unexpected request ' + request.type);};
  facade = createDesktopFacades({receive: listener => {emit = listener; return () => {};}, invoke: async (channel, ...args) => {
    if (channel !== desktopChannels.community) throw new Error('Unexpected channel ' + channel);
    const request = communityRequestSchema.parse(args[0]); requests.push(request);
    return {ok: true, value: request.type === 'recoverRichDraftMetadata' ? await recover(request) : await send(request)};
  }});
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks();});

it('keeps the named draft, five tabs and in-place metadata form without duplicated detail or engineering controls', async () => {
  await draw(); expect([...document.querySelectorAll('h1')].map(item => item.textContent)).toEqual(['产品群待办']);
  expect(document.querySelector('.rich-draft-heading p')?.textContent).toBe('配方草稿');
  expect(document.querySelector('.rich-draft-page')?.firstElementChild?.className).toBe('today-back');
  expect(document.querySelectorAll('[aria-label="配方详细信息"] button')).toHaveLength(5);
  await click('能力'); await click('编辑发布信息');
  expect(document.querySelector('[aria-current="page"]')?.textContent).toBe('概览');
  expect(document.querySelector('.community-detail-content .rich-draft-metadata')).not.toBeNull();
  expect(document.querySelectorAll('[aria-label="配方名称"]')).toHaveLength(1);
  expect(document.body.textContent).not.toMatch(/允许聊天修改|选择 Bot|选择设备|本次允许|操作历史/);
  await fill('配方名称', '取消的输入'); await click('取消'); expect(document.querySelector('.rich-draft-metadata')).toBeNull();
  expect(requests.some(item => item.type === 'saveRichDraftMetadata')).toBe(false);
});
it('keeps historical memory out of private draft detail and its publication preview', async () => {
  const content = structuredClone(draft.rich.content);
  content.memories = [{itemId: '10000000-0000-4000-8000-000000000006', originId: '20000000-0000-4000-8000-000000000006', text: {kind: 'inline', value: 'PRIVATE_DRAFT_MEMORY_SENTINEL'}}];
  const doc = canonicalizeRichRecipeContent(content);
  draft = {...draft, rich: {content: doc.content, texts: {}, canonical: Buffer.from(doc.canonicalUTF8).toString('base64url')}};
  await draw();
  for (const label of ['概览', '模型与权限', '能力', '沟通方式', '任务']) {
    await click(label);
    expect(document.querySelector('[aria-label="配方详细信息"]')?.textContent).not.toContain('记忆');
    expect(document.body.textContent).not.toContain('PRIVATE_DRAFT_MEMORY_SENTINEL');
  }
  await click('预览发布');
  const preview = document.querySelector('[role="dialog"]');
  expect(preview?.textContent).toContain('发布后此版本内容固定');
  expect(preview?.querySelectorAll('[aria-label="配方详细信息"] button')).toHaveLength(5);
  expect(preview?.textContent).not.toContain('记忆');
  expect(document.body.textContent).not.toContain('PRIVATE_DRAFT_MEMORY_SENTINEL');
  expect(requests.some(item => item.type === 'publishDraft')).toBe(false);
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

it('keeps expired metadata input editable and explains how to save it again', async () => {
  let attempt = 0;
  send = async request => {
    if (request.type === 'draft') return draft;
    if (request.type === 'saveRichDraftMetadata') {
      if (++attempt === 1) return {status: 'uncertain'};
      if (attempt === 2) return {status: 'rejected', code: 'operation_expired'};
      return committed(request);
    }
    throw new Error('Unexpected command');
  };
  await draw(); await vi.waitFor(() => expect(button('编辑发布信息').disabled, document.body.textContent ?? '').toBe(false));
  await click('编辑发布信息'); await fill('配方名称', '过期后仍保留'); await click('保存'); await click('重试保存');
  const message = document.querySelector('.ui-inline-notice--warning p')?.textContent;
  expect(message).toBe('本次保存已过期，修改仍保留，请重新保存');
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe('过期后仍保留');
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.matches(':disabled')).toBe(false);
  await click('保存');
  const saves = requests.filter(item => item.type === 'saveRichDraftMetadata');
  expect(saves[1]).toEqual(saves[0]); expect(saves[2]?.requestId).not.toBe(saves[0]?.requestId);
  expect(document.body.textContent).toContain('发布信息已保存');
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
  draft = {...draft, logo: 'data:image/webp;base64,AAAA'}; await draw(); await click('编辑发布信息'); await click('移除'); await click('保存');
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

it('keeps newer input when a leave-dialog retry confirms only the older command', async () => {
  let finish!: () => void; let attempt = 0;
  send = async request => {
    if (request.type === 'draft') return draft;
    if (request.type === 'saveRichDraftMetadata') {
      if (++attempt === 1) {await new Promise<void>(resolve => {finish = resolve;}); return {status: 'uncertain', code: 'offline'};}
      return committed(request);
    }
    throw new Error('Unexpected request');
  };
  await draw(); await click('编辑发布信息'); await fill('配方名称', '保存 A');
  await act(async () => {button('保存').click();}); await fill('配方名称', '仍未提交 B'); await act(async () => finish());
  await click('返回创作中心'); expect(button('稍后核对并离开').disabled).toBe(false);
  await click('保存并离开'); expect(back).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe('仍未提交 B');
  expect(document.body.textContent).toContain('先前提交已保存，当前输入仍未保存');
  expect(document.querySelector('.rich-draft-status')?.textContent).not.toBe('发布信息已保存');
  const saves = requests.filter(item => item.type === 'saveRichDraftMetadata'); expect(saves[1]).toEqual(saves[0]);
  await click('保存并离开'); expect(back).toHaveBeenCalledOnce();
  expect(requests.filter(item => item.type === 'saveRichDraftMetadata')[2]).toMatchObject({public: {name: '仍未提交 B'}, revision: 2});
});

it('updates an open leave dialog when a save becomes unresolved', async () => {
  let finish!: () => void;
  send = async request => {
    if (request.type === 'draft') return draft;
    if (request.type === 'saveRichDraftMetadata') {await new Promise<void>(resolve => {finish = resolve;}); return {status: 'uncertain', code: 'offline'};}
    throw new Error('Unexpected request');
  };
  await draw(); await click('编辑发布信息'); await fill('配方名称', '待核对'); await click('返回创作中心');
  expect(button('放弃并离开').disabled).toBe(false);
  await act(async () => {button('保存并离开').click();}); expect(button('放弃并离开').disabled).toBe(true);
  await act(async () => finish()); expect(button('稍后核对并离开').disabled).toBe(false);
  expect(document.body.textContent).toContain('已提交的保存不会因离开而取消'); expect(back).not.toHaveBeenCalled();
});

it.each([false, true])('requires a fresh delete confirmation after a remote revision (read succeeds %s)', async readSucceeds => {
  await draw(); await click('删除草稿');
  await act(async () => emit({type: 'account', value: {kind: 'signedIn', accountId, displayName: '作者', provider: 'github', persistence: 'memory'}}));
  draft = richDraft(2, {name: '尚未确认的新版本'});
  send = async () => {if (!readSucceeds) throw new Error('offline'); return draft;};
  await act(async () => emit({type: 'authoringSaved', value: {accountId, draftId, revision: 2}}));
  const deletes = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.textContent === '删除草稿');
  expect(deletes.at(-1)?.disabled).toBe(true); await act(async () => deletes.at(-1)?.click());
  expect(requests.some(item => item.type === 'deleteDraft')).toBe(false);
  await click('保留');
  if (!readSucceeds) {send = async () => draft; await click('重新读取');}
  await click('删除草稿');
  send = async request => {expect(request).toMatchObject({type: 'deleteDraft', revision: 2}); return {};};
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.textContent === '删除草稿').at(-1)?.click());
  expect(requests.some(item => item.type === 'deleteDraft' && item.revision === 2)).toBe(true);
});

async function deferLogo() {
  let finish!: () => void; const bytes = new Uint8Array([251, 255, 0, 1]);
  const file = new File([bytes], 'logo.png', {type: 'image/png'});
  Object.defineProperty(file, 'arrayBuffer', {value: () => new Promise<ArrayBuffer>(resolve => {finish = () => resolve(bytes.buffer);})});
  const input = document.querySelector<HTMLInputElement>('[aria-label="上传配方 Logo"]')!;
  Object.defineProperty(input, 'files', {value: [file]});
  await act(async () => input.dispatchEvent(new Event('change', {bubbles: true})));
  return () => act(async () => finish());
}
it.each([[false, '完成编辑'], [true, '完成编辑'], [true, '保存']])('waits for a selected Logo before saving (text changed %s, action %s)', async (changeText, action) => {
  await draw(); await click('编辑发布信息'); if (changeText) await fill('配方名称', '文字与图片');
  const finish = await deferLogo(); await act(async () => button(String(action)).click());
  expect(requests.some(item => item.type === 'saveRichDraftMetadata')).toBe(false);
  expect(document.querySelector('.rich-draft-metadata')).not.toBeNull(); await finish();
  await vi.waitFor(() => expect(requests.find(item => item.type === 'saveRichDraftMetadata')).toMatchObject({logo: {kind: 'replace', base64: '+/8AAQ=='}}));
  expect(document.querySelector('.rich-draft-metadata')).toBeNull();
});
it('guards a pending Logo read and waits before saving and leaving', async () => {
  await draw(); await click('编辑发布信息'); const finish = await deferLogo();
  await click('返回创作中心'); expect(back).not.toHaveBeenCalled();
  await act(async () => button('保存并离开').click()); expect(back).not.toHaveBeenCalled(); await finish();
  await vi.waitFor(() => expect(back).toHaveBeenCalledOnce());
  expect(requests.find(item => item.type === 'saveRichDraftMetadata')).toMatchObject({logo: {kind: 'replace', base64: '+/8AAQ=='}});
});
it('cancels an unsubmitted Logo read without creating hidden changes', async () => {
  await draw(); await click('编辑发布信息'); const finish = await deferLogo();
  await click('取消'); await finish(); await click('返回创作中心');
  expect(back).toHaveBeenCalledOnce(); expect(requests.some(item => item.type === 'saveRichDraftMetadata')).toBe(false);
});
it('invalidates deletion when a manual refresh cannot establish the current revision', async () => {
  await draw(); await click('编辑发布信息'); await fill('配方名称', 'x'.repeat(61)); await click('保存');
  await click('删除草稿'); send = async () => {throw new Error('offline');}; await click('重新读取');
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.textContent === '删除草稿').at(-1)!;
  expect(confirm.disabled).toBe(true); await act(async () => confirm.click());
  expect(requests.some(item => item.type === 'deleteDraft')).toBe(false);
  await click('保留'); expect(button('删除草稿').disabled).toBe(true);
});
it('discards an unsubmitted image through the leave guard without a late hidden change', async () => {
  await draw(); await click('编辑发布信息'); const finish = await deferLogo();
  await click('返回创作中心'); await click('放弃并离开'); expect(back).toHaveBeenCalledOnce();
  await finish(); expect(requests.some(item => item.type === 'saveRichDraftMetadata')).toBe(false);
  await click('返回创作中心'); expect(back).toHaveBeenCalledTimes(2);
});
it('retries an unresolved exact command while retaining a newer unread remote revision requirement', async () => {
  let attempt = 0;
  send = async request => {
    if (request.type === 'draft') {if (attempt === 1) throw new Error('offline'); return draft;}
    if (request.type === 'saveRichDraftMetadata') return ++attempt === 1 ? {status: 'uncertain', code: 'offline'} : committed(request);
    throw new Error('Unexpected request');
  };
  await draw(); await click('编辑发布信息'); await fill('配方名称', '待核对的提交'); await click('保存');
  await act(async () => emit({type: 'account', value: {kind: 'signedIn', accountId, displayName: '作者', provider: 'github', persistence: 'memory'}}));
  await act(async () => emit({type: 'authoringSaved', value: {accountId, draftId, revision: 3}}));
  await click('重试保存');
  const saves = requests.filter(item => item.type === 'saveRichDraftMetadata'); expect(saves[1]).toEqual(saves[0]);
  expect(button('预览发布').disabled).toBe(true); expect(button('删除草稿').disabled).toBe(true);
  draft = richDraft(3); await click('重新读取'); expect(button('预览发布').disabled).toBe(false);
});
it('keeps text unsent when the selected Logo cannot be read', async () => {
  await draw(); await click('编辑发布信息'); await fill('配方名称', '尚未保存的文字');
  let fail!: () => void;
  const file = new File(['image'], 'logo.png', {type: 'image/png'});
  Object.defineProperty(file, 'arrayBuffer', {value: () => new Promise<ArrayBuffer>((_resolve, reject) => {fail = () => reject(new Error('read failed'));})});
  const input = document.querySelector<HTMLInputElement>('[aria-label="上传配方 Logo"]')!;
  Object.defineProperty(input, 'files', {value: [file]});
  await act(async () => input.dispatchEvent(new Event('change', {bubbles: true})));
  await act(async () => button('保存').click()); await act(async () => fail());
  expect(requests.some(item => item.type === 'saveRichDraftMetadata')).toBe(false);
  expect(document.body.textContent).toContain('图片尚未读取，请重新选择');
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe('尚未保存的文字');
});

it('reconciles Main journal state again after renderer remount and exposes a retry before editing or publishing', async () => {
  await draw(); await click('编辑发布信息'); await fill('配方名称', '已提交 A');
  send = async request => request.type === 'saveRichDraftMetadata' ? {status:'uncertain'} : draft;
  await click('保存'); await click('返回创作中心');
  expect(document.body.textContent).toContain('已提交的保存不会因离开而取消');
  await click('稍后核对并离开'); expect(back).toHaveBeenCalledOnce();
  await act(async () => root.render(<div/>));
  recover = async () => ({status:'uncertain'}); await draw();
  expect(button('编辑发布信息').disabled).toBe(true); expect(button('预览发布').disabled).toBe(true);
  expect(button('重试核对保存').disabled).toBe(false);
  draft = richDraft(2, {name:'已提交 A'}); recover = async () => ({status:'current',draft});
  await click('重试核对保存'); expect(document.querySelector('h1')?.textContent).toBe('已提交 A');
  expect(button('预览发布').disabled).toBe(false);
  expect(requests.filter(request => request.type === 'saveRichDraftMetadata')).toHaveLength(1);
  expect(requests.filter(request => request.type === 'recoverRichDraftMetadata')).toHaveLength(3);
});
it('keeps a recovered committed receipt through a failed reload and verifies its canonical hash before publication', async () => {
  const recovered = richDraft(2,{name:'已保存的 A'});
  const receipt = {requestId:'019a8000-0000-7000-8000-000000000099',draftId,revision:2,manifestSha256:createHash('sha256').update(Buffer.from(recovered.rich.canonical,'base64url')).digest('hex')};
  recover = async () => ({status:'committed',receipt});
  send = async () => {throw new Error('offline');}; await draw();
  expect(document.body.textContent).toContain('发布信息已保存'); expect(button('预览发布').disabled).toBe(true);
  recover = async () => ({status:'current',draft:richDraft(2,{name:'错误的内容'})}); await click('重试核对保存');
  expect(button('预览发布').disabled).toBe(true);
  recover = async () => ({status:'current',draft:recovered}); await click('重试核对保存');
  expect(button('预览发布').disabled).toBe(false); expect(document.querySelector('h1')?.textContent).toBe('已保存的 A');
  expect(requests.some(request=>request.type==='saveRichDraftMetadata')).toBe(false);
});
it('ignores an old account recovery after the editor switches account and preserves the new account draft', async () => {
  let finish!: (value:unknown)=>void;
  recover = () => new Promise(resolve => {finish=resolve;}); await draw();
  expect(button('预览发布').disabled).toBe(true);
  const previousFinish=finish, nextAccount='88888888-8888-4888-8888-888888888888';
  const nextDraft=richDraft(3,{name:'新账号草稿'});
  recover = async request => {expect(request.accountId).toBe(nextAccount); return {status:'current',draft:nextDraft};};
  await act(async () => root.render(<ClientProvider client={facade.client} shell={facade.shell}><DraftGuardProvider><RichRecipeEditor shell={facade.shell.community!} accountId={nextAccount} draft={draft} onBack={back} onPublished={()=>{}}/></DraftGuardProvider></ClientProvider>));
  await act(async()=> previousFinish({status:'current',draft:richDraft(9,{name:'旧账号迟到的草稿'})}));
  expect(document.querySelector('h1')?.textContent).toBe('新账号草稿'); expect(button('预览发布').disabled).toBe(false);
});
it('retains the highest revision requirement while initial recovery is delayed', async()=>{
  let finish!:(value:unknown)=>void;
  recover=()=>new Promise(resolve=>{finish=resolve;}); await draw();
  send=async()=>{throw new Error('offline');};
  await act(async()=>emit({type:'account',value:{kind:'signedIn',accountId,displayName:'作者',provider:'github',persistence:'memory'}}));
  await act(async()=>emit({type:'authoringSaved',value:{accountId,draftId,revision:4}}));
  await act(async()=>finish({status:'current',draft:richDraft(2)}));
  expect(button('预览发布').disabled).toBe(true);
  recover=async()=>({status:'current',draft:richDraft(4)}); await click('重试核对保存'); expect(button('预览发布').disabled).toBe(false);
});

it.each(['before', 'after', 'none'])('keeps an edit back to the old value with a remote notification %s the receipt', async timing => {
  const originalName = draft.public.name;
  let finish!: () => void;
  let count = 0;
  send = async request => {
    if (request.type === 'draft') return draft;
    if (request.type !== 'saveRichDraftMetadata') throw new Error('Unexpected ' + request.type);
    const result = committed(request);
    if (++count === 1) await new Promise<void>(resolve => {finish = resolve;});
    return result;
  };
  const notify = async () => {
    draft = richDraft(3, {name: '已提交 A', summary: '远端更新的简介'});
    await act(async () => emit({type:'account',value:{kind:'signedIn',accountId,displayName:'作者',provider:'github',persistence:'memory'}}));
    await act(async () => emit({type:'authoringSaved',value:{accountId,draftId,revision:3}}));
  };
  await draw(); await click('编辑发布信息'); await fill('配方名称', '已提交 A');
  await act(async () => button('保存').click());
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await fill('配方名称', originalName);
  if (timing === 'before') await notify();
  await act(async () => finish());
  if (timing === 'after') await notify();
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe(originalName);
  expect(document.body.textContent).toContain('先前提交已保存，当前输入仍未保存');
  if (timing !== 'none') expect(document.querySelector<HTMLInputElement>('[aria-label="公开简介"]')?.value).toBe('远端更新的简介');
  expect(button('预览发布').disabled).toBe(true);
  await click('返回创作中心'); await click('保存并离开'); expect(back).toHaveBeenCalledOnce();
  expect(requests.filter(request => request.type === 'saveRichDraftMetadata').at(-1)).toMatchObject({revision: timing === 'none' ? 2 : 3, public:{name:originalName}});
});

async function openDraft(knownRichDraft = false, account = accountId) {
  await act(async () => root.render(<ClientProvider client={facade.client} shell={facade.shell}><DraftGuardProvider>
    <RecipeEditor shell={facade.shell.community!} accountId={account} draftId={draftId} knownRichDraft={knownRichDraft} onBack={back} onPublished={() => {}}/>
  </DraftGuardProvider></ClientProvider>));
}
it.each(['operation_expired','conflict'] as const)('explains a previous %s without acquisition or retained-input promises and reopens the verified cloud draft', async code => {
  recover = async () => ({status:'rejected',code});
  await openDraft(true);
  expect(document.body.textContent).toContain(code === 'operation_expired' ? '此前保存已过期，请重新读取草稿并核对。' : '草稿已有更新，请重新读取并核对。');
  expect(document.body.textContent).not.toMatch(/领取|修改仍保留|输入仍保留/);
  recover = async () => ({status:'current',draft});
  await click('重试读取');
  expect(document.querySelector('h1')?.textContent).toBe(draft.public.name);
  expect(button('预览发布').disabled).toBe(false);
});
it.each(['operation_expired','conflict'] as const)('does not promise restored local input after leaving an uncertain save and reopening with %s', async code => {
  send = async request => request.type === 'draft' ? draft : {status:'uncertain'};
  await openDraft();
  await click('编辑发布信息'); await fill('配方名称','离开前未提交的名称'); await click('保存');
  await click('返回创作中心'); await click('稍后核对并离开');
  await act(async () => root.render(<div/>));
  recover = async () => ({status:'rejected',code});
  await openDraft();
  expect(document.body.textContent).toContain(code === 'operation_expired' ? '此前保存已过期，请核对草稿后重新保存。' : '草稿已有更新，请重新读取并核对。');
  expect(document.body.textContent).not.toMatch(/领取|修改仍保留|输入仍保留/);
  await click('编辑发布信息');
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe(draft.public.name);
});
it('offers an honest retry and leave from the draft entry when the ordinary read and the previous save are unresolved', async () => {
  send = async () => {throw new Error('offline');};
  recover = async () => ({status:'uncertain'});
  await openDraft();
  expect(requests.map(request => request.type)).toEqual(['draft','recoverRichDraftMetadata']);
  expect(document.body.textContent).toContain('此前保存尚未核对完成');
  await click('返回创作中心'); await click('稍后核对并离开'); expect(back).toHaveBeenCalledOnce();
  recover = async () => ({status:'current',draft});
  await click('重试核对保存'); expect(button('预览发布').disabled).toBe(false);
});
it('retains the role-only entry and ignores recovery that completes after switching accounts', async () => {
  let finish!: (result:unknown) => void;
  recover = () => new Promise(resolve => {finish=resolve;});
  await openDraft(true);
  send = async () => ({draftId,recipeId:null,revision:1,public:{...draft.public,name:'旧格式草稿'},config:{role:'助手'}});
  await openDraft(false,'55555555-5555-4555-8555-555555555556');
  await act(async () => finish({status:'current',draft}));
  expect(document.body.textContent).toContain('旧格式草稿');
  expect(button('编辑草稿').disabled).toBe(false);
  expect(requests.map(request => request.type)).toEqual(['recoverRichDraftMetadata','draft']);
});
it('keeps notifications received while the real entry is loading', async () => {
  let finish!: (result:unknown) => void;
  recover = () => new Promise(resolve => {finish = resolve;});
  await openDraft(true);
  await act(async () => emit({type:'account',value:{kind:'signedIn',accountId,displayName:'作者',provider:'github',persistence:'memory'}}));
  await act(async () => emit({type:'authoringSaved',value:{accountId,draftId,revision:3}}));
  await act(async () => finish({status:'current',draft}));
  expect(button('预览发布').disabled).toBe(true);
  recover = async () => ({status:'current',draft:richDraft(3)}); await click('重试核对保存');
  expect(button('预览发布').disabled).toBe(false);
});
it.each([2,3])('opens the real editor across Main and renderer restarts only after verified r%i', async finalRevision => {
  const dir = mkdtempSync(resolve(tmpdir(),'vonvon-editor-recovery-'));
  const correct = richDraft(2,{name:'已确认的 A'}), requestId = '019a8000-0000-7000-8000-000000000099';
  const hash = (d: RecipeRichDraft) => createHash('sha256').update(Buffer.from(d.rich.canonical,'base64url')).digest('hex');
  const receipt = {requestId,draftId,revision:2,manifestSha256:hash(correct)};
  const journal = new MetadataJournal(dir), key = journal.key(accountId,draftId);
  journal.write(key,{request:{type:'saveRichDraftMetadata',accountId,requestId,draftId,revision:1,baseManifestSha256:hash(draft),public:correct.public,logo:{kind:'keep'}}});
  let current: RecipeRichDraft | undefined;
  const signedIn = {kind:'signedIn',accountId,displayName:'作者',provider:'github',persistence:'memory'} as const;
  const account: NativeAccount = {
    status:()=>signedIn,onStatus:()=>()=>{},login:async()=>signedIn,logout:async()=>signedIn,cancelLogin:async()=>signedIn,dispose:async()=>{},
    async request(_id,path) {
      if (path.endsWith('/metadata')) return Response.json({status:'committed',receipt});
      if (!current) throw new Error('offline');
      const bytes = Buffer.from(current.rich.canonical,'base64url');
      if (path.endsWith('/objects/'+requestId)) return new Response(bytes);
      if (path !== '/v2/drafts/'+draftId) throw new Error('Unexpected '+path);
      return Response.json({format:'rich-v2',draftId,recipeId:null,revision:current.revision,access:current.public.access,sourceIntentId:current.sourceIntentId,
        manifest:{kind:'manifest',objectId:requestId,bytes:bytes.length,sha256:hash(current),mediaType:'application/json'},logicalBytes:bytes.length,retainedCandidateBytes:0,sourceManifest:null});
    },
  };
  recover = request => communityRequest(account,request,new MetadataJournal(dir));
  send = request => communityRequest(account,request,new MetadataJournal(dir));
  try {
    await openDraft();
    expect(document.body.textContent).toContain('此前提交已保存');
    for (const stale of [richDraft(1),richDraft(2,{name:'错误的 A'})]) {
      await act(async()=>root.render(<div/>)); current=stale; await openDraft(true);
      expect(document.body.textContent).toContain('此前提交已保存');
      expect(document.querySelector('.rich-draft-heading')).toBeNull();
      expect(journal.read(key)?.receipt).toEqual(receipt);
    }
    current = finalRevision === 2 ? correct : richDraft(3,{name:'后续修订'});
    await click('重试核对保存');
    expect(button('预览发布').disabled).toBe(false);
    expect(journal.read(key)).toBeUndefined();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
