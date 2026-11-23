// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {desktopSnapshotSchema, membershipSchema, projectViewSchema, scheduledTaskViewSchema, type AccountShell, type CommunityRequest, type DesktopSnapshot} from '@vonvon/protocol';
import {permissionValue} from './permission-fixture';
import {App} from '../src/App';
import {DesktopRootView} from '../src/devices/DesktopRoot';
import {A, B, devicesState, fakeShell, newClient} from './devices-fixture';

const accountId = '44444444-4444-4444-8444-444444444444';
const draftId = '55555555-5555-4555-8555-555555555555';
const draft = {draftId, recipeId: null, revision: 1, public: {name: '已有私人草稿', summary: '', overview: '', version: '1', access: 'direct' as const}, config: {role: '已有角色'}};
function snapshot(name: string, revision = 1): DesktopSnapshot {
  const suffix = name.endsWith('B') ? 'b' : 'a'; const botId = 'cli_fixture_' + suffix; const groupId = 'oc_fixture_' + suffix;
  const membership = membershipSchema.parse({id: JSON.stringify([botId, groupId]), agentId: botId, groupId, name: name + '群', directory: '/tmp/synthetic-' + name, backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'full', member: 'full', network: false}, stale: false, enabled: true});
  return desktopSnapshotSchema.parse({revision, observedAt: revision, stale: false, host: {kind: 'connected', ownership: 'attached', version: '0.10.1'}, jobs: [], tools: [], agents: [{id: botId, name: name + '机器人', enabled: true, running: true, connection: 'connected', activation: 'active'}], groups: [{id: groupId, name: name + '群'}], memberships: [membership], application: {platform: 'linux', version: '0.10.1', loginItem: false, dataPath: '/tmp/synthetic-' + name}});
}
function device(name: string) {
  let current = snapshot(name);
  const active = new Set<(value: DesktopSnapshot) => void>();
  const obsolete: Array<(value: DesktopSnapshot) => void> = [];
  const task = scheduledTaskViewSchema.parse({id: 'task_' + name, botId: current.agents[0]!.id, chatId: current.groups[0]!.id, revision: '1', name: name + '任务', instruction: '检查', spec: {kind: 'daily', time: '09:00'}, timeZone: 'UTC', placement: {kind: 'follow'}, state: 'paused', pausedReason: 'manual', createdBy: {via: 'desktop'}, createdAt: 1, updatedAt: 1, running: false, counts: {runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0}, recent: [], describe: '每天 09:00'});
  const client = Object.assign(newClient(), {
    watchSnapshots: vi.fn((listener: (value: DesktopSnapshot) => void) => {active.add(listener); listener(current); return () => {active.delete(listener); obsolete.push(listener);};}),
    memory: vi.fn(async () => ({kind: 'newCounts', projects: {}, bots: {}, dm: {}})),
    environment: vi.fn(async () => ({kind: 'backends', entries: []})),
    collaboration: vi.fn(async () => ({kind: 'judgeUsage', days: [], unreadBots: 0})),
    schedule: vi.fn(async () => ({kind: 'tasks', tasks: [task], now: 1, timeZone: 'UTC'})),
    admin: vi.fn(async () => ({kind: 'daemonStatus', status: {}})),
    run: vi.fn(async (command: {type: string}) => command.type === 'listPendingGroups' ? {kind: 'pendingGroups', groups: []} : {kind: 'refused', code: 'fixture', message: 'Synthetic command receipt'}),
  });
  return {client, active, obsolete, task, emit(next: DesktopSnapshot) {current = next; active.forEach(listener => listener(next));}};
}
let root: Root;
let first: ReturnType<typeof device>;
let second: ReturnType<typeof device>;
let shell: ReturnType<typeof fakeShell>;
let requests: CommunityRequest[];
let saveAttempts: number;
const status = {kind: 'signedIn' as const, accountId, displayName: 'Fixture', provider: 'github' as const, persistence: 'memory' as const};
const account: AccountShell = {status: async () => status, onStatus: listener => {listener(status); return () => {};}, login: async () => status, cancelLogin: async () => status, logout: async () => ({kind: 'signedOut'})};
async function draw(id: string, phase: 'ready' | 'connecting' | 'failed' = 'ready') {
  await act(async () => root.render(<DesktopRootView state={devicesState({id, phase})} fallback={first.client} shell={shell} renderApp={() => <App/>}/>));
}
async function click(text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text);
  expect(button, text).toBeDefined(); await act(async () => button!.click());
}
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  expect(input, label).not.toBeNull();
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', {bubbles: true}));});
  return input;
}
async function openSearch() {await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', metaKey: true, bubbles: true})));}
async function closeSearch() {await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('IntersectionObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('matchMedia', () => ({matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById('root')!);
  account.logout = vi.fn(async () => ({kind: 'signedOut'}));
  first = device('设备A'); second = device('设备B'); requests = []; saveAttempts = 0;
  shell = {...fakeShell(), account, community: {request: async (request: CommunityRequest) => {
    requests.push(request);
    if (request.type === 'catalog') return {hero: null, items: [], nextCursor: null};
    if (request.type === 'library') return {items: [], nextCursor: null};
    if (request.type === 'drafts') return {items: [draft]};
    if (request.type === 'draft') return draft;
    if (request.type === 'publications') return {items: []};
    if (request.type === 'saveDraft') {if (++saveAttempts === 1) throw new Error('Synthetic response loss'); return {draftId, recipeId: null, revision: 1, public: request.public, config: request.config};}
    throw new Error('Unexpected cloud request');
  }}} as typeof shell;
  shell.devices.clientFor.mockImplementation((id: string) => id === B ? second.client : first.client);
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});

it('moves production App subscriptions, search and actions to the selected device after leaving Community', async () => {
  let finishOldTasks!: (reply: {kind: string; tasks: typeof first.task[]; now: number; timeZone: string}) => void;
  first.client.schedule.mockImplementationOnce(() => new Promise(resolve => {finishOldTasks = resolve;}));
  await draw(A); expect(first.active.size).toBe(1);
  await click('社区'); await openSearch(); await fill('搜索设置、Bot 或飞书群', '设备A机器人');
  expect(document.querySelector('[role="listbox"]')?.textContent).toContain('设备A机器人');
  await draw(B);
  expect(first.active.size).toBe(0); expect(second.active.size).toBe(1);
  await act(async () => {first.obsolete.forEach(listener => listener(snapshot('旧设备A', 2))); finishOldTasks({kind: 'tasks', tasks: [first.task], now: 1, timeZone: 'UTC'});});
  await fill('搜索设置、Bot 或飞书群', '设备A机器人');
  expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain('设备A机器人');
  await fill('搜索设置、Bot 或飞书群', '设备B机器人');
  expect(document.querySelector('[role="listbox"]')?.textContent).toContain('设备B机器人');
  await fill('搜索设置、Bot 或飞书群', '设备A任务');
  expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain('设备A任务');
  await fill('搜索设置、Bot 或飞书群', '设备B任务');
  expect(document.querySelector('[role="listbox"]')?.textContent).toContain('设备B任务');
  await closeSearch(); await click('Bot');
  expect(first.active.size).toBe(0); expect(second.active.size).toBe(1);
  expect(document.querySelector('main')?.textContent).toContain('设备B机器人');
  expect(document.querySelector('main')?.textContent).not.toContain('设备A机器人');
  await click('添加 Bot');
  expect(second.client.run.mock.calls.filter(([command]) => command.type === 'registerAgent')).toHaveLength(1);
  expect(first.client.run.mock.calls.filter(([command]) => command.type === 'registerAgent')).toHaveLength(0);
});
const draftHeading = () => document.querySelector('aside[aria-label="草稿操作"]')?.closest('article')?.querySelector('h1');

it('keeps the readonly account draft through A to B to A and returns to a fresh device page', async () => {
  await draw(A); await click('社区'); await click('我的配方'); await click('创作中'); await click('查看配方');
  const heading = draftHeading();
  expect(heading?.textContent).toBe(draft.public.name);
  for (const [id, phase] of [[B, 'connecting'], [B, 'ready'], [B, 'failed'], [A, 'ready']] as const) {
    await draw(id, phase);
    expect(draftHeading()).toBe(heading);
    expect(document.querySelector('input, textarea')).toBeNull();
  }
  expect(requests.filter(request => request.type === 'saveDraft')).toEqual([]);
  await act(async () => first.emit(snapshot('重新连接A', 3)));
  await click('Bot');
  expect(first.active.size).toBe(1); expect(second.active.size).toBe(0);
  await act(async () => first.obsolete.forEach(listener => listener(snapshot('旧设备A', 1))));
  expect(document.querySelector('main')?.textContent).toContain('重新连接A机器人');
  expect(document.querySelector('main')?.textContent).not.toContain('旧设备A机器人');
});

it('opens the account community from a production App with no daemon snapshot or configured Bots', async () => {
  first.client.watchSnapshots.mockImplementation(listener => {first.active.add(listener); return () => {first.active.delete(listener);};});
  await draw(A);
  await click('浏览社区');
  expect(document.querySelector('.community-heading h1')?.textContent).toBe('发现配方');
  await openSearch();
  expect(document.querySelector('[role="combobox"]')).not.toBeNull();
  await closeSearch();
  const button = document.querySelector<HTMLButtonElement>('[aria-label="搜索设置、Bot 或群组"]');
  await act(async () => button!.click());
  expect(document.querySelector('[role="combobox"]')).not.toBeNull();
});

it('keeps dirty production group settings behind the original guard before unmounting the device page', async () => {
  const source = snapshot('设备A'); source.memberships[0]!.conversation = 'smart'; first.emit(source);
  const member = source.memberships[0]!;
  const section = (stored: unknown) => ({stored, effective: stored, revision: 'r1', access: {kind: 'writable'}, apply: []});
  const view = projectViewSchema.parse({scope: {kind: 'project', botId: member.agentId, projectName: member.name}, identity: {chatId: member.groupId, backend: member.backend, cwd: member.directory, kind: 'smart'}, sections: {permission: section(permissionValue()), response: section({noMention: false}), model: section({selection: {kind: 'default'}}), smartRules: section({respond: '原来的群规则', newTopic: ''})}, members: {openIds: [], revision: 'members-r1'}});
  const settings = vi.fn(async () => ({kind: 'view', view})); Object.assign(first.client, {settings});
  first.client.collaboration.mockImplementation(async request => request.action === 'project' ? {kind: 'project', project: {name: member.name, chatId: member.groupId, cwd: member.directory, kind: 'smart', backend: member.backend, enabled: true, revision: 'project-r1'}} : {kind: 'judgeUsage', days: [], unreadBots: 0});
  await draw(A); await click('群组');
  await act(async () => document.querySelector<HTMLButtonElement>('.group-directory-identity')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('.group-directory-bot')!.click());
  await click('沟通方式');
  const summary = [...document.querySelectorAll('summary')].find(item => item.textContent === '智能回应设置')!;
  await act(async () => summary.click());
  const editor = document.querySelector<HTMLElement>('[aria-label="判断规则"]')!;
  expect(editor).not.toBeNull();
  await act(async () => {editor.textContent = '未保存的群规则'; editor.dispatchEvent(new Event('input', {bubbles: true}));});
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="当前设备："]')!.click());
  const otherDevice = [...document.querySelectorAll<HTMLButtonElement>('.device-switcher__device')].find(button => button.querySelector('[title="家里"]'))!;
  await act(async () => otherDevice.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('有未保存的修改');
  expect(shell.devices.switchTo).not.toHaveBeenCalled();
  await click('继续编辑');
  expect(editor.textContent).toBe('未保存的群规则');
  await click('社区');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('有未保存的修改');
  expect(document.querySelector('.community-heading')).toBeNull();
  await click('继续编辑');
  expect(document.querySelector('[aria-label="判断规则"]')).toBe(editor);
  expect(editor.textContent).toBe('未保存的群规则');
  expect(first.client.watchSnapshots).toHaveBeenCalledTimes(1);
  await click('社区'); await click('放弃并离开');
  expect(document.querySelector('.community-heading h1')?.textContent).toBe('发现配方');
  expect(document.querySelector('[aria-label="判断规则"]')).toBeNull();
  expect(first.client.watchSnapshots).toHaveBeenCalledTimes(2);
  expect(settings.mock.calls.every(([request]) => request.type === 'read')).toBe(true);
});
it('leaves a readonly account draft for account management and logout without an edit guard', async () => {
  await draw(A); await click('社区'); await click('我的配方'); await click('创作中'); await click('查看配方');
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="当前设备："]')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('.device-switcher__account-button')!.click());
  expect(document.body.textContent).not.toContain('有未保存的修改');
  expect(account.logout).not.toHaveBeenCalled();
  await click('退出登录'); expect(account.logout).toHaveBeenCalledOnce();
});
it('does not reuse the first A search generation when B never returned a snapshot', async () => {
  second.client.watchSnapshots.mockImplementation(listener => {second.active.add(listener); return () => {second.active.delete(listener); second.obsolete.push(listener);};});
  await draw(A); await click('社区'); await openSearch(); await fill('搜索设置、Bot 或飞书群', '设备A机器人');
  expect(document.querySelector('[role="listbox"]')?.textContent).toContain('设备A机器人');
  await draw(B, 'connecting');
  expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain('设备A机器人');
  await act(async () => first.emit(snapshot('新一代A', 5)));
  await draw(A);
  await act(async () => first.obsolete.forEach(listener => listener(snapshot('设备A', 1))));
  await fill('搜索设置、Bot 或飞书群', '设备A机器人');
  expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain('设备A机器人');
  await fill('搜索设置、Bot 或飞书群', '新一代A机器人');
  expect(document.querySelector('[role="listbox"]')?.textContent).toContain('新一代A机器人');
});

