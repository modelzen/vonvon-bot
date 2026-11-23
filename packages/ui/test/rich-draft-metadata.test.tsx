// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {canonicalizeRichRecipeContent, communityRequestSchema, desktopAuthoringRequestSchema, recipeRichDraftSchema, type CommunityRequest, type DesktopAuthoringRequest, type RecipeDraft, type RecipeRichDraft} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {ClientProvider} from '../src/client-context';
import {RecipeDraftPage} from '../src/community/RecipeDraftPage';

const accountId = '44444444-4444-4444-8444-444444444444';
const otherAccount = '44444444-4444-4444-8444-444444444445';
const draftId = '55555555-5555-4555-8555-555555555555';
let root: Root;
let draft: RecipeDraft;
let requests: CommunityRequest[];
let send: (request: CommunityRequest) => Promise<unknown>;
let authoringRequests: DesktopAuthoringRequest[];
let authoringSend: (request: DesktopAuthoringRequest) => Promise<unknown>;
let facade: ReturnType<typeof createDesktopFacades>;
let emit: (value: unknown) => void;
let back: ReturnType<typeof vi.fn>;
const resume = vi.fn(), published = vi.fn();
function richDraft(revision = 1, patch: Partial<RecipeRichDraft['public']> = {}): RecipeRichDraft {
  const content = JSON.parse(readFileSync(resolve(process.cwd(), '../protocol/test/fixtures/recipe-rich-v2.content.json'), 'utf8'));
  content.parts = []; content.memories = []; delete content.finalLogo;
  const info = {name: '产品群待办', summary: '把群里约定的下一步整理成待办', overview: '## 什么时候使用\n讨论结束后，整理刚刚确认的行动项。', version: '1.0', access: 'direct', ...patch};
  for (const field of ['name', 'summary', 'overview', 'version']) content.public[field].value = Reflect.get(info, field);
  const identity = (n: number) => ({itemId: `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`, originId: `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`});
  const file = {...identity(1), name: 'SKILL.md', use: 'skillDescription', text: {kind: 'inline', value: 'SETUP_SKILL_BODY'}};
  content.files = [file]; content.skills = [{...identity(2), name: 'setup', entryFileId: file.itemId, fileIds: [file.itemId]}];
  content.settings = [{...identity(3), field: 'presentation.voiceEnabled', value: true}];
  content.memories = [{...identity(4), text: {kind: 'inline', value: 'PRIVATE_MEMORY_NEVER_DISPLAY'}}];
  content.setup = [{...identity(5), kind: 'tool', title: '旧说明', instructions: 'LEGACY_SETUP_KEEP', check: '核对工具', required: true, action: {kind: 'manual'}}];
  const doc = canonicalizeRichRecipeContent(content);
  return recipeRichDraftSchema.parse({draftId, recipeId: null, revision, public: info, format: 'rich-v2', sourceIntentId: '019a8000-0000-7000-8000-000000000001', rich: {content: doc.content, texts: {}, canonical: Buffer.from(doc.canonicalUTF8).toString('base64url')}});
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label);
  expect(found, label).toBeDefined(); return found!;
}
async function click(label: string) {expect(button(label).disabled).toBe(false); await act(async () => button(label).click());}
async function draw(account = accountId, expectedRevision?: number) {
  await act(async () => {
    emit({type: 'account', value: {kind: 'signedIn', accountId: account, displayName: '作者', provider: 'github', persistence: 'memory'}});
    root.render(<ClientProvider client={facade.client} shell={facade.shell}><RecipeDraftPage shell={facade.shell.community!} accountId={account} draftId={draftId} expectedRevision={expectedRevision} onBack={back} onContinueInChat={resume} onPublished={published}/></ClientProvider>);
  });
}
async function saved(revision: number, account = accountId, id = draftId) {await act(async () => emit({type: 'authoringSaved', value: {accountId: account, draftId: id, revision}}));}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById('root')!);
  draft = richDraft(); requests = []; authoringRequests = []; back = vi.fn(); resume.mockReset(); published.mockReset();
  authoringSend = async request => {
    if (request.type === 'recoverPublication') return {kind: 'publicationRecovery', result: {kind: 'absent'}};
    if (request.type === 'preparePublication') return {kind: 'publicationReady', reviewId: otherAccount, draftId, revision: request.draft.revision, public: request.draft.public};
    throw new Error('Unexpected authoring request ' + request.type);
  };
  send = async request => {if (request.type === 'draft') return draft; throw new Error('Unexpected request ' + request.type);};
  facade = createDesktopFacades({receive: listener => {emit = listener; return () => {};}, invoke: async (channel, ...args) => {
    if (channel === desktopChannels.recipeAuthoring) {
      const request = desktopAuthoringRequestSchema.parse(args[0]); authoringRequests.push(request);
      return {ok: true, value: await authoringSend(request)};
    }
    if (channel !== desktopChannels.community) throw new Error('Unexpected channel ' + channel);
    const request = communityRequestSchema.parse(args[0]); requests.push(request);
    return {ok: true, value: await send(request)};
  }});
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks();});

