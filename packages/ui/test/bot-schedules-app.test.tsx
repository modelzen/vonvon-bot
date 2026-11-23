import {afterEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, groupIdSchema, membershipIdSchema, type DesktopSnapshot} from '@vonvon/protocol';
import {App} from '../src/App';
import {BotListRow} from '../src/BotListRow';
import {BotSchedules} from '../src/BotSchedules';
import {AppShell} from '../src/LocalShell';
import {GroupWorkspace} from '../src/GroupWorkspace';

// DesktopApp is called as a plain function: hooks keep their values by call order, effects run when their deps change.
const h = vi.hoisted(() => ({state: [] as unknown[], refs: [] as Array<{current: unknown}>, effects: [] as Array<{deps?: unknown[]}>, si: 0, ri: 0, ei: 0, pending: [] as Array<() => void>,
  client: {watchSnapshots: (_listener: (snapshot: unknown) => void) => () => {}}}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[i]) : next;}];},
  useRef: (initial: unknown) => {const i = h.ri++; return h.refs[i] ??= {current: initial};},
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const i = h.ei++; const old = h.effects[i]; if (old?.deps && deps && deps.every((value, at) => Object.is(value, old.deps![at]))) return; h.pending.push(() => {h.effects[i] = {deps}; effect();});},
}));
// The page shows this computer, with no shell and no device list.
vi.mock('../src/client-context', async original => {
  const actual = await original<typeof import('../src/client-context')>();
  return {...actual, useClient: () => h.client, useShellCapabilities: () => undefined, useActiveDevice: () => actual.LOCAL_ACTIVE_DEVICE, useDevicesState: () => undefined};
});
vi.mock('../src/settings/DraftGuard', () => ({DraftGuardProvider: () => null, useDraftGuard: () => ({navigate: (action: () => void) => action()})}));
vi.mock('../src/desktop-update', () => ({DesktopUpdateProvider: () => null, useDesktopUpdate: () => [undefined]}));
vi.mock('../src/accounts/account-page', () => ({useAccountPage: () => undefined}));
vi.mock('../src/new-counts', async original => ({...await original<typeof import('../src/new-counts')>(), useNewCounts: () => ({projects: {}, bots: {}, dm: {}})}));
vi.mock('../src/pending-groups', () => ({usePendingGroups: () => []}));

const agentId = agentIdSchema.parse('cli_schedule');
const [first, second] = [groupIdSchema.parse('oc_first'), groupIdSchema.parse('oc_second')];
const [firstMember, secondMember] = [membershipIdSchema.parse('first'), membershipIdSchema.parse('second')];
const snapshot = {
  revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'}, jobs: [],
  application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/test'},
  agents: [{id: agentId, name: '研发助手', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [{id: first, name: '研发群'}, {id: second, name: '运营群'}],
  memberships: [[firstMember, first], [secondMember, second]].map(([id, groupId]) => ({id, agentId, groupId, name: String(id), directory: '/tmp/x', backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'full', member: 'qa', network: false}, stale: false})),
} as unknown as DesktopSnapshot;

type Element = ReactElement<Record<string, any>>;
/** Every element in the tree, including those passed in props other than children. */
function nodes(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...Object.values(node.props).flatMap(nodes)];
}
const DesktopApp = (App() as Element).props.children.props.children.type as () => ReactNode;
function render() {
  h.si = 0; h.ri = 0; h.ei = 0;
  const all = nodes(DesktopApp());
  for (const effect of h.pending.splice(0)) effect();
  return {find: <P,>(type: (props: P) => unknown) => all.filter(node => node.type === type) as Array<ReactElement<P & Record<string, any>>>, all};
}
afterEach(() => {vi.unstubAllGlobals();});

it('opens a group page on its 任务 tab from the Bot page\'s 任务 pane, and Back returns to that pane', () => {
  vi.stubGlobal('window', {addEventListener: () => {}, removeEventListener: () => {}});
  vi.stubGlobal('document', {documentElement: {dataset: {}}});
  h.client.watchSnapshots = listener => {listener(snapshot); return () => {};};
  render();
  render().find(AppShell)[0]!.props.onOpenList('agents');
  render().find(BotListRow)[0]!.props.onSelect();
  // The Bot page's tabs, opened on 群聊.
  render().all.find(node => node.props.onSelect && node.props.selected === 'groups')!.props.onSelect({kind: 'schedule'});
  render().find(BotSchedules)[0]!.props.onOpen(secondMember);
  const page = render();
  expect(page.find(GroupWorkspace).map(node => [node.props.member.id, node.props.initialTab])).toEqual([[secondMember, 'schedule']]);
  page.find(AppShell)[0]!.props.onBack();
  expect(render().find(BotSchedules).map(node => node.props.agentId)).toEqual([agentId]);
});

it('keeps the web\'s brand: without the shell\'s devices, App gives the header no device switcher', () => {
  vi.stubGlobal('window', {addEventListener: () => {}, removeEventListener: () => {}});
  vi.stubGlobal('document', {documentElement: {dataset: {}}});
  h.client.watchSnapshots = listener => {listener(snapshot); return () => {};};
  render();
  const shell = render().find(AppShell);
  expect(shell).toHaveLength(1);
  // AppShell shows the brand only when this is undefined: an element that renders nothing would leave the top-left empty.
  expect(shell[0]!.props.deviceSwitcher).toBeUndefined();
});
