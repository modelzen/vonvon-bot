import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, type DesktopSnapshot} from '@vonvon/protocol';
import {App} from '../src/App';
import {BotListRow} from '../src/BotListRow';
import {BotConnectionSettings} from '../src/setup/GrantStep';
import {RegistrationDialog} from '../src/setup/RegistrationDialog';
import {WelcomeSetup} from '../src/setup/WelcomeSetup';
import {ProviderManager} from '../src/setup/ProviderSetup';
import {UsagePanel} from '../src/management/UsagePanel';
import {DiagnosticsPanel} from '../src/management/DiagnosticsPanel';
import {AppShell} from '../src/LocalShell';
import {SearchDialog} from '../src/SearchDialog';
import {AccountPanel} from '../src/accounts/AccountPanel';
import {SnapshotPendingView} from '../src/devices/DeviceConnectionView';


// DesktopApp is called as a plain function: hooks keep their values by call order, effects run when their deps change.
const h = vi.hoisted(() => ({state: [] as unknown[], refs: [] as Array<{current: unknown}>, effects: [] as Array<{deps?: unknown[]}>, si: 0, ri: 0, ei: 0, pending: [] as Array<() => void>,
  listener: (_snapshot: DesktopSnapshot) => {}, client: {run: vi.fn(), watchSnapshots: (_listener: (snapshot: unknown) => void) => () => {}},
  accountPage: {isOpen: false, open: vi.fn(), close: vi.fn()}, navigate: vi.fn((action: () => void) => action()),
}));
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
vi.mock('../src/settings/DraftGuard', () => ({DraftGuardProvider: () => null, useDraftGuard: () => ({navigate: h.navigate})}));
vi.mock('../src/desktop-update', () => ({DesktopUpdateProvider: () => null, useDesktopUpdate: () => [undefined]}));
vi.mock('../src/accounts/account-page', () => ({useAccountPage: () => h.accountPage}));
vi.mock('../src/new-counts', async original => ({...await original<typeof import('../src/new-counts')>(), useNewCounts: () => ({projects: {}, bots: {}, dm: {}})}));
vi.mock('../src/pending-groups', () => ({usePendingGroups: () => []}));
vi.mock('../src/management/SecretsPanel', async original => ({...await original<typeof import('../src/management/SecretsPanel')>(), useSecrets: () => ({read: {kind: 'loading'}, reader: {read: vi.fn()}})}));
vi.mock('../src/setup/useSetupStatus', () => ({useSetupStatus: () => ({reads: {}, recheck: vi.fn()})}));
vi.mock('../src/setup/useClaudeLoginCheck', () => ({useClaudeLoginCheck: () => ({checking: false, check: vi.fn()})}));



const first = agentIdSchema.parse('cli_first');
const second = agentIdSchema.parse('cli_second');
const snapshot: DesktopSnapshot = {
  revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'}, jobs: [],
  application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/test'},
  agents: [first, second].map((id, i) => ({id, name: `Bot ${i + 1}`, enabled: true, running: true, connection: 'connected', activation: 'active'})),
  groups: [], memberships: [], tools: [],
};
type Element = ReactElement<Record<string, any>>;
function nodes(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...Object.values(node.props).flatMap(nodes)];
}
const DesktopApp = (App() as Element).props.children.props.children.type as () => ReactNode;
function render() {
  h.si = h.ri = h.ei = 0;
  const all = nodes(DesktopApp());
  for (const effect of h.pending.splice(0)) effect();
  return {find: <P,>(type: (props: P) => unknown) => all.filter(node => node.type === type) as Array<ReactElement<P & Record<string, any>>>, all};
}
function component(make: () => ReactNode) {
  const saved = {state: h.state, refs: h.refs, si: h.si, ri: h.ri};
  h.state = []; h.refs = []; h.si = h.ri = 0;
  try {return nodes(make());} finally {Object.assign(h, saved);}
}
const flush = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
beforeEach(() => {
  h.state = []; h.refs = []; h.effects = []; h.pending = [];
  h.accountPage.isOpen = false;
  h.accountPage.open.mockClear().mockImplementation(() => {h.accountPage.isOpen = true;});
  h.accountPage.close.mockClear().mockImplementation(() => {h.accountPage.isOpen = false;});
  h.navigate.mockReset().mockImplementation(action => action());
  vi.stubGlobal('window', {addEventListener: () => {}, removeEventListener: () => {}});
  vi.stubGlobal('HTMLDetailsElement', class {});
  vi.stubGlobal('document', {documentElement: {dataset: {}}, getElementById: () => ({parentElement: null, querySelectorAll: () => [], scrollIntoView: () => {}, matches: () => true, focus: () => {}})});
  h.client.run.mockReset().mockResolvedValue({kind: 'started', jobId: 'register_test'});
  h.client.watchSnapshots = listener => {h.listener = listener; listener(snapshot); return () => {};};
  render();
});
afterEach(() => vi.unstubAllGlobals());