it('reads complete rich content through five shared tabs without editing, publishing or metadata recovery writes', async () => {
  await draw();
  expect(document.querySelector('h1')?.textContent).toBe('产品群待办');
  expect(document.body.textContent).toContain(draft.public.summary);
  expect(document.body.textContent).toContain('创作中 · 仅自己可见');
  expect(document.body.textContent).toContain('LEGACY_SETUP_KEEP');
  expect(document.querySelector('input, textarea')).toBeNull();
  expect(document.body.textContent).not.toMatch(/编辑发布信息/);
  expect(button('发布到社区').disabled).toBe(false);
  expect([...document.querySelectorAll('[aria-label="配方详细信息"] button')].map(node => node.textContent)).toEqual(['概览', '模型与权限', '能力', '沟通方式', '任务']);
  for (const section of ['概览', '模型与权限', '能力', '沟通方式', '任务']) {
    await click(section);
    expect(document.body.textContent).not.toContain('PRIVATE_MEMORY_NEVER_DISPLAY');
  }
  await click('能力'); expect(document.body.textContent).toContain('SETUP_SKILL_BODY');
  await click('沟通方式'); expect(document.body.textContent).toContain('语音回复');
  await click('在飞书继续创作'); expect(resume).toHaveBeenCalledWith(draft);
  expect(requests).toEqual([{type: 'draft', accountId, draftId}]);
  expect(authoringRequests).toEqual([]);
});

it('preserves complete legacy role data without conversion and names unnamed works honestly', async () => {
  draft = {draftId, recipeId: null, revision: 3, public: {...draft.public, name: ''}, config: {role: 'LEGACY_ROLE_KEEP', setup: {steps: [{kind: 'tool', title: '已有说明', instructions: 'LEGACY_NOTES_KEEP', required: false}]}}};
  await draw();
  expect(document.querySelector('h1')?.textContent).toBe('未命名配方');
  expect(document.body.textContent).toContain('LEGACY_NOTES_KEEP');
  await click('能力'); expect(document.body.textContent).toContain('LEGACY_ROLE_KEEP');
  await click('在飞书继续创作'); expect(resume).toHaveBeenCalledWith(draft);
  expect(requests.map(request => request.type)).toEqual(['draft']);
});

it('refreshes only the exact draft and account and never accepts a read below the highest saved revision', async () => {
  await draw();
  await saved(3, otherAccount); await saved(3, accountId, accountId);
  expect(requests).toHaveLength(1);
  draft = richDraft(2); await saved(3);
  expect(button('在飞书继续创作').disabled).toBe(true);
  expect(document.body.textContent).toContain('尚未读取到最新内容');
  await saved(2); expect(requests).toHaveLength(2);
  draft = richDraft(3, {name: '最新修订'}); await click('重新读取');
  expect(document.querySelector('h1')?.textContent).toBe('最新修订');
  expect(button('在飞书继续创作').disabled).toBe(false);
});

