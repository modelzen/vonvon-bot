import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {desktopSnapshotSchema} from '@vonvon/protocol';
import {ProjectMemoryMap} from '../src/ProjectPage';
import {MemoryMap} from '../src/MemoryMap';
import {GroupDesignSettings} from '../src/settings/GroupDesignSettings';
import type {MapNode} from '../src/MindMap';

const harness = vi.hoisted(() => ({states: [] as unknown[], at: 0, pending: [] as Array<() => void>, beforeInspect: undefined as undefined | ((inspect: () => void) => void), close: vi.fn()}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const index = harness.at++; if (!(index in harness.states)) harness.states[index] = typeof initial === 'function' ? initial() : initial; return [harness.states[index], (next: unknown) => {harness.states[index] = typeof next === 'function' ? next(harness.states[index]) : next;}];},
  useEffect: () => {}, useMemo: (make: () => unknown) => make(),
}));
vi.mock('../src/settings/DraftGuard', () => ({useDraftGuard: () => ({navigate: (action: () => void) => harness.pending.push(action)}), useDraft: () => {}}));
vi.mock('../src/inherited-content', () => ({useInheritedContent: (options: {beforeInspect?: (inspect: () => void) => void}) => {
  harness.beforeInspect = options.beforeInspect;
  return {nodes: [], panel: undefined, close: harness.close};
}}));

const snapshot = desktopSnapshotSchema.parse({
  revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: '1'},
  agents: [{id: 'cli_a', name: '小支', enabled: true, running: true, connection: 'connected', activation: 'active'}, {id: 'cli_b', name: '小发', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [{id: 'oc_pay', name: '支付组'}, {id: 'oc_release', name: '发布群'}],
  projects: [{id: 'prj_00000001', name: '支付项目', revision: 1, directory: '/w', bindings: [{agentId: 'cli_a', groupId: 'oc_pay'}, {agentId: 'cli_b', groupId: 'oc_release'}]}],
  memberships: [['cli_a', 'oc_pay'], ['cli_b', 'oc_release']].map(([agentId, groupId]) => ({id: JSON.stringify([agentId, groupId]), agentId, groupId, projectId: 'prj_00000001', name: `binding-${groupId}`, directory: '/w', backend: 'codex-appserver', conversation: 'threads', response: 'mention', effectMode: 'qa', permission: {administrator: 'qa', member: 'qa', network: false}, stale: false})),
  tools: [], jobs: [], application: {platform: 'macos', version: '1', loginItem: false, dataPath: '/t'},
});
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children)] : [];}
function render(extra: Partial<Parameters<typeof ProjectMemoryMap>[0]> = {}) {
  harness.at = 0;
  const tree = ProjectMemoryMap({project: snapshot.projects![0]!, snapshot, onMembership: vi.fn(), ...extra});
  return nodes(tree).find(node => node.type === MemoryMap)!;
}
const roles = (map: Element) => (map.props.before as MapNode[]).find(node => node.id === 'group-roles')!.children!;
const editor = (map: Element) => nodes(map.props.panel).find(node => node.type === GroupDesignSettings);
const approve = () => {harness.pending.shift()!();};
beforeEach(() => {harness.states = []; harness.at = 0; harness.pending = []; harness.beforeInspect = undefined; vi.clearAllMocks();});

it('keeps group role editors unmounted until a map leaf is opened, then edits the selected binding only', () => {
  let map = render();
  expect(editor(map)).toBeUndefined();
  expect(roles(map)).toHaveLength(2);
  roles(map)[0]!.onClick!();
  expect(editor(render())).toBeUndefined();
  approve(); map = render();
  expect(editor(map)?.props).toMatchObject({tab: 'role', scope: {kind: 'project', botId: 'cli_a', projectName: 'binding-oc_pay'}});
  roles(map)[1]!.onClick!();
  expect(editor(render())?.props.scope.botId).toBe('cli_a');
  approve();
  expect(editor(render())?.props.scope.botId).toBe('cli_b');
});

it('guards switching from an open role editor to project memory, inherited content, or closing details', () => {
  let map = render({initialRoleMembershipId: snapshot.memberships[0]!.id});
  expect(editor(map)).toBeDefined();
  const select = vi.fn();
  map.props.beforeLeafSelect(select);
  expect(select).not.toHaveBeenCalled(); expect(editor(render())).toBeDefined();
  approve(); expect(select).toHaveBeenCalledOnce(); expect(editor(render())).toBeUndefined();

  roles(render())[0]!.onClick!(); approve(); map = render();
  const inspect = vi.fn(); harness.beforeInspect!(inspect);
  expect(inspect).not.toHaveBeenCalled(); expect(editor(render())).toBeDefined();
  approve(); expect(inspect).toHaveBeenCalledOnce(); expect(editor(render())).toBeUndefined();

  roles(render())[0]!.onClick!(); approve(); map = render();
  map.props.onPanelClose(); expect(editor(render())).toBeDefined();
  approve(); expect(editor(render())).toBeUndefined();
});

it('limits role leaves to the selected group and Bot and supports the existing role search entry', () => {
  const member = snapshot.memberships[1]!;
  const map = render({selectedAgentId: member.agentId, selectedGroupId: member.groupId, initialRoleMembershipId: member.id});
  expect(roles(map)).toHaveLength(1);
  expect(roles(map)[0]!.label).toBe('发布群 · 小发');
  expect(editor(map)?.props.scope).toEqual({kind: 'project', botId: member.agentId, projectName: member.name});
});

it('does not open an editor for a stale binding that now belongs to another project', () => {
  const changed = {...snapshot, memberships: snapshot.memberships.map(member => ({...member, projectId: 'prj_00000002' as typeof member.projectId}))};
  const map = render({snapshot: changed, initialRoleMembershipId: snapshot.memberships[0]!.id});
  expect(editor(map)).toBeUndefined();
  for (const role of roles(map)) {expect(role.onClick).toBeUndefined(); expect(role.meta).toBe('暂不可用');}
});

it('keeps missing binding roles unavailable and unselected without mounting an editor', () => {
  const map = render({snapshot: {...snapshot, memberships: []}});
  expect(editor(map)).toBeUndefined();
  for (const role of roles(map)) {expect(role.onClick).toBeUndefined(); expect(role.selected).toBe(false);}
});