it('keeps account settings open when a gated device reconnects and its snapshot arrives', () => {
  h.state = []; h.refs = []; h.effects = []; h.pending = [];
  h.accountPage.isOpen = true;
  expect(render().find(SnapshotPendingView)).toHaveLength(1);
  const connected = render();
  expect(connected.find(AppShell)[0]!.props.page).toBe('account');
  expect(connected.find(AccountPanel)).toHaveLength(1);
  connected.find(AppShell)[0]!.props.onNavigate('settings');
  expect(h.accountPage.isOpen).toBe(false);
  expect(render().find(AppShell)[0]!.props.page).toBe('settings');
});

it('waits for the existing draft guard before opening global account settings', () => {
  let leave: (() => void) | undefined;
  h.navigate.mockImplementation(action => {leave = action;});
  render().find(AppShell)[0]!.props.onNavigate('account');
  expect(h.accountPage.isOpen).toBe(false);
  expect(h.accountPage.open).not.toHaveBeenCalled();
  leave!();
  expect(h.accountPage.isOpen).toBe(true);
  expect(render().find(AccountPanel)).toHaveLength(1);
});

it('opens Codex Provider from usage rather than the tools page', () => {
  render().find(AppShell)[0]!.props.onNavigate('usage');
  render().find(UsagePanel)[0]!.props.onOpenProviders();
  const page = render();
  expect(page.find(AppShell)[0]!.props.page).toBe('providers');
  expect(page.find(ProviderManager)[0]!.props.reveal).toBe('codex');
});

it.each(['codex', 'claude'] as const)('opens the requested %s Provider from diagnostics', provider => {
  render().find(AppShell)[0]!.props.onNavigate('diagnostics');
  render().find(DiagnosticsPanel)[0]!.props.onOpenProviders(provider);
  const page = render();
  expect(page.find(AppShell)[0]!.props.page).toBe('providers');
  expect(page.find(ProviderManager)[0]!.props.reveal).toBe(provider);
});

it('retains the second Bot from its settings, and clears the target on global entry', () => {
  render().find(AppShell)[0]!.props.onOpenList('agents');
  render().find(BotListRow)[1]!.props.onSelect();
  render().all.find(node => node.props.onSelect && node.props.selected === 'groups')!.props.onSelect({kind: 'settings'});
  const connection = render().find(BotConnectionSettings)[0]!;
  expect(connection.props.agent.id).toBe(second);
  connection.props.onSetup();
  expect(render().find(WelcomeSetup)[0]!.props.initialAgentId).toBe(second);
  render().find(AppShell)[0]!.props.onNavigate('settings');
  render().find(AppShell)[0]!.props.onNavigate('setup');
  expect(render().find(WelcomeSetup)[0]!.props.initialAgentId).toBeUndefined();
});

it('retains the Bot selected by diagnostics', () => {
  render().find(AppShell)[0]!.props.onNavigate('diagnostics');
  render().find(DiagnosticsPanel)[0]!.props.onOpenSetup(second);
  expect(render().find(WelcomeSetup)[0]!.props.initialAgentId).toBe(second);
});

it('checks the newly registered Bot even if another Bot precedes it in the snapshot', async () => {
  render().find(AppShell)[0]!.props.onNavigate('setup');
  render().find(WelcomeSetup)[0]!.props.onRegister();
  await flush();
  h.listener({...snapshot, jobs: [{id: 'register_test', type: 'registerAgent', phase: 'succeeded', agentId: second}] as DesktopSnapshot['jobs']});
  const dialog = render().find(RegistrationDialog)[0]!;
  expect(dialog.props.modal.agentId).toBe(second);
  // Exercise the actual dialog button as well as its App callback.
  const content = component(() => RegistrationDialog(dialog.props));
  const check = content.find(node => node.props.onClick && Array.isArray(node.props.children) && node.props.children[0] === '检查连接')!;
  check.props.onClick();
  expect(render().find(WelcomeSetup)[0]!.props.initialAgentId).toBe(second);
  expect(render().find(RegistrationDialog)).toHaveLength(0);
});