it('ignores a late older read and failure after a newer saved notification', async () => {
  await draw();
  let finishOld!: (result: unknown) => void;
  send = request => request.type === 'draft' ? new Promise(resolve => {finishOld = resolve;}) : Promise.reject(new Error('Unexpected'));
  await saved(2);
  draft = richDraft(3, {name: '第三次修订'}); send = async () => draft;
  await saved(3);
  await act(async () => finishOld(richDraft(2, {name: '过期读取'})));
  expect(document.querySelector('h1')?.textContent).toBe('第三次修订');
  expect(button('在飞书继续创作').disabled).toBe(false);
});

it('retains saved notifications received while the initial draft read is pending', async () => {
  let first!: (result: unknown) => void;
  send = () => new Promise(resolve => {first = resolve;});
  await draw();
  const finishInitial = first;
  await saved(4);
  await act(async () => first(richDraft(3)));
  expect(document.body.textContent).toContain('尚未读取到最新内容');
  await act(async () => finishInitial(richDraft(1)));
  expect(document.querySelector('h1')).toBeNull();
  draft = richDraft(4); send = async () => draft; await click('重新读取');
  expect(button('在飞书继续创作').disabled).toBe(false);
});

it('leaves deleted or unreadable work visible only as stale content with continuation and deletion disabled', async () => {
  await draw();
  send = async () => {throw new Error('配方已删除');};
  await saved(2);
  expect(document.body.textContent).toContain('配方已删除');
  expect(document.querySelector('h1')?.textContent).toBe('产品群待办');
  expect(button('在飞书继续创作').disabled).toBe(true);
  expect(button('删除未发布配方').disabled).toBe(true);
  await click('返回我的配方'); expect(back).toHaveBeenCalledOnce();
});

it('confirms deletion and retries the exact revision with the same operation identity after uncertain completion', async () => {
  let attempts = 0;
  send = async request => {
    if (request.type === 'draft') return draft;
    if (request.type === 'deleteDraft') {if (++attempts === 1) throw new Error('结果未知'); return {draftId, deleted: true};}
    throw new Error('Unexpected mutation');
  };
  await draw(); await click('删除未发布配方');
  expect(requests).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('来源群聊的配置和已发布版本会保留');
  await click('删除'); expect(back).not.toHaveBeenCalled();
  await click('删除'); expect(back).toHaveBeenCalledOnce();
  const deletes = requests.filter(request => request.type === 'deleteDraft');
  expect(deletes).toHaveLength(2); expect(deletes[1]).toEqual(deletes[0]);
  expect(deletes[0]).toMatchObject({accountId, draftId, revision: 1});
});

it('invalidates a delete confirmation immediately when chat saves a newer revision', async () => {
  await draw(); await click('删除未发布配方');
  const oldDelete = button('删除');
  draft = richDraft(2);
  await act(async () => {emit({type: 'authoringSaved', value: {accountId, draftId, revision: 2}}); oldDelete.click();});
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(requests.filter(request => request.type === 'deleteDraft')).toEqual([]);
  await click('删除未发布配方'); await click('保留配方');
  expect(requests.filter(request => request.type === 'deleteDraft')).toEqual([]);
});

it('ignores stale reads after an account change and does not show another account private work', async () => {
  let finish!: (result: unknown) => void;
  send = () => new Promise(resolve => {finish = resolve;});
  await draw();
  const stale = finish;
  draft = richDraft(2, {name: '新账号作品'}); send = async () => draft;
  await draw(otherAccount);
  await act(async () => stale(richDraft(1, {name: '旧账号私密内容'})));
  expect(document.querySelector('h1')?.textContent).toBe('新账号作品');
  expect(document.body.textContent).not.toContain('旧账号私密内容');
});

