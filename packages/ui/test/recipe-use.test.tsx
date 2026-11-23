// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {
  agentIdSchema, groupIdSchema, desktopSnapshotSchema, recipeUseRequestSchema, desktopRecipeSourceRequestSchema,
  communityRequestSchema, communityResponseSchemas, collaborationRequestSchema, commandSchema,
  type AccountStatus, type AccountShell, type RecipeUseRequest, type RecipeUseReply, type DesktopRecipeSourceRequest,
  type DesktopRecipeSourceReply, type CommunityRequest, type ProjectSettingsView, type RecipeDetail,
} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {DesktopRootView} from '../src/devices/DesktopRoot';
import {useCommunity} from '../src/community/community-context';
import {RecipeSourcePanel} from '../src/recipes/RecipeSourcePanel';
import {RecipeUseDialog} from '../src/recipes/RecipeUseDialog';
import {SettingValue} from '../src/community/RichConfiguration';
import {useRecipeUse} from '../src/recipes/recipe-use-context';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {A, B, devicesState, fakeShell, newClient} from './devices-fixture';

const accountId = '44444444-4444-4444-8444-444444444444';
const otherAccount = '99999999-9999-4999-8999-999999999999';
const recipeId = '55555555-5555-4555-8555-555555555555';
const versionId = '66666666-6666-4666-8666-666666666666';
const nextVersion = '77777777-7777-4777-8777-777777777777';
const futureVersion = '88888888-8888-4888-8888-888888888888';
const handle = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const botId = agentIdSchema.parse('cli_recipe_ui');
const groupId = groupIdSchema.parse('oc_recipe_ui');
const token = 'a'.repeat(64), newToken = 'b'.repeat(64);
const name = '多语言配方🦉和很长的名字'.repeat(5);
const setup = {steps: [{kind: 'config' as const, title: '准备账号', instructions: '阅读并手动准备，不自动执行。', required: true}]};
const detail = {recipeId, versionId, revision: 1, public: {name, summary: '帮助 Bot 协作', overview: '说明', version: '1.0', access: 'direct' as const}, config: {role: '新职责', setup}, owned: false, acquired: true};
const baseReview = {reviewToken: token, currentRole: '当前职责', baseRole: '上次职责', incomingRole: '新职责', roleChoiceRequired: false, setupChoiceRequired: false};
const snapshot = desktopSnapshotSchema.parse({revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents: [{id: botId, name: '原目标🦉机器人', enabled: true, running: true, connection: 'connected', activation: 'active'}], groups: [{id: groupId, name: '已连接的群'}], memberships: [],
  tools: [{tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '1'}], jobs: [], application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/synthetic'}});

let root: Root;
let shell: ReturnType<typeof fakeShell>;
let client: ReturnType<typeof newClient>;
let requests: RecipeUseRequest[];
let sourceRequests: DesktopRecipeSourceRequest[];
let communityRequests: CommunityRequest[];
let status: AccountStatus;
let accountListener: ((status: AccountStatus) => void) | undefined;
let useReply: (request: RecipeUseRequest) => RecipeUseReply | Promise<RecipeUseReply>;
let sourceReply: (request: DesktopRecipeSourceRequest) => DesktopRecipeSourceReply | Promise<DesktopRecipeSourceReply>;
let acquired: boolean;
let detailRead: (() => Promise<RecipeDetail>) | undefined;

function Launcher() {
  const community = useCommunity()!;
  const recipeUse = useRecipeUse()!;
  return <><button onClick={() => community.open({kind: 'detail', recipe: detail})}>打开配方</button>
    <button onClick={() => recipeUse.start(detail, {botId, groupId})}>预览已知群</button>
    <RecipeSourcePanel view={{scope: {botId}, identity: {chatId: groupId}} as ProjectSettingsView}/></>;
}
async function draw(deviceId = A, phase: 'ready' | 'failed' = 'ready') {
  await act(async () => root.render(<DesktopRootView state={devicesState({id: deviceId, phase})} fallback={client} shell={shell} renderApp={() => <DraftGuardProvider><Launcher/></DraftGuardProvider>}/>));
}
function button(text: string) {return [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text)!;}
async function click(text: string) {expect(button(text), text).toBeDefined(); await act(async () => button(text).click());}
async function fill(label: string, value: string) {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  expect(element, label).not.toBeNull();
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', {bubbles: true}));});
}
async function pick(selector: string) {const element = document.querySelector<HTMLInputElement>(selector)!; expect(element, selector).not.toBeNull(); await act(async () => element.click());}
async function openUse() {await click('打开配方'); await click(acquired ? '添加到群聊' : '获取配方'); await pick('input[name="join-bot"]'); await click('下一步');}
async function createGroup() {
  await fill('飞书群名称', 'Unicode 群🦉研发');
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(element => element.textContent?.startsWith('独立话题'))!;
  await act(async () => option.click());
  await click('创建并连接');
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('IntersectionObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener() {}, removeEventListener() {}}));
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  requests = []; sourceRequests = []; communityRequests = []; acquired = true; detailRead = undefined;
  status = {kind: 'signedIn', accountId, displayName: 'Synthetic', provider: 'github', persistence: 'memory'};
  const account: AccountShell = {status: async () => status, onStatus: listener => {accountListener = listener; listener(status); return () => {};}, login: async () => status, cancelLogin: async () => status, logout: async () => ({kind: 'signedOut'})};
  useReply = request => request.type === 'begin' ? {kind: 'choose', handle} : request.type === 'join' || request.type === 'retry' ? {kind: 'prepared', handle, groupId, review: baseReview} : request.type === 'confirm' || request.type === 'resume' ? {kind: 'applied', handle, groupId} : {kind: 'closed'};
  sourceReply = () => ({source: null});
  const facade = createDesktopFacades({receive: () => () => {}, invoke: async (channel, raw) => {
    if (channel === desktopChannels.recipeUse) {const request = recipeUseRequestSchema.parse(raw); requests.push(request); return {ok: true, value: await useReply(request)};}
    if (channel === desktopChannels.recipeSource) {const request = desktopRecipeSourceRequestSchema.parse(raw); sourceRequests.push(request); return {ok: true, value: await sourceReply(request)};}
    if (channel === desktopChannels.community) {
      const request = communityRequestSchema.parse(raw); communityRequests.push(request);
      const result = request.type === 'detail' ? {...(detailRead ? await detailRead() : detail), versionId: request.versionId, acquired}
        : request.type === 'shareLink' ? {url: 'https://example.invalid/recipe'}
        : request.type === 'acquire' ? (acquired = true, {recipeId, versionId: request.versionId, owned: false, acquired: true})
        : request.type === 'catalog' ? {hero: detail, items: [], nextCursor: null} : {items: []};
      return {ok: true, value: communityResponseSchemas[request.type].parse(result)};
    }
    throw new Error('Unexpected synthetic IPC channel');
  }});
  client = Object.assign(newClient(), {
    watchSnapshots: (listener: (value: typeof snapshot) => void) => {listener(snapshot); return () => {};},
    snapshot: async () => snapshot,
    environment: async () => ({kind: 'backends', entries: [{id: 'codex-appserver', displayName: 'Codex'}]}),
    settings: async () => ({kind: 'refused', message: '合成测试未配置默认决策模型。'}),
    run: vi.fn(async raw => {const command = commandSchema.parse(raw); return command.type === 'readGroupIdentity' ? {kind: 'groupIdentity', agentId: command.agentId, groupId: command.groupId, name: '已连接的群'} : command.type === 'listPendingGroups' ? {kind: 'pendingGroups', groups: []} : command.type === 'listJoinedGroups' ? {kind: 'groups', groups: [{id: groupId, name: '已连接的群', bound: true}, {id: 'oc_unbound', name: '待连接群', bound: false}]} : {kind: 'applied'};}),
    collaboration: vi.fn(async raw => {collaborationRequestSchema.parse(raw); return {kind: 'applied', project: {chatId: groupId}};}),
  });
  shell = fakeShell(); shell.devices.clientFor.mockImplementation(() => client);
  Object.assign(shell, {account, recipeUse: facade.shell.recipeUse, recipeSource: facade.shell.recipeSource, community: facade.shell.community});
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});

it('acquires into the real original join form, preserves its guards, and only reports confirmed native success', async () => {
  acquired = false; await draw(); await openUse();
  expect(communityRequests.some(request => request.type === 'acquire')).toBe(true);
  expect(document.body.textContent).toContain(name);
  expect(button('创建并连接').disabled).toBe(true);
  await fill('飞书群名称', 'a/b');
  expect(document.body.textContent).toContain('名称里不能有');
  expect(button('创建并连接').disabled).toBe(true);
  await createGroup();
  const join = requests.find(request => request.type === 'join');
  expect(join).toEqual({type: 'join', handle, input: {action: 'createProject', agentId: botId, name: 'Unicode 群🦉研发', folder: {kind: 'default'}, tool: 'codex', conversation: 'threads'}});
  expect(client.collaboration).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('配方已应用');
  expect(document.querySelector('[aria-label="使用准备对比"]')).toBeNull();
  await click('确认应用到这个群');
  expect(document.body.textContent).toContain('已应用到目标群，云端已确认');
  expect(document.body.textContent).not.toContain('使用设置');
  expect(document.body.textContent).not.toContain('任务保持暂停');
  expect(requests.filter(request => request.type === 'confirm')).toEqual([{type: 'confirm', handle}]);
  await click('稍后继续'); expect(requests.some(request => request.type === 'finish')).toBe(false);
  await click('添加到群聊'); await click('完成');
  expect(requests.at(-1)).toEqual({type: 'finish', handle});
});

it('reuses the existing-group flow for bind inputs and offers bound groups without discarding existing settings', async () => {
  await draw(); await openUse(); await click('连接已有群聊'); await click('查找已经加入的群');
  const bound = [...document.querySelectorAll<HTMLButtonElement>('.join-group-list button')].find(element => element.textContent?.startsWith('已连接的群'))!;
  expect(bound.disabled).toBe(false);
  await act(async () => bound.click());
  expect(requests.at(-1)).toEqual({type: 'begin', accountId, viewId: A, recipeId, versionId, botId, groupId});
  expect(requests.some(request => request.type === 'join')).toBe(false);
});

it('sends original bind settings through the native handle rather than directly binding in the renderer', async () => {
  await draw(); await openUse(); await click('连接已有群聊'); await click('查找已经加入的群');
  const unbound = [...document.querySelectorAll<HTMLButtonElement>('.join-group-list button')].find(element => element.textContent?.startsWith('待连接群'))!;
  await act(async () => unbound.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(element => element.textContent?.startsWith('独立话题'))!;
  await act(async () => option.click()); await click('连接并发送欢迎卡片');
  expect(requests.find(request => request.type === 'join')).toEqual({type: 'join', handle, input: {type: 'bindGroup', agentId: botId, groupId: 'oc_unbound', projectName: '待连接群', folder: {kind: 'default'}, tool: 'codex', conversation: 'threads'}});
  expect(client.run.mock.calls.some(([request]) => request.type === 'bindGroup')).toBe(false);
});

it('requires fresh token-bound choices after a changed review, including Unicode length without a setup choice', async () => {
  let resolves = 0;
  useReply = request => request.type === 'begin' ? {kind: 'choose', handle}
    : request.type === 'join' ? {kind: 'review', handle, groupId, review: {...baseReview, roleChoiceRequired: true, setupChoiceRequired: false}}
    : request.type === 'resolve' && resolves++ === 0 ? {kind: 'review', handle, groupId, review: {...baseReview, reviewToken: newToken, currentRole: '另一人刚修改', roleChoiceRequired: true, setupChoiceRequired: false}}
    : {kind: 'prepared', handle, groupId, review: {...baseReview, reviewToken: newToken}};
  await draw(); await openUse(); await createGroup();
  expect(button('预览所选内容').disabled).toBe(true);
  expect(document.body.textContent).toContain('上次职责');
  expect(document.querySelector('input[name="recipe-setup"]')).toBeNull();
  await pick('input[name="recipe-role"][value="custom"]'); await fill('合并后的本群角色', '🦉'.repeat(5001));
  expect(document.body.textContent).toContain('本群角色最多 5000 字');
  await fill('合并后的本群角色', '🦉'.repeat(5000));
  await click('预览所选内容');
  expect(requests.at(-1)).toEqual({type: 'resolve', handle, reviewToken: token, resolution: {role: {kind: 'custom', text: '🦉'.repeat(5000)}}});
  expect(button('预览所选内容').disabled).toBe(true);
  expect(document.querySelectorAll('input[name="recipe-role"]:checked')).toHaveLength(0);
  expect(document.body.textContent).toContain('另一人刚修改');
  await pick('input[name="recipe-role"][value="replace"]'); await click('预览所选内容');
  expect(requests.at(-1)).toEqual({type: 'resolve', handle, reviewToken: newToken, resolution: {role: {kind: 'replace'}}});
  expect(button('确认应用到这个群')).toBeDefined();
});

it.each(['review','prepared'] as const)('requires a target update instead of confirming an old %s setup installation',async kind=>{
  useReply=()=>({kind,handle,groupId,review:{...baseReview,incomingSetup:setup,setupChoiceRequired:kind==='review'}});
  await draw();await openUse();
  expect(document.body.textContent).toContain('请更新目标设备');
  expect(document.querySelector('[aria-label="使用准备对比"]')).toBeNull();
  expect(document.querySelector('input[name="recipe-setup"]')).toBeNull();
  expect(button('确认应用到这个群')).toBeUndefined();
  expect(button('预览所选内容')).toBeUndefined();
  expect(requests.some(request=>request.type==='resolve'||request.type==='confirm')).toBe(false);
});

it('keeps the original handle after uncertain join, and cancellation that lost to commit stays pending', async () => {
  useReply = request => request.type === 'begin' ? {kind: 'choose', handle} : request.type === 'join' ? {kind: 'pending', handle, phase: 'joining'}
    : request.type === 'cancel' ? {kind: 'pending', handle, phase: 'installing', groupId}
    : {kind: 'applied', handle, groupId};
  await draw(); await openUse(); await createGroup();
  expect(document.body.textContent).toContain('群聊可能已经创建或连接');
  await click('取消应用'); expect(document.body.textContent).not.toContain('已取消');
  expect(document.body.textContent).not.toContain('配方已应用');
  await click('核对进度');
  expect(requests.filter(request => request.type === 'join')).toHaveLength(1);
  expect(requests.at(-1)).toEqual({type: 'resume', handle});
  expect(document.body.textContent).toContain('配方已应用');
});

it('hides private comparisons on account switch and pauses device switches until original-target recovery', async () => {
  useReply = () => ({kind: 'prepared', handle, groupId, review: baseReview});
  await draw(); await openUse();
  expect(document.body.textContent).toContain('当前职责');
  await act(async () => accountListener!({...status as Extract<AccountStatus, {kind: 'signedIn'}>, accountId: otherAccount}));
  expect(document.body.textContent).not.toContain('当前职责'); expect(document.body.textContent).toContain('发起操作时的账号');
  expect(document.querySelector('.recipe-use-name')).toBeNull();
  expect(button('确认应用到这个群')).toBeUndefined();
  await act(async () => accountListener!(status));
  expect(document.body.textContent).not.toContain('当前职责');
  await click('恢复原操作');
  await draw(B); expect(document.body.textContent).toContain('请切回「机房」'); expect(button('确认应用到这个群')).toBeUndefined();
  await draw(A); await click('恢复原操作');
  expect(requests.every(request => request.type !== 'begin' || request.viewId === A && request.accountId === accountId)).toBe(true);
  expect(requests.some(request => request.type === 'confirm')).toBe(false);
});

it('recovers expired or lost responses without another join and rejects malformed success at the actual preload boundary', async () => {
  let began = 0;
  useReply = request => request.type === 'begin' && began++ === 0 ? {kind: 'choose', handle}
    : request.type === 'join' ? Promise.reject(new Error('原操作需要重新核对。'))
    : request.type === 'begin' ? {kind: 'prepared', handle, groupId, review: baseReview}
    : {kind: 'applied', handle, groupId, ticket: 'must-not-cross'} as RecipeUseReply;
  await draw(); await openUse(); await createGroup(); await click('恢复原操作');
  expect(requests.filter(request => request.type === 'join')).toHaveLength(1);
  expect(requests.filter(request => request.type === 'begin')).toHaveLength(2);
  await click('确认应用到这个群'); expect(document.body.textContent).not.toContain('配方已应用');
  expect(button('恢复原操作')).toBeDefined();
});

it('checks and ignores the exact next version, still notices later versions, and previews an update in the same group', async () => {
  let ignored = false;
  const source = {recipeId, versionId, revision: 1, authorId: accountId, installedAt: 1, sourceToken: token, setup};
  sourceReply = request => request.type === 'read' ? {source}
    : request.type === 'ignore' ? (ignored = true, {source: {...source, ignoredVersionId: nextVersion}})
    : {source, latest: {recipeId, versionId: ignored ? futureVersion : nextVersion, revision: ignored ? 3 : 2, version: ignored ? '3.0' : '2.0', entitled: true}};
  useReply = () => ({kind: 'prepared', handle, groupId, review: baseReview});
  await draw(); expect(document.body.textContent).toContain('当前配方 · 第 1 版');
  await click('检查新版'); await click('忽略此版本');
  expect(sourceRequests.at(-1)).toEqual({type: 'ignore', viewId: A, botId, groupId, accountId, sourceToken: token, installedVersionId: versionId, versionId: nextVersion});
  expect(document.body.textContent).not.toContain('有新版本');
  await click('检查新版'); expect(document.body.textContent).toContain('有新版本 · 3.0'); await click('预览更新');
  expect(requests.at(-1)).toEqual({type: 'begin', accountId, viewId: A, botId, groupId, recipeId, versionId: futureVersion});
  expect(document.body.textContent).toContain('沿用现有群聊的 Provider、工作目录和沟通方式');
});

it('deduplicates repeated submits and preserves the original form when a refusal needs recovery', async () => {
  let refuse: ((reason: Error) => void) | undefined;
  useReply = request => request.type === 'join' ? new Promise<RecipeUseReply>((_resolve, reject) => {refuse = reject;}) : {kind: 'choose', handle};
  await draw(); await openUse();
  await fill('飞书群名称', '保留这个名字🦉');
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(element => element.textContent?.startsWith('独立话题'))!;
  await act(async () => option.click());
  const submit = button('创建并连接');
  await act(async () => {submit.click(); submit.click();});
  expect(requests.filter(request => request.type === 'join')).toHaveLength(1);
  await act(async () => refuse!(new Error('名称冲突，请核对后修改。')));
  await click('恢复原操作');
  expect(document.querySelector<HTMLInputElement>('[aria-label="飞书群名称"]')?.value).toBe('保留这个名字🦉');
  expect(button('创建并连接').disabled).toBe(false);
});

it('retries a rejected operation in its known group without another join', async () => {
  useReply = request => request.type === 'begin' ? {kind: 'choose', handle}
    : request.type === 'join' ? {kind: 'rejected', handle, groupId, reason: '本次授权已过期。'}
    : request.type === 'retry' ? {kind: 'prepared', handle, groupId, review: baseReview}
    : {kind: 'applied', handle, groupId};
  await draw(); await openUse(); await createGroup();
  expect(document.body.textContent).toContain('群聊已保留');
  await click('在这个群重新预览');
  expect(requests.at(-1)).toEqual({type: 'retry', handle});
  expect(requests.filter(request => request.type === 'join')).toHaveLength(1);
  expect(button('确认应用到这个群')).toBeDefined();
});

it('acquires a newer version before starting the native update on its original bound group', async () => {
  acquired = false;
  const source = {recipeId, versionId, revision: 1, authorId: accountId, installedAt: 1, sourceToken: token};
  sourceReply = request => request.type === 'read' ? {source} : {source, latest: {recipeId, versionId: nextVersion, revision: 2, version: '2.0', entitled: false}};
  useReply = () => ({kind: 'prepared', handle, groupId, review: baseReview});
  await draw(); await click('检查新版'); await click('获取新版');
  expect(requests).toHaveLength(0);
  await click('获取配方');
  expect(requests.at(-1)).toEqual({type: 'begin', accountId, viewId: A, recipeId, versionId: nextVersion, botId, groupId});
  expect(document.querySelector('input[name="join-bot"]')).toBeNull();
});

it('does not revive an old account update result while allowing the new account source read', async () => {
  let release: ((reply: DesktopRecipeSourceReply) => void) | undefined;
  const source = {recipeId, versionId, revision: 1, authorId: accountId, installedAt: 1, sourceToken: token};
  sourceReply = request => request.type === 'check' ? new Promise<DesktopRecipeSourceReply>(resolve => {release = resolve;}) : {source};
  await draw(); await click('检查新版');
  await act(async () => accountListener!({...status as Extract<AccountStatus, {kind: 'signedIn'}>, accountId: otherAccount}));
  expect(sourceRequests.at(-1)).toEqual({type: 'read', viewId: A, botId, groupId});
  await act(async () => release!({source, latest: {recipeId, versionId: nextVersion, revision: 2, version: '旧账号专属新版', entitled: true}}));
  expect(document.body.textContent).not.toContain('旧账号专属新版');
  expect(button('检查新版').disabled).toBe(false);
});

it('invalidates an in-flight source read when a confirmed operation is acknowledged', async () => {
  let release: ((reply: DesktopRecipeSourceReply) => void) | undefined;
  let reads = 0;
  const source = {recipeId, versionId, revision: 1, authorId: accountId, installedAt: 1, sourceToken: token};
  sourceReply = () => reads++ < 2 ? new Promise<DesktopRecipeSourceReply>(resolve => {release = resolve;}) : {source: {...source, versionId: nextVersion, revision: 2}};
  useReply = request => request.type === 'finish' ? {kind: 'closed'} : {kind: 'applied', handle, groupId};
  await draw(); const before = reads; await click('预览已知群'); await click('完成');
  expect(reads).toBe(before + 1);
  expect(document.body.textContent).toContain('当前配方 · 第 2 版');
  await act(async () => release!({source}));
  expect(document.body.textContent).toContain('当前配方 · 第 2 版');
  expect(document.body.textContent).not.toContain('当前配方 · 第 1 版');
});

it('distinguishes closing the original form from explicitly cancelling an unstarted application', async () => {
  await draw(); await openUse();
  const close = document.querySelector<HTMLButtonElement>('.ui-dialog__header [aria-label="关闭"]')!;
  await act(async () => close.click());
  expect(requests.some(request => request.type === 'cancel')).toBe(false);
  await click('添加到群聊'); await click('取消');
  expect(requests.at(-1)).toEqual({type: 'cancel', handle});
});

it('pauses an offline original target and requires fresh recovery after reconnect', async () => {
  useReply = () => ({kind: 'prepared', handle, groupId, review: baseReview});
  await draw(); await openUse(); await draw(A, 'failed');
  expect(document.body.textContent).toContain('目标设备暂不可用');
  expect(button('确认应用到这个群')).toBeUndefined();
  await draw(); expect(button('恢复原操作')).toBeDefined(); await click('恢复原操作');
  expect(requests.filter(request => request.type === 'begin')).toHaveLength(2);
});

it('repairs a known created-unsaved group with the original bind form and never offers another creation', async () => {
  useReply = request => request.type === 'begin' ? {kind: 'choose', handle}
    : request.type === 'join' ? {kind: 'pending', handle, phase: 'joining', recovery: {state: 'createdUnsaved', groupId, name: '原群名称'}}
    : {kind: 'prepared', handle, groupId, review: baseReview};
  await draw(); await openUse(); await createGroup(); await click('连接已创建的群');
  expect(button('创建群聊')).toBeUndefined(); expect(button('创建并连接')).toBeUndefined();
  expect(document.querySelector<HTMLInputElement>('[aria-label="本地绑定名称"]')?.value).toBe('已连接的群');
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(element => element.textContent?.startsWith('独立话题'))!;
  await act(async () => option.click()); await click('连接并发送欢迎卡片');
  expect(requests.at(-1)).toEqual({type: 'repairJoin', handle, input: {type: 'bindGroup', agentId: botId, groupId, projectName: '已连接的群', folder: {kind: 'default'}, tool: 'codex', conversation: 'threads'}});
  expect(requests.filter(request => request.type === 'join')).toHaveLength(1);
});

it('requires an explicit existing physical group for unknown creation recovery, including already bound rows', async () => {
  useReply = request => request.type === 'begin' ? {kind: 'choose', handle}
    : request.type === 'join' ? {kind: 'pending', handle, phase: 'joining', recovery: {state: 'unknown'}}
    : {kind: 'prepared', handle, groupId, review: baseReview};
  await draw(); await openUse(); await createGroup(); await click('从已加入群中选择');
  expect(button('创建群聊')).toBeUndefined(); await click('查找已经加入的群');
  const bound = [...document.querySelectorAll<HTMLButtonElement>('.join-group-list button')].find(element => element.textContent?.startsWith('已连接的群'))!;
  await act(async () => bound.click());
  expect(requests.at(-1)).toEqual({type: 'repairJoin', handle, input: {type: 'existingBinding', agentId: botId, groupId}});
  expect(requests.filter(request => request.type === 'join')).toHaveLength(1);
});

it('only dismisses uncertain join tracking after the user confirms that no group is deleted or cancelled', async () => {
  useReply = request => request.type === 'begin' ? {kind: 'choose', handle}
    : request.type === 'dismissJoin' ? {kind: 'closed'} : {kind: 'pending', handle, phase: 'joining', recovery: {state: 'unknown'}};
  await draw(); await openUse(); await createGroup(); await click('结束本次跟踪');
  expect(requests.some(request => request.type === 'dismissJoin')).toBe(false);
  expect(document.body.textContent).toContain('结束跟踪不会删除群聊或改变现有连接');
  expect(document.body.textContent).toContain('不表示建群已取消');
  await click('确认结束跟踪'); expect(requests.at(-1)).toEqual({type: 'dismissJoin', handle});
  expect(document.body.textContent).not.toContain('配方已应用');
});

it('automatically prepares a conflict-free rich review once and shows actual version content before confirmation', async () => {
  useReply = request => request.type === 'richResolve' ? {kind: 'richPrepared', handle, groupId, reviewToken: token}
    : {kind: 'richReview', handle, groupId, reviewToken: token, conflicts: []};
  await draw(); await click('预览已知群');
  expect(requests.filter(request => request.type === 'richResolve')).toEqual([{type: 'richResolve', handle, reviewToken: token, choices: {}}]);
  expect(requests.some(request => request.type === 'confirm')).toBe(false);
  expect(document.body.textContent).toContain('配方内容');
  expect(document.body.textContent).not.toContain('完整配置已核对');
  expect(document.body.textContent).not.toContain(botId);
  expect(document.body.textContent).not.toContain(groupId);
  await click('能力'); expect(document.body.textContent).toContain('新职责');
  expect(button('确认应用到这个群').disabled).toBe(false);
});

it('does not repeatedly auto-prepare an unchanged rich review or continue while it is closed', async () => {
  useReply = () => ({kind: 'richReview', handle, groupId, reviewToken: token, conflicts: []});
  await draw(); await click('预览已知群'); await draw();
  expect(requests.filter(request => request.type === 'richResolve')).toHaveLength(1);
  await click('稍后继续'); await draw();
  expect(requests.filter(request => request.type === 'richResolve')).toHaveLength(1);
  expect(requests.some(request => request.type === 'confirm')).toBe(false);
});

it('keeps conflict decisions explicit and presents the retained local value beside recipe content', async () => {
  const itemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  useReply = request => request.type === 'richResolve' ? {kind: 'richPrepared', handle, groupId, reviewToken: token}
    : {kind: 'richReview', handle, groupId, reviewToken: token, conflicts: [{itemId, kind: '本群角色', base: null, local: '本群专属职责', incoming: '新职责'}]};
  await draw(); await click('预览已知群');
  expect(requests.some(request => request.type === 'richResolve')).toBe(false);
  expect(button('预览所选内容').disabled).toBe(true);
  await pick(`input[name="${itemId}"]`); await click('预览所选内容');
  expect(document.body.textContent).toContain('保留本群设置');
  expect(document.body.textContent).toContain('本群专属职责');
  expect(requests.at(-1)).toEqual({type: 'richResolve', handle, reviewToken: token, choices: {[itemId]: 'local'}});
  expect(requests.some(request => request.type === 'confirm')).toBe(false);
});

it('requires a compatible preview for legacy memory conflicts and recovers through cancellation and a fresh preview', async () => {
  useReply = request => request.type === 'cancel' ? {kind: 'rejected', handle, groupId}
    : request.type === 'retry' ? {kind: 'richReview', handle, groupId, reviewToken: newToken, conflicts: []}
    : request.type === 'richResolve' ? {kind: 'richPrepared', handle, groupId, reviewToken: newToken}
    : {kind: 'richReview', handle, groupId, reviewToken: token, conflicts: [
      {itemId: versionId, kind: 'memories', base: 'MEMORY_BASE_SENTINEL', local: 'MEMORY_LOCAL_SENTINEL', incoming: 'MEMORY_INCOMING_SENTINEL'},
      {itemId: nextVersion, kind: 'role', base: null, local: '本群角色', incoming: '新角色'},
    ]};
  await draw(); await click('预览已知群');
  expect(document.body.textContent).toContain('需要重新预览配方');
  expect(document.body.textContent).toContain('取消本次应用后重新预览');
  expect(document.body.textContent).not.toMatch(/MEMORY_(BASE|LOCAL|INCOMING)_SENTINEL/);
  expect(document.querySelector('fieldset')).toBeNull();
  expect(button('预览所选内容')).toBeUndefined();
  expect(button('确认应用到这个群')).toBeUndefined();
  expect(requests.some(request => request.type === 'richResolve' || request.type === 'confirm')).toBe(false);
  expect(communityRequests.some(request => request.type === 'detail')).toBe(false);
  await click('取消应用'); await click('在这个群重新预览');
  expect(requests.filter(request => request.type === 'richResolve')).toEqual([{type: 'richResolve', handle, reviewToken: newToken, choices: {}}]);
  expect(button('确认应用到这个群').disabled).toBe(false);
  expect(document.body.textContent).not.toContain('MEMORY_LOCAL_SENTINEL');
});

it.each(['richReview', 'richPrepared'] as const)('blocks %s with legacy retained memory before resolving or reading content', async kind => {
  const onRequest = vi.fn(async (_request: RecipeUseRequest) => {});
  const session = {id: 1, recipe: {recipeId, versionId, name: '配方', version: '1'}, accountId, device: {id: A, name: '设备', isRemote: true, mode: 'full' as const, capabilities: []}, client, botId};
  const reply = kind === 'richReview' ? {kind, handle, groupId, reviewToken: token, conflicts: []} : {kind, handle, groupId, reviewToken: token};
  await act(async () => root.render(<DesktopRootView state={devicesState({id: A, phase: 'ready'})} fallback={client} shell={shell} renderApp={() => <RecipeUseDialog session={session} visible reply={reply} busy={false} paused={false} accountChanged={false} unavailable={false} needsRecovery={false} groupId={groupId} groupName="群聊" community={shell.community} retainedSettings={[{kind: 'memories', base: 'RETAINED_BASE_SENTINEL', local: 'RETAINED_LOCAL_SENTINEL', incoming: 'RETAINED_INCOMING_SENTINEL'}]} onRefreshGroupName={() => {}} onSelectBot={() => {}} onSelectGroup={() => {}} onClose={() => {}} onRecover={() => {}} onRequest={onRequest}/>}/>));
  expect(document.body.textContent).toContain('需要重新预览配方');
  expect(document.body.textContent).not.toMatch(/RETAINED_(BASE|LOCAL|INCOMING)_SENTINEL/);
  expect(document.querySelector('.recipe-use-retained')).toBeNull();
  expect(button('确认应用到这个群')).toBeUndefined();
  expect(button('预览所选内容')).toBeUndefined();
  expect(onRequest).not.toHaveBeenCalled();
  expect(communityRequests.some(request => request.type === 'detail')).toBe(false);
  expect(button('取消应用').disabled).toBe(false);
});

it('shows a historical recipe preview with five tabs while keeping memory out of every panel', async () => {
  const {canonicalizeRichRecipeContent} = await import('@vonvon/protocol');
  const {readFileSync} = await import('node:fs');
  const {resolve} = await import('node:path');
  const content = JSON.parse(readFileSync(resolve(process.cwd(), '../protocol/test/fixtures/recipe-rich-v2.content.json'), 'utf8'));
  content.parts = []; delete content.finalLogo;
  content.memories = content.memories.map((memory: {itemId: string; originId: string}) => ({...memory, text: {kind: 'inline', value: 'USE_PREVIEW_MEMORY_SENTINEL'}}));
  const doc = canonicalizeRichRecipeContent(content);
  detailRead = async () => ({...detail, format: 'rich-v2', config: undefined, rich: {content: doc.content, texts: {}, canonical: Buffer.from(doc.canonicalUTF8).toString('base64url')}});
  useReply = () => ({kind: 'richPrepared', handle, groupId, reviewToken: token});
  await draw(); await click('预览已知群');
  expect(document.querySelectorAll('[aria-label="配方详细信息"] button')).toHaveLength(5);
  for (const label of ['概览', '模型与权限', '能力', '沟通方式', '任务']) {
    await click(label);
    expect(document.body.textContent).not.toContain('USE_PREVIEW_MEMORY_SENTINEL');
  }
  expect(document.querySelector('[aria-label="配方详细信息"]')?.textContent).not.toContain('记忆');
  expect(button('确认应用到这个群').disabled).toBe(false);
});

it('blocks confirmation when content cannot be read and retries the same fixed version', async () => {
  detailRead = async () => {throw new Error('offline');};
  useReply = () => ({kind: 'richPrepared', handle, groupId, reviewToken: token});
  await draw(); await click('预览已知群');
  expect(button('确认应用到这个群').disabled).toBe(true);
  expect(document.body.textContent).toContain('暂时无法读取配方内容');
  detailRead = async () => detail;
  await click('重新读取配方');
  expect(button('确认应用到这个群').disabled).toBe(false);
  expect(communityRequests.filter(request => request.type === 'detail')).toEqual([
    {type: 'detail', accountId, recipeId, versionId}, {type: 'detail', accountId, recipeId, versionId},
  ]);
});

it('discards private version content arriving after an account switch', async () => {
  let release: ((value: typeof detail) => void) | undefined;
  detailRead = () => new Promise(resolve => {release = resolve;});
  useReply = () => ({kind: 'richPrepared', handle, groupId, reviewToken: token});
  await draw(); await click('预览已知群');
  expect(button('确认应用到这个群').disabled).toBe(true);
  await act(async () => accountListener!({...status as Extract<AccountStatus, {kind: 'signedIn'}>, accountId: otherAccount}));
  await act(async () => release!({...detail, public: {...detail.public, overview: '旧账号私有内容'}}));
  expect(document.body.textContent).not.toContain('旧账号私有内容');
  expect(button('确认应用到这个群')).toBeUndefined();
  expect(requests.some(request => request.type === 'confirm')).toBe(false);
});


it('renders real conflict values without internal relationships or translating free text', async () => {
  const parent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const block = JSON.stringify({parentItemId: parent, id: 'context', kind: 'context', name: 'constructor', template: 'default', mystery: parent});
  const setting = JSON.stringify({field: 'presentation.cardDisplay', value: {version: 1, blocks: [parent], reply: {streamText: true}}});
  useReply = () => ({kind: 'richReview', handle, groupId, reviewToken: token, conflicts: [
    {itemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: 'cardBlock', base: null, local: block, incoming: null},
    {itemId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'role', base: null, local: JSON.stringify({text: 'default'}), incoming: JSON.stringify({text: 'prototype'})},
    {itemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 'settings', base: null, local: setting, incoming: setting},
  ]});
  await draw(); await click('预览已知群');
  const fields = [...document.querySelectorAll('fieldset')].map(element => element.textContent);
  expect(fields[0]).toContain('constructor');
  expect(fields[0]).toContain('default');
  expect(fields[0]).toContain('移除此项');
  expect(fields[1]).toContain('default');
  expect(fields[1]).toContain('prototype');
  expect(document.body.textContent).not.toContain(parent);
  expect(document.body.textContent).not.toContain('parentItemId');
  expect(document.body.textContent).not.toContain('mystery');
});

it('reuses successful fixed-version details when group-name verification temporarily becomes busy', async () => {
  let notify: ((value: typeof snapshot) => void) | undefined;
  client.watchSnapshots = listener => {notify = listener; listener(snapshot); return () => {};};
  useReply = () => ({kind: 'richPrepared', handle, groupId, reviewToken: token});
  await draw(); await click('预览已知群');
  expect(button('确认应用到这个群').disabled).toBe(false);
  detailRead = async () => {throw new Error('offline');};
  await act(async () => notify!({...snapshot, agents: snapshot.agents.map(agent => ({...agent, running: false}))}));
  expect(communityRequests.filter(request => request.type === 'detail')).toHaveLength(1);
  expect(button('确认应用到这个群').disabled).toBe(false);
  expect(document.body.textContent).toContain('以下是配方原文。本次冲突中选择保留的内容列在下方；未变更的项目可能沿用本群现有设置。');
  expect(requests.some(request => request.type === 'confirm')).toBe(false);
});

it('keeps generic enum display compatible without reading inherited dictionary properties', async () => {
  await act(async () => root.render(<><SettingValue value="default"/><SettingValue value="constructor"/><SettingValue value="prototype"/><SettingValue value={{constructor: 'prototype', text: 'default'}}/></>));
  expect(document.body.textContent).toContain('默认');
  expect(document.body.textContent).toContain('constructor');
  expect(document.body.textContent).toContain('prototype');
  expect(document.body.textContent).toContain('default');
});

it.each(['account', 'recipe', 'version', 'handle', 'token'] as const)('does not reuse content after the %s scope changes', async change => {
  const session = {id: 1, recipe: {recipeId, versionId, name: '配方', version: '1'}, accountId, device: {id: A, name: '设备', isRemote: true, mode: 'full' as const, capabilities: []}, client, botId};
  const reply = {kind: 'richPrepared' as const, handle, groupId, reviewToken: token};
  async function render() {
    await act(async () => root.render(<DesktopRootView state={devicesState({id: A, phase: 'ready'})} fallback={client} shell={shell} renderApp={() => <RecipeUseDialog session={session} visible reply={reply} busy={false} paused={false} accountChanged={false} unavailable={false} needsRecovery={false} groupId={groupId} groupName="群聊" community={shell.community} onRefreshGroupName={() => {}} onSelectBot={() => {}} onSelectGroup={() => {}} onClose={() => {}} onRecover={() => {}} onRequest={async () => {}}/>}/>));
  }
  await render();
  expect(button('确认应用到这个群').disabled).toBe(false);
  detailRead = async () => {throw new Error('offline');};
  if (change === 'account') session.accountId = otherAccount;
  if (change === 'recipe') session.recipe.recipeId = nextVersion;
  if (change === 'version') session.recipe.versionId = nextVersion;
  if (change === 'handle') reply.handle = nextVersion;
  if (change === 'token') reply.reviewToken = newToken;
  await render();
  expect(button('确认应用到这个群').disabled).toBe(true);
  expect(document.body.textContent).toContain('暂时无法读取配方内容');
  expect(communityRequests.filter(request => request.type === 'detail')).toHaveLength(2);
});

it.each(['rules', 'files', 'tasks', 'setup'])('keeps %s prose and names verbatim', async kind => {
  const itemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const content = JSON.stringify({name: 'constructor', title: 'constructor', text: 'default', instruction: 'default', instructions: 'default'});
  useReply = () => ({kind: 'richReview', handle, groupId, reviewToken: token, conflicts: [{itemId, kind, base: null, local: content, incoming: null}]});
  await draw(); await click('预览已知群');
  expect(document.querySelector('fieldset')!.textContent).toContain('default');
  expect(document.querySelector('fieldset')!.textContent).not.toContain('默认');
  if (['files', 'tasks', 'setup'].includes(kind)) expect(document.querySelector('fieldset')!.textContent).toContain('constructor');
});

it('distinguishes a real parent-only card order conflict and retains the chosen order', async () => {
  const {defaultCardDisplay} = await import('@vonvon/protocol');
  const {recipeSnapshot, mergeRecipeItems} = await import('../../daemon/src/recipe/rich-merge');
  const {localRecipeItems, applyNativeRecipeFields} = await import('../../daemon/src/recipe/rich-settings');
  const id = (n: number) => `0000000${n}-1111-4111-8111-111111111111`;
  const native = defaultCardDisplay().blocks.slice(0, 3);
  const portable = native.map(({source: _source, language: _language, sample: _sample, script: _script, ...block}, index) => ({...block, itemId: id(index + 1), originId: id(index + 1)}));
  const snapshotFor = (order: number[]) => recipeSnapshot({format: 'rich-v2', schemaVersion: 2, public: {name: '排序', summary: '', overview: '', version: '1'}, rules: [], skills: [], files: [], tasks: [], memories: [], setup: [], settings: [{itemId: id(4), originId: id(4), field: 'presentation.cardDisplay', value: {version: 1, blocks: order.map(index => portable[index]!)}}]}, () => '');
  const base = snapshotFor([0, 1, 2]);
  const row = {richRecipe: {resolved: base}, presentation: {cardDisplay: {version: 1, blocks: [1, 0, 2].map(index => native[index]!)}}} as unknown as import('../../daemon/src/project/registry').Project;
  const incoming = snapshotFor([0, 2, 1]);
  const local = localRecipeItems(row, incoming);
  const {conflicts} = mergeRecipeItems(base, local, incoming);
  expect(conflicts).toHaveLength(1);
  const review = {kind: 'richReview' as const, handle, groupId, reviewToken: token, conflicts: conflicts.map(item => ({itemId: item.itemId, kind: item.local!.kind, base: JSON.stringify(item.base!.value), local: JSON.stringify(item.local!.value), incoming: JSON.stringify(item.incoming!.value)}))};
  for (const side of ['local', 'incoming'] as const) {
    const destination = structuredClone(row);
    applyNativeRecipeFields(destination, mergeRecipeItems(base, local, incoming, {[id(4)]: side}).resolved, base);
    expect(destination.presentation?.cardDisplay?.blocks.map(block => block.name)).toEqual((side === 'local' ? [1, 0, 2] : [0, 2, 1]).map(index => native[index]!.name));
  }
  useReply = request => request.type === 'richResolve' ? {kind: 'richPrepared', handle, groupId, reviewToken: token} : review;
  await draw(); await click('预览已知群');
  const sides = [...document.querySelectorAll('.recipe-use-compare')];
  expect(sides[0]?.textContent).toContain('卡片块2 → 卡片块1 → 卡片块3');
  expect(sides[1]?.textContent).toContain('卡片块1 → 卡片块3 → 卡片块2');
  expect(document.body.textContent).not.toContain(id(1));
  await pick(`input[name="${id(4)}"]`); await click('预览所选内容');
  expect(document.querySelector('.recipe-use-retained')?.textContent).toContain('卡片块2 → 卡片块1 → 卡片块3');
});

it('uses the same card block numbers after a missing block and in the retained summary', async () => {
  const ids = ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
  const setting = (order: string[]) => JSON.stringify({field: 'presentation.cardDisplay', value: {version: 1, blocks: order}});
  useReply = request => request.type === 'richResolve' ? {kind: 'richPrepared', handle, groupId, reviewToken: token} : {kind: 'richReview', handle, groupId, reviewToken: token, conflicts: [{itemId: versionId, kind: 'settings', base: setting(ids), local: setting([ids[2]!, ids[0]!]), incoming: setting([ids[1]!, ids[2]!, ids[0]!])}]};
  await draw(); await click('预览已知群');
  expect(document.querySelectorAll('.recipe-use-compare')[0]?.textContent).toContain('卡片块3 → 卡片块1');
  expect(document.querySelectorAll('.recipe-use-compare')[1]?.textContent).toContain('卡片块2 → 卡片块3 → 卡片块1');
  await pick(`input[name="${versionId}"]`); await click('预览所选内容');
  expect(document.querySelector('.recipe-use-retained')?.textContent).toContain('卡片块3 → 卡片块1');
  for (const id of ids) expect(document.body.textContent).not.toContain(id);
  await act(async () => accountListener!({...status as Extract<AccountStatus, {kind: 'signedIn'}>, accountId: otherAccount}));
  expect(document.querySelector('.recipe-use-retained')).toBeNull();
  expect(button('确认应用到这个群')).toBeUndefined();
});
