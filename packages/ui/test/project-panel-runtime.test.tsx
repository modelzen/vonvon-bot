import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, groupIdSchema, type CollaborationClient, type CollaborationReply, type ProjectRecord} from '@vonvon/protocol';
import {ProjectPanel} from '../src/management/ProjectPanel';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const harness = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, effects: [] as Effect[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, pending: [] as Array<() => void>,
  draft: undefined as undefined | {save?: () => Promise<boolean>; discard: () => void},
  dirty: false,
  client: {settings: vi.fn(async () => ({kind: 'unavailable'}))},
  pickDirectory: vi.fn(async () => ({token: 'folder-token', displayPath: '/draft'})),
}));

// Exercise the component's state and effect lifecycle without a browser or a
// second UI runtime; no live daemon is involved in these regression tests.
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.stateIndex++;
    if (!(index in harness.state)) harness.state[index] = initial;
    return [harness.state[index], (next: unknown) => {
      harness.state[index] = typeof next === 'function' ? next(harness.state[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = harness.refIndex++;
    return harness.refs[index] ??= {current: initial};
  },
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const index = harness.effectIndex++;
    const previous = harness.effects[index];
    if (previous?.deps && deps && previous.deps.length === deps.length && deps.every((value, at) => Object.is(value, previous.deps![at]))) return;
    harness.pending.push(() => {
      previous?.cleanup?.();
      harness.effects[index] = {deps, cleanup: effect() || undefined};
    });
  },
}));
vi.mock('../src/client-context', () => ({useClient: () => harness.client, useShellCapabilities: () => undefined}));
vi.mock('../src/directory-picker', () => ({useDirectoryPicker: () => harness.pickDirectory}));
vi.mock('../src/settings/DraftGuard', () => ({
  useDraftGuard: () => ({navigate: (action: () => void) => action()}),
  useDraft: (dirty: boolean, draft: typeof harness.draft) => {harness.dirty = dirty; harness.draft = draft;},
}));

const scope = {kind: 'project' as const, agentId: agentIdSchema.parse('cli_fixture'), groupId: groupIdSchema.parse('oc_demo'), projectName: 'demo'};
const project: ProjectRecord = {name: 'demo', chatId: scope.groupId, cwd: '/saved', kind: 'multi', backend: 'codex-appserver', enabled: true, revision: 'r1'};
const reason = 'Bot 已停用，启动后可修改群绑定。';
const child = <p>真实离线设置</p>;
const onChanged = vi.fn(async () => {});
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children), ...nodes(node.props.trailing), ...nodes(node.props.description)];
}
function render(request: CollaborationClient, inactiveReason?: string) {
  harness.stateIndex = harness.refIndex = harness.effectIndex = 0;
  const tree = ProjectPanel({scope, request, onChanged, inactiveReason, children: child});
  for (const effect of harness.pending.splice(0)) effect();
  const all = nodes(tree);
  return {
    all,
    button: (label: string) => all.find(node => node.props.children === label && 'onClick' in node.props)!,
    row: (title: string) => all.find(node => node.props.title === title)!,
    toggle: () => all.find(node => node.props['aria-label'] === '在这个群中使用 Bot')!,
  };
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
async function load(request: CollaborationClient) { render(request); await flush(); return render(request); }
function reader(next: () => ProjectRecord = () => project) {
  return vi.fn<CollaborationClient>(async request => request.action === 'project' ? {kind: 'project', project: next()} : {kind: 'applied'});
}
beforeEach(() => {
  harness.state = []; harness.refs = []; harness.effects = []; harness.pending = [];
  harness.draft = undefined; harness.dirty = false;
  vi.clearAllMocks();
});
afterEach(() => {for (const effect of harness.effects) effect.cleanup?.();});

it('treats an initially inactive Bot as a normal readonly state without a project RPC', async () => {
  const request = reader();
  render(request, reason);
  await flush();
  const ui = render(request, reason);
  expect(request).not.toHaveBeenCalled();
  expect(ui.row(reason)).toBeDefined();
  const binding = ui.all.find(node => node.props.className === 'group-binding-settings')!;
  expect(binding.props.label).toBeUndefined();
  expect(binding.props.footer).toBeUndefined();
  expect(ui.all.some(node => node.props['aria-label'] === '群内设置')).toBe(true);
  expect(ui.all).toContain(child);
  expect(ui.row('正在读取群内设置')).toBeUndefined();
  expect(ui.row('群内操作未完成')).toBeUndefined();
});

it('keeps a loaded binding and its draft offline, then refreshes its revision without losing edits', async () => {
  let remote = project;
  const request = reader(() => remote);
  let ui = await load(request);
  expect(ui.all.find(node => node.props.className === 'group-binding-settings')?.props.footer).toBeUndefined();
  ui.toggle().props.onChange({target: {checked: false}});
  ui.button('更换目录').props.onClick();
  await flush();
  render(request);
  ui = render(request, reason);
  expect(ui.toggle().props.checked).toBe(false);
  expect(ui.toggle().props.disabled).toBe(true);
  expect(ui.row('工作目录').props.description).toBe('/draft');
  expect(ui.all.find(node => node.props.className === 'group-binding-settings')?.props.footer).toContain('原目录和文件保留');
  for (const label of ['更换目录', '保存群内设置', '解除群绑定…']) expect(ui.button(label).props.disabled).toBe(true);
  expect(ui.all.find(node => node.props.target === 'threads')?.props.disabled).toBe(true);
  expect(harness.dirty).toBe(true);
  expect(harness.draft?.save).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  remote = {...project, revision: 'r2'};
  render(request);
  await flush();
  ui = render(request);
  expect(ui.toggle().props.checked).toBe(false);
  expect(ui.row('工作目录').props.description).toBe('/draft');
  expect(harness.dirty).toBe(true);
  remote = {...project, revision: 'r3'};
  await harness.draft?.save?.();
  expect(request).toHaveBeenCalledWith({action: 'editProject', agentId: scope.agentId, groupId: scope.groupId, projectName: scope.projectName, expectedRevision: 'r3', folderToken: 'folder-token', conversation: 'threads', enabled: false});
});

it('retains the original baseline and draft when a binding changed while the Bot was offline', async () => {
  let remote = project;
  const request = reader(() => remote);
  const ui = await load(request);
  ui.toggle().props.onChange({target: {checked: false}});
  render(request, reason);
  remote = {...project, cwd: '/changed-elsewhere', revision: 'r2'};
  render(request);
  await flush();
  const resumed = render(request);
  expect(resumed.toggle().props.checked).toBe(false);
  expect(resumed.row('工作目录').props.description).toBe('/saved');
  expect(resumed.row('群内操作未完成').props.children).toContain('当前修改已保留');
  expect(await harness.draft?.save?.()).toBe(false);
  expect(request.mock.calls.every(([request]) => request.action === 'project')).toBe(true);
});

it('does not send a write if the Bot stops while the save is checking its revision', async () => {
  const request = reader();
  const ui = await load(request);
  ui.toggle().props.onChange({target: {checked: false}});
  render(request);
  let finish = (_reply: CollaborationReply) => {};
  request.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const saving = harness.draft!.save!();
  render(request, reason);
  finish({kind: 'project', project: {...project, revision: 'r2'}});
  expect(await saving).toBe(false);
  const offline = render(request, reason);
  expect(offline.toggle().props.checked).toBe(false);
  expect(harness.dirty).toBe(true);
  expect(request.mock.calls.every(([request]) => request.action === 'project')).toBe(true);
});
