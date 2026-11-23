// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {canonicalizeRichRecipeContent, communityRequestSchema, recipeRichDraftSchema, type CommunityRequest, type RecipeDraft, type RecipeRichDraft} from '@vonvon/protocol';
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
let facade: ReturnType<typeof createDesktopFacades>;
let emit: (value: unknown) => void;
let back: ReturnType<typeof vi.fn>;
const resume = vi.fn();
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
async function draw(account = accountId) {
  await act(async () => {
    emit({type: 'account', value: {kind: 'signedIn', accountId: account, displayName: '作者', provider: 'github', persistence: 'memory'}});
    root.render(<ClientProvider client={facade.client} shell={facade.shell}><RecipeDraftPage shell={facade.shell.community!} accountId={account} draftId={draftId} onBack={back} onContinueInChat={resume}/></ClientProvider>);
  });
}
async function saved(revision: number, account = accountId, id = draftId) {await act(async () => emit({type: 'authoringSaved', value: {accountId: account, draftId: id, revision}}));}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById('root')!);
  draft = richDraft(); requests = []; back = vi.fn(); resume.mockReset();
  send = async request => {if (request.type === 'draft') return draft; throw new Error('Unexpected request ' + request.type);};
  facade = createDesktopFacades({receive: listener => {emit = listener; return () => {};}, invoke: async (channel, ...args) => {
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
  expect(document.body.textContent).not.toMatch(/编辑发布信息|预览发布|发布到社区/);
  expect([...document.querySelectorAll('[aria-label="配方详细信息"] button')].map(node => node.textContent)).toEqual(['概览', '模型与权限', '能力', '沟通方式', '任务']);
  for (const section of ['概览', '模型与权限', '能力', '沟通方式', '任务']) {
    await click(section);
    expect(document.body.textContent).not.toContain('PRIVATE_MEMORY_NEVER_DISPLAY');
  }
  await click('能力'); expect(document.body.textContent).toContain('SETUP_SKILL_BODY');
  await click('沟通方式'); expect(document.body.textContent).toContain('语音回复');
  await click('在飞书继续创作'); expect(resume).toHaveBeenCalledWith(draft);
  expect(requests).toEqual([{type: 'draft', accountId, draftId}]);
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
  draft = richDraft(2); await saved(2);
  await act(async () => button('删除').click());
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
