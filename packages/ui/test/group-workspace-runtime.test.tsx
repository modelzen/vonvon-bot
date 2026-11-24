import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, desktopSnapshotSchema, type DesktopSnapshot, type LibraryReply, type ProjectSettingsView, type SettingsReply} from '@vonvon/protocol';
import {DirectorySearchStep} from '../src/DirectorySearchStep';
import {Dialog} from '../src/reference/components/ui/Dialog';
import {GroupWorkspaceSection} from '../src/settings/GroupWorkspaceSection';
import {permissionValue} from './permission-fixture';

type Slot = {state: unknown[]; refs: Array<{current: unknown}>; si: number; ri: number};
const h = vi.hoisted(() => ({
  slots: {} as Record<string, Slot>,
  dirty: false,
  active: '',
  client: {
    library: vi.fn(),
    settings: vi.fn(),
  },
}));

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const slot = h.slots[h.active]!;
    const i = slot.si++;
    if (!(i in slot.state)) slot.state[i] = typeof initial === 'function' ? initial() : initial;
    return [slot.state[i], (next: unknown) => { slot.state[i] = typeof next === 'function' ? next(slot.state[i]) : next; }];
  },
  useRef: (initial: unknown) => {
    const slot = h.slots[h.active]!;
    return slot.refs[slot.ri++] ??= {current: initial};
  },
  useMemo: (make: () => unknown) => make(),
  useCallback: <T,>(fn: T) => fn,
  useContext: () => [],
  useEffect: () => {},
}));
vi.mock('../src/client-context', () => ({
  useClient: () => h.client,
  useActiveDevice: () => ({id: 'local', name: '本机', isRemote: false}),
}));
vi.mock('../src/settings/DraftGuard', () => ({
  useDraft: (dirty: boolean) => { h.dirty = dirty; },
  useDraftGuard: () => ({navigate: (action: () => void) => action()}),
}));

type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  if (node.type === Dialog && !node.props.open) return [node];
  return [node, ...nodes(node.props.children), ...nodes(node.props.footer), ...nodes(node.props.trailing), ...nodes(node.props.title), ...nodes(node.props.description)];
}
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<Record<string, any>>(node)) return textOf(node.props.children);
  return '';
}
function render(props: Parameters<typeof GroupWorkspaceSection>[0]) {
  const slot = h.slots.main ??= {state: [], refs: [], si: 0, ri: 0};
  h.active = 'main';
  slot.si = slot.ri = 0;
  const all = nodes(GroupWorkspaceSection(props));
  return {
    all,
    dialog: all.find(node => node.type === Dialog)!,
    picker: all.find(node => node.type === DirectorySearchStep),
    button: (label: string) => all.find(node => (node.props.children === label || textOf(node.props.children) === label) && node.props.onClick),
    byAria: (label: string) => all.find(node => node.props['aria-label'] === label),
  };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

const projectId = 'prj_00000001' as const;
const makeSnapshot = (extraBindings: Array<{agentId: string; groupId: string}> = []): DesktopSnapshot => desktopSnapshotSchema.parse({
  revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: '1'},
  agents: [
    {id: 'cli_a', name: '小支', enabled: true, running: true, connection: 'connected', activation: 'active'},
    {id: 'cli_b', name: '小发', enabled: true, running: true, connection: 'connected', activation: 'active'},
  ],
  groups: [{id: 'oc_pay', name: '支付组'}, {id: 'oc_rel', name: '发布群'}],
  projects: [{id: projectId, name: '支付组', revision: 3, directory: '/default/pay', bindings: [{agentId: 'cli_a', groupId: 'oc_pay'}, ...extraBindings]}],
  memberships: [{
    id: JSON.stringify(['cli_a', 'oc_pay']), agentId: 'cli_a', groupId: 'oc_pay', projectId,
    name: '支付组', directory: '/default/pay', backend: 'codex-appserver', conversation: 'threads', response: 'mention',
    permission: {administrator: 'qa', member: 'qa', network: false}, stale: false,
  }],
  tools: [], jobs: [], application: {platform: 'macos', version: '1', loginItem: false, dataPath: '/data'},
});
const section = <const T,>(stored: T, access: object = {kind: 'writable'}) => ({stored, effective: stored, revision: 'w1', access, apply: []});
const makeView = (workspace = {primary: '/default/pay', directories: ['/default/pay'], repositories: [] as string[]}): ProjectSettingsView => ({
  scope: {kind: 'project', botId: agentIdSchema.parse('cli_a'), projectName: '支付组'},
  identity: {chatId: 'oc_pay', backend: 'codex-appserver', cwd: workspace.primary, kind: 'threads'},
  sections: {
    permission: section(permissionValue()),
    response: section({noMention: false}),
    model: section({selection: {kind: 'default'}}),
    workspace: section(workspace),
  },
  members: {openIds: [], revision: 'm'},
} as unknown as ProjectSettingsView);

