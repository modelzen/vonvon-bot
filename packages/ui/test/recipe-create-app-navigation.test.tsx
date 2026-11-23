// @vitest-environment jsdom
import {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {accountStatusSchema, desktopSnapshotSchema, type AccountStatus} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {App} from '../src/App';
import {AccountProvider} from '../src/account-context';
import {AccountPageProvider, useAccountPage} from '../src/accounts/account-page';
import {ClientProvider} from '../src/client-context';
import {CommunityProvider} from '../src/community/community-context';
import {DirectoryPickerProvider} from '../src/directory-picker';
import {DraftGuardProvider, useDraft} from '../src/settings/DraftGuard';

const accountId = '11111111-1111-4111-8111-111111111111';
const navigationId = '22222222-2222-4222-8222-222222222222';
const nextNavigationId = '33333333-3333-4333-8333-333333333333';
const signedIn = accountStatusSchema.parse({kind: 'signedIn', accountId, displayName: '配方作者', provider: 'github', persistence: 'memory'});
const snapshot = desktopSnapshotSchema.parse({revision: 1, observedAt: 1, stale: false,
  host: {kind: 'connected', ownership: 'attached', version: '0.10.1'}, jobs: [], tools: [],
  agents: [{id: 'cli_author', name: '创作 Bot', tenant: 'feishu', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [{id: 'oc_author', name: '来源群聊'}],
  memberships: [{id: JSON.stringify(['cli_author', 'oc_author']), agentId: 'cli_author', groupId: 'oc_author', name: '来源群聊', directory: '/tmp/synthetic-create', backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'full', member: 'full', network: false}, stale: false, enabled: true}],
  application: {platform: 'linux', version: '0.10.1', loginItem: false, dataPath: '/tmp/synthetic-create'},
});
let root: Root;
let emit: (value: unknown) => void;
let status: AccountStatus;
let accountOpen: boolean;
let acknowledgements: unknown[];
let writes: unknown[];
let facade: ReturnType<typeof createDesktopFacades>;

function PendingEdit() {
  const [dirty, setDirty] = useState(false);
  useDraft(dirty, {title: '本地配置', discard: () => setDirty(false)});
  accountOpen = Boolean(useAccountPage()?.isOpen);
  return <button onClick={() => setDirty(true)}>{dirty ? '保留中的本地修改' : '修改本地配置'}</button>;
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label || element.querySelector('strong')?.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function draw() {
  await act(async () => root.render(<AccountProvider account={facade.shell.account}><AccountPageProvider>
    <ClientProvider client={facade.client} shell={facade.shell}><DraftGuardProvider><CommunityProvider shell={facade.shell.community}>
      <PendingEdit/><DirectoryPickerProvider><App/></DirectoryPickerProvider>
    </CommunityProvider></DraftGuardProvider></ClientProvider>
  </AccountPageProvider></AccountProvider>));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('IntersectionObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  localStorage.clear(); status = signedIn; accountOpen = false; acknowledgements = []; writes = [];
  const success = (value: unknown) => ({ok: true, value});
  facade = createDesktopFacades({receive: listener => {emit = listener; return () => {};}, invoke: async (channel, ...args) => {
    if (channel === desktopChannels.subscribe || channel === desktopChannels.close) return success(undefined);
    if (channel === desktopChannels.accountStatus) return success(status);
    if (channel === desktopChannels.snapshot) return success(snapshot);
    if (channel === desktopChannels.recipePreviewPending || channel === desktopChannels.groupNavigationPending) return success([]);
    if (channel === desktopChannels.recipePreviewAcknowledge) {acknowledgements.push(args[0]); return success(undefined);}
    if (channel === desktopChannels.memory) return success({kind: 'newCounts', projects: {}, bots: {}, dm: {}});
    if (channel === desktopChannels.run) return success({kind: 'pendingGroups', groups: []});
    if (channel === desktopChannels.admin) return success({kind: 'judgeUsage', days: [], unreadBots: 0});
    if (channel === desktopChannels.environment) return success({kind: 'backends', entries: []});
    if (channel === desktopChannels.community) return success({hero: null, items: [], nextCursor: null});
    if (channel === desktopChannels.recipeSource) return success({source: null});
    writes.push({channel, args});
    throw new Error('Unexpected desktop request ' + channel);
  }});
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks();});

async function openAccount() {
  await draw(); await click('设置'); await click(status.kind === 'signedIn' ? status.displayName : '账号');
  expect(document.querySelector('.account-panel h1')?.textContent).toBe('账号');
  expect(accountOpen).toBe(true);
}
function creation(id = navigationId) {emit({type: 'recipePreview', value: {kind: 'create', navigationId: id}});}
function expectChooser() {
  expect(document.querySelector('.account-panel')).toBeNull();
  expect(document.querySelector('[aria-label="配方来源 Bot"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="配方来源群聊"]')).not.toBeNull();
  expect(accountOpen).toBe(false);
  expect(writes).toEqual([]);
}

it('leaves the real account page for a live website creation request before acknowledging it', async () => {
  await openAccount();
  await act(async () => creation());
  expectChooser();
  expect(acknowledgements).toEqual([navigationId]);
});

it('keeps the account page and local edits until the real draft guard permits the creation request', async () => {
  await openAccount(); await click('修改本地配置');
  await act(async () => creation());
  expect(accountOpen).toBe(true);
  expect(document.querySelector('.account-panel')).not.toBeNull();
  expect(document.body.textContent).toContain('有未保存的修改');
  expect(acknowledgements).toEqual([]);
  await click('继续编辑');
  expect(accountOpen).toBe(true);
  expect(document.body.textContent).toContain('保留中的本地修改');
  expect(acknowledgements).toEqual([navigationId]);
  await act(async () => creation(nextNavigationId));
  expect(acknowledgements).toEqual([navigationId]);
  await click('放弃并离开');
  expectChooser();
  expect(acknowledgements).toEqual([navigationId, nextNavigationId]);
});

it('leaves a signed-out account page for creation login and resumes the same chooser after login', async () => {
  status = {kind: 'signedOut'};
  await openAccount();
  await act(async () => creation());
  expect(document.querySelector('.account-panel')).toBeNull();
  expect(accountOpen).toBe(false);
  expect(document.body.textContent).toContain('登录后可以');
  expect(document.querySelector('[aria-label="配方来源 Bot"]')).toBeNull();
  expect(acknowledgements).toEqual([]);
  await act(async () => emit({type: 'account', value: signedIn}));
  expectChooser();
  expect(acknowledgements).toEqual([navigationId]);
  await act(async () => emit({type: 'account', value: {...signedIn, accountId: nextNavigationId}}));
  expect(document.querySelector('[aria-label="配方来源 Bot"]')).toBeNull();
});