it('prepares exactly the displayed content and waits for a separate explicit publication confirmation', async () => {
  await draw();
  await click('发布到社区');
  expect(authoringRequests).toEqual([{type: 'preparePublication', accountId, draft}]);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('产品群待办');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('所有人都可以查看完整内容');
  await click('继续检查');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(authoringRequests.every(request => request.type !== 'confirmPublication')).toBe(true);
  expect(requests.every(request => request.type === 'draft')).toBe(true);
});

it('keeps the original displayed draft while recovering an uncertain publication', async () => {
  const receipt = {accountId, draftId, recipeId: accountId, versionId: otherAccount, revision: 1};
  let attempts = 0;
  const prepared = authoringSend;
  authoringSend = async request => {
    if (request.type === 'confirmPublication') {attempts++; return {kind: 'publicationResult', result: {kind: 'pending'}};}
    if (attempts) return {kind: 'publicationRecovery', result: {kind: 'published', publication: receipt}};
    return prepared(request);
  };
  await draw(); await click('发布到社区'); await click('确认发布');
  expect(document.body.textContent).toContain('正在核对发布结果');
  expect(button('发布到社区').disabled).toBe(true);
  expect(button('在飞书继续创作').disabled).toBe(true);
  await click('核对发布结果');
  expect(document.body.textContent).toContain('已发布到社区');
  expect(authoringRequests.filter(request => request.type === 'confirmPublication')).toEqual([
    {type: 'confirmPublication', accountId, reviewId: otherAccount},
  ]);
  expect(authoringRequests.filter(request => request.type === 'preparePublication')).toEqual([
    {type: 'preparePublication', accountId, draft},
  ]);
  expect(requests.filter(request => request.type === 'publishDraft')).toEqual([]);
});

it('discards a confirmation and a delayed preparation when chat saves a newer revision', async () => {
  await draw(); await click('发布到社区');
  draft = richDraft(2); await saved(2);
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(authoringRequests.filter(request => request.type === 'confirmPublication')).toEqual([]);
  let ready!: (reply: unknown) => void;
  authoringSend = () => new Promise(resolve => {ready = resolve;});
  const starting = draft;
  await click('发布到社区');
  draft = richDraft(3); await saved(3);
  await act(async () => ready({kind: 'publicationReady', reviewId: otherAccount, draftId, revision: 2, public: starting.public}));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(document.body.textContent).toContain('配方内容已变化');
});

it('does not show a preparation from the previous account and warns when a preview link names an older revision', async () => {
  let ready!: (reply: unknown) => void;
  authoringSend = () => new Promise(resolve => {ready = resolve;});
  await draw(accountId, 1);
  await click('发布到社区');
  const starting = draft;
  draft = richDraft(3, {name: '新账号作品'});
  await draw(otherAccount, 1);
  await act(async () => ready({kind: 'publicationReady', reviewId: otherAccount, draftId, revision: 1, public: starting.public}));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(document.body.textContent).toContain('链接指向修订 1，这里展示当前修订 3');
  expect(authoringRequests.filter(request => request.type === 'confirmPublication')).toEqual([]);
});

it('does not treat a different draft publication receipt as success', async () => {
  const prepared = authoringSend;
  authoringSend = async request => request.type !== 'confirmPublication' ? prepared(request) :
    {kind: 'publicationResult', result: {kind: 'published', publication: {accountId, draftId: otherAccount, recipeId: accountId, versionId: otherAccount, revision: 1}}};
  await draw(); await click('发布到社区'); await click('确认发布');
  expect(document.body.textContent).toContain('发布回执与这份配方不一致');
  expect(document.body.textContent).not.toContain('已发布到社区');
});

it('refuses a read older than the linked revision and provides an in-place fresh read after stale preparation', async () => {
  await draw(accountId, 2);
  expect(document.querySelector('h1')).toBeNull();
  expect(document.body.textContent).toContain('尚未读取到最新内容');
  draft = richDraft(2); await click('重新读取');
  authoringSend = async () => {throw new Error('内容已在其他地方变更');};
  await click('发布到社区');
  draft = richDraft(3, {name: '其他设备的新内容'}); await click('重新读取');
  expect(document.querySelector('h1')?.textContent).toBe('其他设备的新内容');
  expect(requests.filter(request => request.type === 'draft')).toHaveLength(3);
  expect(authoringRequests.filter(request => request.type === 'confirmPublication')).toEqual([]);
});