it('switches the community device through the actual menu while keeping the account draft readonly', async () => {
  shell.devices.switchTo.mockImplementation(async (id: string) => {root.render(<DesktopRootView state={devicesState({id})} fallback={first.client} shell={shell} renderApp={() => <App/>}/>);});
  await draw(A); await click('社区'); await click('我的配方'); await click('创作中'); await click('查看配方');
  const heading = draftHeading();
  expect(heading?.textContent).toBe(draft.public.name);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="当前设备："]')!.click());
  const target = [...document.querySelectorAll<HTMLButtonElement>('.device-switcher__device')].find(button => button.querySelector('[title="家里"]'))!;
  await act(async () => target.click());
  expect(shell.devices.switchTo).toHaveBeenCalledExactlyOnceWith(B);
  expect(draftHeading()).toBe(heading);
  await click('Bot');
  expect(document.body.textContent).not.toContain('有未保存的修改');
  expect(requests.filter(request => request.type === 'saveDraft')).toEqual([]);
});
it('does not reopen account management when an offline device reconnects after returning to connection controls', async () => {
  await draw(A); await click('社区'); await draw(A, 'failed');
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="当前设备："]')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('.device-switcher__account-button')!.click());
  expect(document.querySelector('.account-panel')).not.toBeNull();
  await click('返回设备连接');
  expect(document.querySelector('.account-panel')).toBeNull();
  await draw(A);
  expect(document.querySelector('.account-panel')).toBeNull();
  expect(document.querySelector('.today-intro h1')?.textContent).toBe('此刻');
});
