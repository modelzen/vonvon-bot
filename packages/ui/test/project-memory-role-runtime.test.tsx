import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {desktopSnapshotSchema} from '@vonvon/protocol';
import {ProjectMemoryMap} from '../src/ProjectPage';
import {BotMap} from '../src/BotMap';
import {MemoryMap} from '../src/MemoryMap';
import type {MapNode} from '../src/MindMap';

const h = vi.hoisted(() => ({states: [] as unknown[], at: 0, scope: undefined as unknown, guarded: vi.fn(), beginEdit: vi.fn(), close: vi.fn(), inspect: undefined as undefined | ((action: () => void) => void)}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const index = h.at++; if (!(index in h.states)) h.states[index] = typeof initial === 'function' ? initial() : initial; return [h.states[index], (next: unknown) => {h.states[index] = typeof next === 'function' ? next(h.states[index]) : next;}];},
  useEffect: () => {}, useMemo: (make: () => unknown) => make(),
}));
vi.mock('../src/settings/DraftGuard', () => ({useDraftGuard: () => ({navigate: (action: () => void) => action()}), useDraft: () => {}}));
vi.mock('../src/client-context', () => ({useClient: () => ({memory: vi.fn()})}));
vi.mock('../src/role-map', () => ({useRoleMap: (scope: unknown) => {
  h.scope = scope;
  return {role: scope ? {fields: (scope as {kind: string}).kind === 'agent' ? {identity: '机器人身份', notes: '先写结论'} : {supplement: '负责发版检查。'}, readonly: undefined} : undefined,
    content: (_field: string, id: string) => <span data-role-editor={id}/>, beginEdit: h.beginEdit,
    withSavedDraft: (action: () => void) => {h.guarded(); action();}, statusNodes: [{id: 'role-status', kind: 'leaf', label: '角色提示'}]};
}}));
vi.mock('../src/inherited-content', () => ({useInheritedContent: (options: {beforeInspect?: (action: () => void) => void}) => {
  h.inspect = options.beforeInspect;
  return {nodes: [], close: h.close};
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
function render(extra: Partial<Parameters<typeof ProjectMemoryMap>[0]> = {}) {h.at = 0; const tree = ProjectMemoryMap({project: snapshot.projects![0]!, snapshot, onMembership: vi.fn(), ...extra}); return nodes(tree).find(node => node.type === MemoryMap)!;}
const roles = (map: Element) => (map.props.before as MapNode[]).find(node => node.id === 'group-roles')!.children!;
beforeEach(() => {h.states = []; h.at = 0; h.scope = undefined; h.inspect = undefined; vi.clearAllMocks();});

it('keeps Bot identity and notes as readable, directly editable map nodes', () => {
  h.at = 0;
  let map = nodes(BotMap({agentId: snapshot.agents[0]!.id, snapshot, onProject: vi.fn()})).find(node => node.type === MemoryMap)!;
  expect(map.props.panel).toBeUndefined(); expect(map.props.beforeInteraction).toBeDefined();
  const roleNodes = (map.props.before as MapNode[])[0]!.children!;
  expect(roleNodes[0]?.label).toContain('机器人身份'); expect(roleNodes[0]?.onDelete).toBeUndefined();
  roleNodes[0]!.onClick?.(); h.at = 0;
  map = nodes(BotMap({agentId: snapshot.agents[0]!.id, snapshot, onProject: vi.fn()})).find(node => node.type === MemoryMap)!;
  const identity = (map.props.before as MapNode[])[0]!.children![0]!;
  expect(identity.children?.[0]?.label).toBe('机器人身份');
  identity.onEdit?.(); expect(h.beginEdit).toHaveBeenCalledWith('identity', undefined);
});

it('renders the selected group role as editable child nodes inside the map, without a panel', () => {
  const map = render({initialRoleMembershipId: snapshot.memberships[0]!.id});
  expect(map.props.panel).toBeUndefined(); expect(map.props.panelKey).toBeUndefined();
  expect(h.scope).toEqual({kind: 'project', botId: 'cli_a', projectName: 'binding-oc_pay'});
  const first = roles(map)[0]!;
  expect(first.children?.map(node => node.id)).toContain('role:cli_a:oc_pay:text');
  expect(first.children?.[0]?.label).toBe('负责发版检查。');
  expect(first.children?.[0]?.content).toBeDefined();
  first.children?.[0]?.onEdit?.(); expect(h.beginEdit).toHaveBeenCalledWith('supplement', undefined);
  expect(first.onDelete).toBeUndefined();
});

it('selects only the requested binding and keeps inherited inspection in the map', () => {
  let map = render(); expect(h.scope).toBeUndefined();
  roles(map)[1]!.onClick?.(); map = render();
  expect(h.scope).toEqual({kind: 'project', botId: 'cli_b', projectName: 'binding-oc_release'});
  h.close.mockClear();
  const inspect = vi.fn(); h.inspect?.(inspect);
  expect(inspect).toHaveBeenCalledOnce(); expect(h.close).not.toHaveBeenCalled();
  map = render(); expect(h.scope).toBeUndefined();
});

it('shares the role session guard with map selection and clears role selection only for memory leaf actions', () => {
  let map = render({initialRoleMembershipId: snapshot.memberships[0]!.id});
  const action = vi.fn(); map.props.beforeInteraction(action);
  expect(h.guarded).toHaveBeenCalledOnce(); expect(action).toHaveBeenCalledOnce();
  expect(h.scope).toBeDefined();
  map.props.beforeLeafSelect(action); map = render();
  expect(h.scope).toBeUndefined(); expect(h.close).toHaveBeenCalledOnce();
});

it('keeps stale and missing bindings unavailable', () => {
  const stale = {...snapshot, memberships: snapshot.memberships.map(member => ({...member, projectId: 'prj_00000002' as typeof member.projectId}))};
  let map = render({snapshot: stale, initialRoleMembershipId: snapshot.memberships[0]!.id});
  expect(h.scope).toBeUndefined();
  for (const row of roles(map)) {expect(row.onEdit).toBeUndefined(); expect(row.onClick).toBeUndefined(); expect(row.meta).toBe('暂不可用');}
  map = render({snapshot: {...snapshot, memberships: []}});
  for (const row of roles(map)) expect(row.onClick).toBeUndefined();
});