it('offers a fresh read when an invalidated confirmation has no dispatched publication', async () => {
  const prepared = authoringSend;
  authoringSend = async request => request.type === 'confirmPublication' ? Promise.reject(new Error('确认已过期')) : prepared(request);
  await draw(); await click('发布到社区'); await click('确认发布');
  const original = draft;
  draft = richDraft(2); await saved(2);
  await click('核对发布结果');
  expect(authoringRequests.filter(request => request.type === 'confirmPublication')).toHaveLength(1);
  expect(authoringRequests.filter(request => request.type === 'preparePublication')).toEqual([
    {type: 'preparePublication', accountId, draft: original},
  ]);
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(document.body.textContent).toContain('未找到已提交的发布请求');
  expect(authoringRequests.at(-1)).toEqual({type: 'recoverPublication', accountId, draftId});
});


it('cold remount recovers a retired draft by account/draft only and opens the exact published version', async () => {
  const receipt = {accountId, draftId, recipeId: accountId, versionId: otherAccount, revision: 1};
  const prepared = authoringSend;
  let retired = false, available = false;
  authoringSend = async request => {
    if (request.type === 'confirmPublication') {retired = true; throw new Error('response lost');}
    if (request.type === 'recoverPublication') return {kind: 'publicationRecovery', result: available ? {kind: 'published', publication: receipt} : {kind: 'pending'}};
    return prepared(request);
  };
  send = async () => {if (retired) throw new Error('not_found'); return draft;};
  await draw(); await click('发布到社区'); await click('确认发布');
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root')!);
  authoringRequests = [];
  await draw();
  expect(document.querySelector('h1')).toBeNull();
  expect(document.body.textContent).toContain('正在核对发布结果');
  expect(published).not.toHaveBeenCalled();
  available = true; await click('核对发布结果');
  expect(published).toHaveBeenCalledExactlyOnceWith(receipt);
  expect(authoringRequests).toEqual([{type: 'recoverPublication', accountId, draftId}, {type: 'recoverPublication', accountId, draftId}]);
  expect(requests.filter(request => request.type === 'publishDraft')).toEqual([]);
});

it.each(['account', 'draft'] as const)('cold recovery rejects a receipt for another %s', async mismatch => {
  send = async () => {throw new Error('not_found');};
  authoringSend = async () => ({kind: 'publicationRecovery', result: {kind: 'published', publication: {accountId: mismatch === 'account' ? otherAccount : accountId,
    draftId: mismatch === 'draft' ? otherAccount : draftId, recipeId: accountId, versionId: otherAccount, revision: 1}}});
  await draw();
  expect(document.body.textContent).toContain('发布回执与这份配方不一致');
  expect(document.body.textContent).not.toContain('已发布到社区');
  expect(published).not.toHaveBeenCalled();
});

it('cold recovery leaves an absent publication as a normal read failure and ignores a late receipt after account change', async () => {
  send = async () => {throw new Error('not_found');};
  await draw();
  expect(document.body.textContent).toContain('配方尚未更新');
  expect(document.body.textContent).not.toContain('正在核对发布结果');
  let finish!: (reply: unknown) => void;
  authoringSend = () => new Promise(resolve => {finish = resolve;});
  await click('重新读取');
  const stale = finish;
  send = async () => richDraft(2, {name: '新账号作品'});
  await draw(otherAccount);
  await act(async () => stale({kind: 'publicationRecovery', result: {kind: 'published', publication: {accountId, draftId, recipeId: accountId, versionId: otherAccount, revision: 1}}}));
  expect(published).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('新账号作品');
});