beforeEach(() => {
  h.slots = {};
  h.dirty = false;
  h.client.library.mockReset();
  h.client.settings.mockReset();
});

it('replaces the primary directory and adds an additional directory through DirectorySearchStep, then saves via library.workspace without touching implicit repositories', async () => {
  const snapshot = makeSnapshot();
  const onRefresh = vi.fn(async () => {});
  const onChanged = vi.fn(async () => {});
  const props = {view: makeView(), member: snapshot.memberships[0], snapshot, onRefresh, onChanged};

  h.client.library.mockResolvedValueOnce({
    kind: 'list', unlinked: 0,
    projects: [{id: projectId, name: '支付组', revision: 3, workspace: {primary: '/default/pay', additional: []}, bindings: [{agentId: 'cli_a', groupId: 'oc_pay', name: '支付组', enabled: true}]}],
  } satisfies LibraryReply);
  h.client.library.mockResolvedValueOnce({
    kind: 'workspace', changed: true,
    project: {id: projectId, name: '支付组', revision: 4, workspace: {primary: '/code/app', additional: ['/code/docs']}},
    rebound: [{agentId: 'cli_a', groupId: 'oc_pay', state: 'archived'}],
  } satisfies LibraryReply);

  let ui = render(props);
  expect(ui.dialog.props.open).toBe(false);
  expect(textOf(ui.all)).toContain('/default/pay');
  expect(textOf(ui.all)).not.toContain('查看项目');

  // Open dialog and load fresh library workspace.
  ui.button('修改工作区')!.props.onClick();
  await flush();
  ui = render(props);
  expect(ui.dialog.props.open).toBe(true);
  expect(h.client.library).toHaveBeenCalledWith({type: 'list'});
  expect(ui.byAria('代码仓库')).toBeUndefined();
  expect(ui.button('保存工作区')!.props.disabled).toBe(true);

  // Replace primary directory in one step.
  ui.button('更换目录')!.props.onClick();
  ui = render(props);
  expect(ui.picker).toBeDefined();
  ui.picker!.props.onChoose({token: 't1', displayPath: '/code/app'});
  ui = render(props);
  expect(ui.picker).toBeUndefined();
  expect(h.dirty).toBe(true);
  expect(textOf(ui.dialog.props.children)).toContain('/code/app');
  expect(textOf(ui.dialog.props.children)).not.toContain('/default/pay');

  // Add an additional directory and verify duplicate check.
  ui.button('添加目录')!.props.onClick();
  ui = render(props);
  ui.picker!.props.onChoose({token: 't2', displayPath: '/code/app'});
  ui = render(props);
  expect(textOf(ui.all)).toContain('这个目录已经是当前主目录');

  ui.button('添加目录')!.props.onClick();
  ui = render(props);
  ui.picker!.props.onChoose({token: 't3', displayPath: '/code/docs'});
  ui = render(props);
  expect(textOf(ui.all)).toContain('/code/docs');

  // Save workspace: repositories stays omitted since it was never configured or edited.
  ui.button('保存工作区')!.props.onClick();
  await flush();
  ui = render(props);
  expect(h.client.library).toHaveBeenLastCalledWith({
    type: 'workspace',
    projectId,
    revision: 3,
    workspace: {primary: '/code/app', additional: ['/code/docs']},
  });
  expect(ui.dialog.props.open).toBe(false);
  expect(onRefresh).toHaveBeenCalledTimes(1);
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(textOf(ui.all)).toContain('工作区已保存');
});