it('the diagnostic buttons themselves supply their Provider and Bot targets', () => {
  render().find(AppShell)[0]!.props.onNavigate('diagnostics');
  const props = render().find(DiagnosticsPanel)[0]!.props;
  // Missing providers expose the installation/configuration navigation action.
  const diagnostics = component(() => DiagnosticsPanel(props));
  for (const provider of ['Codex', 'Claude']) {
    const row = diagnostics.find(node => node.props.title === provider && node.props.trailing)!;
    const button = nodes(row.props.trailing).find(node => node.props.onClick)!;
    button.props.onClick();
    expect(render().find(ProviderManager)[0]!.props.reveal).toBe(provider.toLowerCase());
  }
  const bot = diagnostics.find(node => node.props.agent?.id === second && node.props.onOpenSetup)!;
  const content = component(() => (bot.type as (props: any) => ReactNode)(bot.props));
  const check = content.find(node => node.props.onClick && node.props.children === '检查连接')!;
  check.props.onClick();
  expect(render().find(WelcomeSetup)[0]!.props.initialAgentId).toBe(second);
});


it('does not feed open mutations back into search while a path field loads, then focuses it', () => {
  const queued: Array<() => void> = [];
  const observers: Observer[] = [];
  let callbacks = 0;
  class Observer {
    active = false;
    constructor(readonly callback: () => void) {observers.push(this);}
    observe() {this.active = true;}
    disconnect() {this.active = false;}
    notify() {if (this.active) queued.push(() => {if (this.active) {callbacks++; this.callback();}});}
  }
  function mutate() {for (const observer of observers) observer.notify();}
  function deliver() {
    // Real MutationObserver delivery would starve rendering forever if each callback writes `open` again.
    let turns = 0;
    while (queued.length) {
      if (++turns > 10) throw new Error('search MutationObserver is feeding its own open mutations');
      queued.shift()!();
    }
  }
  class Details {
    value = false;
    writes = 0;
    constructor(readonly parentElement: Details | null = null) {}
    get open() {return this.value;}
    set open(value: boolean) {
      this.value = value;
      this.writes++;
      // Reflected HTML attributes emit mutations even when their value is unchanged.
      mutate();
    }
    closest(selector: string) {return selector === 'details' ? this : null;}
  }
  const advanced = new Details();
  const nested = new Details(advanced);
  let loaded = false;
  let hidden = true;
  const focus = vi.fn();
  const row = {
    dataset: {searchTitle: '已保存路径'},
    closest: (selector: string) => selector === 'details' ? nested : hidden ? {} : null,
    querySelector: () => null, scrollIntoView: vi.fn(), matches: () => false, focus,
  };
  const section = {parentElement: advanced, querySelectorAll: (selector: string) => loaded && selector === '[data-search-title]' ? [row] : []};
  vi.stubGlobal('HTMLDetailsElement', Details);
  vi.stubGlobal('MutationObserver', Observer);
  vi.stubGlobal('document', {documentElement: {dataset: {}}, body: {}, getElementById: () => section});
  vi.stubGlobal('window', {addEventListener: () => {}, removeEventListener: () => {}, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn()});
  h.listener({...snapshot, agents: []});
  render().find(AppShell)[0]!.props.onSearch();
  const search = render().find(SearchDialog)[0]!;
  search.props.onSelect(search.props.entries.find(entry => entry.title === '已保存路径')!);
  render();
  expect(advanced.open).toBe(true);
  expect(advanced.writes).toBe(1);
  expect(focus).not.toHaveBeenCalled();
  // A loading-state DOM update must not write the already-open ancestor again.
  mutate(); deliver();
  expect(advanced.writes).toBe(1);
  expect(observers[0]!.active).toBe(true);
  // Also cover the inner disclosure loop when the field exists but is still hidden.
  loaded = true;
  mutate(); deliver();
  expect(nested.open).toBe(true);
  expect(nested.writes).toBe(1);
  expect(focus).not.toHaveBeenCalled();
  hidden = false;
  mutate(); deliver();
  expect(focus).toHaveBeenCalledExactlyOnceWith({preventScroll: true});
  expect(advanced.writes).toBe(1);
  expect(nested.writes).toBe(1);
  expect(observers[0]!.active).toBe(false);
  expect(callbacks).toBeLessThan(6);
});
