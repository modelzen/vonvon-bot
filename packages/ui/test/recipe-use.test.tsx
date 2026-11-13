// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {
  agentIdSchema, groupIdSchema, desktopSnapshotSchema, recipeUseRequestSchema, desktopRecipeSourceRequestSchema,
  communityRequestSchema, communityResponseSchemas, collaborationRequestSchema, commandSchema,
  type AccountStatus, type AccountShell, type RecipeUseRequest, type RecipeUseReply, type DesktopRecipeSourceRequest,
  type DesktopRecipeSourceReply, type CommunityRequest, type CommunityResponses, type ProjectSettingsView,
} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {DesktopRootView} from '../src/devices/DesktopRoot';
import {useCommunity} from '../src/community/community-context';
import {RecipeSourcePanel} from '../src/recipes/RecipeSourcePanel';
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
const baseReview = {reviewToken: token, currentRole: '当前职责', baseRole: '上次职责', incomingRole: '新职责', currentSetup: setup, baseSetup: setup, incomingSetup: setup, roleChoiceRequired: false, setupChoiceRequired: false};
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
  requests = []; sourceRequests = []; communityRequests = []; acquired = true;
  status = {kind: 'signedIn', accountId, displayName: 'Synthetic', provider: 'github', persistence: 'memory'};
  const account: AccountShell = {status: async () => status, onStatus: listener => {accountListener = listener; listener(status); return () => {};}, login: async () => status, cancelLogin: async () => status, logout: async () => ({kind: 'signedOut'})};
  useReply = request => request.type === 'begin' ? {kind: 'choose', handle} : request.type === 'join' || request.type === 'retry' ? {kind: 'prepared', handle, groupId, review: baseReview} : request.type === 'confirm' || request.type === 'resume' ? {kind: 'applied', handle, groupId} : {kind: 'closed'};
  sourceReply = () => ({source: null});
  const facade = createDesktopFacades({receive: () => () => {}, invoke: async (channel, raw) => {
    if (channel === desktopChannels.recipeUse) {const request = recipeUseRequestSchema.parse(raw); requests.push(request); return {ok: true, value: await useReply(request)};}
    if (channel === desktopChannels.recipeSource) {const request = desktopRecipeSourceRequestSchema.parse(raw); sourceRequests.push(request); return {ok: true, value: await sourceReply(request)};}
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
  Object.assign(shell, {account, recipeUse: facade.shell.recipeUse, recipeSource: facade.shell.recipeSource, community: {request: async (raw: CommunityRequest) => {
    const request = communityRequestSchema.parse(raw); communityRequests.push(request);
    const result = request.type === 'detail' ? {...detail, versionId: request.versionId, acquired}
      : request.type === 'shareLink' ? {url: 'https://example.invalid/recipe'}
      : request.type === 'acquire' ? (acquired = true, {recipeId, versionId: request.versionId, owned: false, acquired: true})
      : request.type === 'catalog' ? {hero: detail, items: []} : {items: []};
    return communityResponseSchemas[request.type].parse(result) as CommunityResponses[typeof request.type];
  }}});
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
  expect(document.body.textContent).toContain('获取或应用配方不会自动执行');
  await click('确认应用到这个群');
  expect(document.body.textContent).toContain('已应用到目标群，云端已确认');
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

it('requires fresh token-bound choices after a changed review, including Unicode length and setup choice', async () => {
  let resolves = 0;
  useReply = request => request.type === 'begin' ? {kind: 'choose', handle}
    : request.type === 'join' ? {kind: 'review', handle, groupId, review: {...baseReview, roleChoiceRequired: true, setupChoiceRequired: true}}
    : request.type === 'resolve' && resolves++ === 0 ? {kind: 'review', handle, groupId, review: {...baseReview, reviewToken: newToken, currentRole: '另一人刚修改', roleChoiceRequired: true, setupChoiceRequired: true}}
    : {kind: 'prepared', handle, groupId, review: {...baseReview, reviewToken: newToken}};
  await draw(); await openUse(); await createGroup();
  expect(button('预览所选内容').disabled).toBe(true);
  expect(document.body.textContent).toContain('上次职责');
  await pick('input[name="recipe-role"][value="custom"]'); await fill('合并后的本群角色', '🦉'.repeat(5001));
  expect(document.body.textContent).toContain('本群角色最多 5000 字');
  await fill('合并后的本群角色', '🦉'.repeat(5000)); await pick('input[name="recipe-setup"]');
  await click('预览所选内容');
  expect(requests.at(-1)).toEqual({type: 'resolve', handle, reviewToken: token, resolution: {role: {kind: 'custom', text: '🦉'.repeat(5000)}, setup: 'keep'}});
  expect(button('预览所选内容').disabled).toBe(true);
  expect(document.querySelectorAll('input[name="recipe-role"]:checked')).toHaveLength(0);
  expect(document.body.textContent).toContain('另一人刚修改');
  await pick('input[name="recipe-role"][value="replace"]'); await pick('input[name="recipe-setup"]'); await click('预览所选内容');
  expect(requests.at(-1)).toEqual({type: 'resolve', handle, reviewToken: newToken, resolution: {role: {kind: 'replace'}, setup: 'keep'}});
  expect(button('确认应用到这个群')).toBeDefined();
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