it('displays legacy repositories only when configured and persists their removal', async () => {
  const snapshot = makeSnapshot();
  const props = {
    view: makeView({primary: '/code/app', directories: ['/code/app'], repositories: ['/code/old-repo']}),
    member: snapshot.memberships[0],
    snapshot,
    onRefresh: vi.fn(async () => {}),
    onChanged: vi.fn(async () => {}),
  };

  h.client.library.mockResolvedValueOnce({
    kind: 'list', unlinked: 0,
    projects: [{id: projectId, name: '支付组', revision: 2, workspace: {primary: '/code/app', additional: [], repositories: ['/code/old-repo']}, bindings: [{agentId: 'cli_a', groupId: 'oc_pay', name: '支付组', enabled: true}]}],
  } satisfies LibraryReply);
  h.client.library.mockResolvedValueOnce({
    kind: 'workspace', changed: true,
    project: {id: projectId, name: '支付组', revision: 3, workspace: {primary: '/code/app', additional: [], repositories: []}},
    rebound: [{agentId: 'cli_a', groupId: 'oc_pay', state: 'archived'}],
  } satisfies LibraryReply);

  let ui = render(props);
  ui.button('修改工作区')!.props.onClick();
  await flush();
  ui = render(props);
  expect(textOf(ui.all)).toContain('代码仓库');
  expect(textOf(ui.all)).toContain('/code/old-repo');
  expect(textOf(ui.all)).not.toContain('添加仓库');

  ui.byAria('移除old-repo')!.props.onClick();
  ui = render(props);
  expect(textOf(ui.all)).not.toContain('/code/old-repo');

  ui.button('保存工作区')!.props.onClick();
  await flush();
  expect(h.client.library).toHaveBeenLastCalledWith({
    type: 'workspace',
    projectId,
    revision: 2,
    workspace: {primary: '/code/app', additional: [], repositories: []},
  });
});

it('falls back to settings workspace save when a row has no projectId (older daemon)', async () => {
  const snapshot = makeSnapshot();
  const unlinked = {...snapshot.memberships[0]!, projectId: undefined};
  const onRefresh = vi.fn(async () => {});
  const props = {view: makeView(), member: unlinked, snapshot, onRefresh};
  h.client.settings.mockResolvedValueOnce({
    kind: 'saved',
    result: {kind: 'saved', section: {scope: props.view.scope, section: 'workspace', value: props.view.sections.workspace!}, effects: [], warnings: []},
  } satisfies SettingsReply);

  let ui = render(props);
  ui.button('修改工作区')!.props.onClick();
  await flush();
  ui = render(props);
  expect(h.client.library).not.toHaveBeenCalled();

  ui.button('更换目录')!.props.onClick();
  ui = render(props);
  ui.picker!.props.onChoose({token: 't1', displayPath: '/code/legacy'});
  ui = render(props);
  ui.button('保存工作区')!.props.onClick();
  await flush();
  ui = render(props);

  expect(h.client.settings).toHaveBeenCalledWith({
    type: 'save',
    edit: {scope: props.view.scope, section: 'workspace', revision: 'w1', patch: {primary: '/code/legacy', directories: ['/code/legacy']}},
  });
  expect(ui.dialog.props.open).toBe(false);
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it('shows shared peers and project link only when multiple bindings share the workspace', () => {
  const snapshot = makeSnapshot([{agentId: 'cli_a', groupId: 'oc_rel'}]);
  const onProject = vi.fn();
  const ui = render({view: makeView(), member: snapshot.memberships[0], snapshot, onRefresh: async () => {}, onProject});
  expect(textOf(ui.all)).toContain('与「发布群」共用');
  ui.button('查看项目')!.props.onClick();
  expect(onProject).toHaveBeenCalledWith(projectId);
});
