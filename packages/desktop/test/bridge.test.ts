import { RecipePreviewNavigation } from '../src/recipe-preview-navigation.js';
import { EventEmitter, once } from 'node:events';
import type { Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { VonvonClient } from '@vonvon/client/browser';
import { ConnectionError, RpcError } from '@vonvon/client/browser';
import { agentIdSchema, groupIdSchema, type DevicesState, type RecipeAuthoringRequest, type RecipeAuthoringReply, type AccountStatus } from '@vonvon/protocol';
import { clientChannelNames, desktopChannels, type AttachedDaemon, type DesktopEvent, type DesktopResources } from '../src/ipc-contract.js';
import { DeviceConnectionsError, type DeviceConnections, type ViewChange } from '../src/connections.js';
import { ServiceActionError } from '../src/service-error.js';
import { StartHostRefusal } from '../src/daemon-manager.js';
import { DesktopUpdateError } from '../src/updates.js';
import {RecipeCreatorSupervisor} from '../src/recipe-creator-supervisor.js';

const { handlers, openExternal, failRegistration } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  openExternal: vi.fn(async (_url: string) => {}),
  failRegistration: { channel: '' },
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => {
      if (name === failRegistration.channel) throw new Error('registration failed');
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => { handlers.delete(name); },
  },
  shell: { openExternal },
}));

import { installBridge, openAllowedExternal, sanitizeDaemonMessage } from '../src/bridge.js';
import { createDesktopFacades } from '../src/facade.js';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'vonvon-bridge-test-'));
const uiIndex = join(fixtureRoot, 'index.html');
writeFileSync(uiIndex, '<!doctype html><title>Bridge test</title>');
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const clientChannels = new Set<string>(clientChannelNames.map(name => desktopChannels[name]));
const REMOTE_A = '11111111-1111-4111-8111-111111111111';
const REMOTE_B = '22222222-2222-4222-8222-222222222222';

/** The connections as the bridge sees them: a view to switch by hand, a list with two remote devices. */
function fakeDevices() {
  let current: ViewChange = { kind: 'local' };
  const viewListeners = new Set<(change: ViewChange) => void>();
  const stateListeners = new Set<(state: DevicesState) => void>();
  const activeId = (): string => current.kind === 'local' ? 'local' : current.kind === 'remote' ? current.session.id : current.id;
  const state = (): DevicesState => ({
    v: 1, revision: 1, client: { version: '1', protocolVersion: 2 }, registry: 'ok', secureStorage: true,
    devices: [
      { id: 'local', name: '这台电脑', current: activeId() === 'local', status: 'online', routes: [] },
      { id: REMOTE_A, name: '机房', current: activeId() === REMOTE_A, status: 'online', routes: [{ host: '203.0.113.10', port: 7767, kind: 'public' }] },
      { id: REMOTE_B, name: '书房', current: activeId() === REMOTE_B, status: 'online', routes: [{ host: '203.0.113.11', port: 7767, kind: 'public' }] },
    ],
    active: { id: activeId(), phase: 'ready', attempt: 0 },
  });
  const devices = {
    state: vi.fn(state),
    onState: (listener: (value: DevicesState) => void) => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },
    onView: (listener: (change: ViewChange) => void) => { viewListeners.add(listener); return () => { viewListeners.delete(listener); }; },
    view: () => current,
    retainSource: vi.fn(async () => { throw new Error('retained sources are outside this bridge fixture'); }),
    switchTo: vi.fn(async (_id: string) => {}),
    retry: vi.fn(), wake: vi.fn(),
    inspectLink: vi.fn((_text: string) => ({ ok: false as const, code: 'invalid_link' as const })),
    add: vi.fn(async (_request: unknown) => ({ kind: 'failed' as const, code: 'busy', attempts: [] })),
    cancelAdd: vi.fn(),
    rename: vi.fn(async (_id: string, _name: string) => {}),
    remove: vi.fn(async (_id: string) => ({ revokedRemotely: false })),
    setLocal: vi.fn(), expect: vi.fn(), dispose: vi.fn(async () => {}),
  } satisfies DeviceConnections;
  return {
    devices,
    /** Says a view change as the connections do, then lets the bridge's awaits run. */
    async show(change: ViewChange) {
      current = change;
      for (const listener of [...viewListeners]) listener(change);
      await settle();
    },
    emitState() { for (const listener of [...stateListeners]) listener(state()); },
  };
}
const settle = async (): Promise<void> => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

/** A remote device's client: its own snapshots, requests and losses. */
function remoteClient(revision = 3) {
  const errors = new Set<(error: Error) => void>();
  let emitSnapshot: (value: unknown) => void = () => {};
  const client = {
    snapshot: vi.fn(async () => ({ revision, application: { platform: 'linux', version: '1', loginItem: false, dataPath: '/srv/vonvon' } })),
    settings: vi.fn(async () => ({ kind: 'settings' })),
    machine: vi.fn(async (request: { type: string }) => request.type === 'status' ? { type: 'status', remote: true } : { type: 'done', message: 'remote' }),
    run: vi.fn(async () => ({ kind: 'applied', revision: 4 })),
    admin: vi.fn(async () => ({ kind: 'daemonStatus' })),
    watchSnapshots: (listener: (value: unknown) => void) => { emitSnapshot = listener; return () => { emitSnapshot = () => {}; }; },
    onLog: () => () => {}, onBackendInstall: () => () => {}, onDevice: () => () => {},
    onError(listener: (error: Error) => void) { errors.add(listener); return () => { errors.delete(listener); }; },
  };
  return {
    client: client as unknown as VonvonClient, calls: client,
    emitSnapshot: (value: unknown) => emitSnapshot(value),
    emitError: (error: Error) => { for (const listener of [...errors]) listener(error); },
  };
}
const remoteView = (id: string, remote: ReturnType<typeof remoteClient>, mode: 'full' | 'maintenance' = 'full'): ViewChange => ({
  kind: 'remote', cause: 'opened',
  session: { id, client: remote.client, mode, serverInfo: { type: 'serverInfo', machineId: id, version: '1', protocolVersion: 2 } },
});

function harness() {
  const expectedUrl = pathToFileURL(realpathSync(uiIndex)).href;
  const frame = { url: expectedUrl };
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const errorListeners = new Set<(error: Error) => void>();
  const deviceListeners = new Set<(value: unknown) => void>();
  let onSnapshot: (value: unknown) => void = () => {};
  const snapshot = vi.fn(async () => ({ revision: 1, application: { platform: 'macos', version: '1', loginItem: false, dataPath: fixtureRoot } }));
  const machine = vi.fn(async (_request: Parameters<VonvonClient['machine']>[0]): ReturnType<VonvonClient['machine']> => ({ type: 'done', message: 'ok' }));
  const dispose = vi.fn(async () => {});
  const run = vi.fn(async (): ReturnType<VonvonClient['run']> => ({ kind: 'applied', revision: 2 }));
  const schedule = vi.fn(async (_botId: string, _request: unknown): ReturnType<VonvonClient['schedule']> => ({ kind: 'tasks', tasks: [], now: 1, timeZone: 'UTC' }));
  const device = vi.fn(async (_request: unknown): ReturnType<VonvonClient['device']> => ({ kind: 'clients', generation: 0, clients: [] }));
  const client = {
    snapshot, machine, run, schedule, device,
    watchSnapshots: (listener: (value: unknown) => void) => { onSnapshot = listener; return () => { onSnapshot = () => {}; }; },
    onLog: () => () => {},
    onBackendInstall: () => () => {},
    onDevice(listener: (value: unknown) => void) { deviceListeners.add(listener); return () => { deviceListeners.delete(listener); }; },
    onError(listener: (error: Error) => void) { errorListeners.add(listener); return () => { errorListeners.delete(listener); }; },
  } as unknown as VonvonClient;
  const owner: AttachedDaemon = {
    client, identity: { pid: 1, startedAt: 'now', listen: '127.0.0.1:4000' }, dispose,
    serverInfo: { type: 'serverInfo', machineId: '00000000-0000-4000-8000-000000000000', version: '1', protocolVersion: 2 },
  };
  const paths: DesktopResources = { uiIndex, preload: '/unused', trayPng: '/unused' };
  const actions = {
    startHost: vi.fn(async (_bot?: string) => ({ type: 'done' as const, message: 'started' })),
    restartHost: vi.fn(async (_previous: AttachedDaemon['identity'], send: () => ReturnType<VonvonClient['run']>) => send()),
    stopHost: vi.fn(async (_previous: AttachedDaemon['identity'], send: () => ReturnType<VonvonClient['machine']>) => send()),
    service: vi.fn(async (_action: 'install' | 'start' | 'stop' | 'uninstall', _previous?: AttachedDaemon['identity'] | null) => ({ type: 'done' as const, message: 'service updated' })),
    setLoginItem: vi.fn(async (_enabled: boolean, _previous?: AttachedDaemon['identity'] | null) => {}),
    isExpectedDisconnect: vi.fn(() => false),
    recoverConnection: vi.fn((_lost: AttachedDaemon['identity']) => false),
    repairCli: vi.fn(async () => ({ type: 'done' as const, message: 'installed' })),
    observeCli: vi.fn(async () => ({ kind: 'error' as const, message: 'not registered' })),
    chooseExecutablePath: vi.fn(async (): Promise<string | null> => '/usr/local/bin/codex'),
    chooseDirectoryPaths: vi.fn(async (_multiple: boolean): Promise<string[] | null> => ['/tmp/workspace', '/tmp/docs']),
    checkDesktopUpdate: vi.fn(async () => ({ state: 'available' as const, current: '1.0.0', latest: '1.1.0', message: 'ready' })),
    retryDesktopUpdate: vi.fn(async () => ({ state: 'available' as const, current: '1.0.0', latest: '1.1.0', message: 'retried' })),
    installDesktopUpdate: vi.fn(async () => ({ state: 'downloaded' as const, current: '1.0.0', latest: '1.1.0', message: 'ready' })),
    hide: vi.fn(), confirmQuit: vi.fn(async () => {}), connectionLost: vi.fn(), quitKeepsDaemon: vi.fn(async () => true),
  };
  const devs = fakeDevices();
  const account = {
    status: () => ({ kind: 'signedOut' as const }), login: vi.fn(async () => ({ kind: 'signingIn' as const })),
    cancelLogin: vi.fn(async () => ({ kind: 'signedOut' as const })), logout: vi.fn(async () => ({ kind: 'signedOut' as const })),
    onStatus: vi.fn(() => () => {}), request: vi.fn(), dispose: vi.fn(),
  };
  const recipePreview = new RecipePreviewNavigation('vonvon-preview');
  const bridge = installBridge(owner, window, paths, actions, devs.devices, account, undefined, undefined, recipePreview);
  /** As the page sends it: a channel to a daemon gets the view last, 'current' unless said. */
  const invokeAs = (view: string, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler ${channel}`);
    return handler(event, ...args, ...(clientChannels.has(channel) ? [view] : []));
  };
  const invoke = (channel: string, ...args: unknown[]) => invokeAs('current', channel, ...args);
  return { bridge, recipePreview, account, event, frame, webContents, window, paths, invoke, invokeAs, snapshot, machine, run, schedule, device, dispose, actions, owner, devs,
    /** What the page was sent, leaving out the device list it gets on every subscribe and change. */
    events: (): DesktopEvent[] => webContents.send.mock.calls.map(call => call[1] as DesktopEvent).filter(value => value.type !== 'devices' && value.type !== 'account'),
    emitSnapshot: (value: unknown) => onSnapshot(value),
    emitDevice: (value: unknown) => { for (const listener of [...deviceListeners]) listener(value); },
    emitError: (error: Error) => { for (const listener of [...errorListeners]) listener(error); } };
}

beforeEach(() => { handlers.clear(); openExternal.mockClear(); failRegistration.channel = ''; });

describe('desktop IPC boundary', () => {
  it('routes explicit publication preparation and confirmation through the same restricted authoring channel', async () => {
    const prepare = vi.spyOn(RecipeCreatorSupervisor.prototype, 'preparePublication').mockResolvedValue({kind: 'publicationReady', reviewId: REMOTE_B, draftId: REMOTE_A, revision: 1, public: {name: '配方', summary: '', overview: '', version: '1.0', access: 'direct'}});
    const confirm = vi.spyOn(RecipeCreatorSupervisor.prototype, 'confirmPublication').mockResolvedValue({kind: 'publicationResult', result: {kind: 'pending'}});
    const invalidate = vi.spyOn(RecipeCreatorSupervisor.prototype, 'invalidateReviews');
    const h = harness();
    try {
      const input = {type: 'preparePublication', accountId: REMOTE_B, draft: {draftId: REMOTE_A, recipeId: null, revision: 1, public: {name: '配方', summary: '', overview: '', version: '1.0', access: 'direct'}, config: {role: '角色'}}};
      const handler = handlers.get(desktopChannels.recipeAuthoring)!;
      expect(await handler({...h.event, senderFrame: {...h.frame}} as IpcMainInvokeEvent, input)).toMatchObject({ok: false});
      expect(await h.invoke(desktopChannels.recipeAuthoring, {...input, publish: true})).toMatchObject({ok: false});
      expect(prepare).not.toHaveBeenCalled();
      expect(await h.invoke(desktopChannels.recipeAuthoring, input)).toMatchObject({ok: true, value: {kind: 'publicationReady'}});
      expect(prepare).toHaveBeenCalledWith(input);
      expect(confirm).not.toHaveBeenCalled();
      const confirmation = {type: 'confirmPublication', accountId: REMOTE_B, reviewId: REMOTE_B};
      expect(await h.invoke(desktopChannels.recipeAuthoring, confirmation)).toEqual({ok: true, value: {kind: 'publicationResult', result: {kind: 'pending'}}});
      expect(confirm).toHaveBeenCalledWith(confirmation);
      invalidate.mockClear();
      h.recipePreview.open('vonvon-preview://recipes/drafts/' + REMOTE_A + '?revision=1');
      expect(invalidate).toHaveBeenCalledOnce();
      h.webContents.emit('did-start-navigation', {isMainFrame: true, isSameDocument: false, url: h.frame.url});
      expect(invalidate).toHaveBeenCalledTimes(2);
    } finally {
      await h.bridge.dispose();
      prepare.mockRestore(); confirm.mockRestore(); invalidate.mockRestore();
    }
  });
  it('exposes locator-only navigation to the exact local main frame and preserves unacknowledged delivery', async () => {
    const h = harness();
    h.recipePreview.open('vonvon-preview://recipes/drafts/8d85af21-e80d-4665-a6b8-ccf162dc1923?revision=2');
    const [navigation] = h.recipePreview.pending();
    expect(await h.invoke(desktopChannels.recipePreviewPending)).toEqual({ok: true, value: [navigation]});
    expect(await h.invoke(desktopChannels.recipePreviewPending, 'publish')).toMatchObject({ok: false});
    const handler = handlers.get(desktopChannels.recipePreviewAcknowledge)!;
    const wrongFrame = {...h.event, senderFrame: {...h.frame}} as IpcMainInvokeEvent;
    expect(await handler(wrongFrame, navigation.navigationId)).toMatchObject({ok: false});
    expect(await handler({...h.event, sender: {}} as IpcMainInvokeEvent, navigation.navigationId)).toMatchObject({ok: false});
    h.frame.url += '#untrusted';
    expect(await h.invoke(desktopChannels.recipePreviewAcknowledge, navigation.navigationId)).toMatchObject({ok: false});
    h.frame.url = h.frame.url.replace('#untrusted', '');
    expect(h.recipePreview.pending()).toEqual([navigation]);
    await h.invoke(desktopChannels.subscribe);
    h.recipePreview.open('vonvon-preview://recipes/drafts/8d85af21-e80d-4665-a6b8-ccf162dc1923?revision=3');
    expect(h.events()).toContainEqual({type: 'recipePreview', value: expect.objectContaining({revision: 3})});
    expect(await h.invoke(desktopChannels.recipePreviewAcknowledge, {navigationId: navigation.navigationId, publish: true})).toMatchObject({ok: false});
    expect(await h.invoke(desktopChannels.recipePreviewAcknowledge, navigation.navigationId)).toEqual({ok: true, value: undefined});
    expect(h.recipePreview.pending()).toEqual([expect.objectContaining({revision: 3})]);
    expect(h.account.request).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });
  it('uses the local account on a remote view and rejects payloads or untrusted senders', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    expect(h.webContents.send).toHaveBeenCalledWith(desktopChannels.event, { type: 'account', value: { kind: 'signedOut' } });
    await h.devs.show(remoteView(REMOTE_A, remoteClient()));
    expect(await h.invoke(desktopChannels.accountLogin)).toEqual({ ok: true, value: { kind: 'signingIn' } });
    expect(await h.invoke(desktopChannels.accountLogin, 'https://untrusted.example')).toMatchObject({ ok: false });
    h.frame.url = 'https://untrusted.example';
    expect(await h.invoke(desktopChannels.accountLogout)).toMatchObject({ ok: false });
    expect(h.account.login).toHaveBeenCalledTimes(1);
    expect(h.account.logout).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });
  it('forwards a device request and refuses one of no known shape', async () => {
    const h = harness();
    expect([await h.invoke(desktopChannels.device, { type: 'clients' }), await h.invoke(desktopChannels.device, { type: 'revokeClient' })]).toMatchObject([{ ok: true, value: { kind: 'clients' } }, { ok: false }]);
    expect(h.device).toHaveBeenCalledExactlyOnceWith({ type: 'clients' });
    await h.bridge.dispose();
  });
  it('rejects an installation after remote A→B→A or a paired-key change during identity lookup',async()=>{
    for(const transition of ['switch','key']) {
      const h=harness(), remote=remoteClient(), other=remoteClient(), pk=Buffer.alloc(32,4).toString('base64url');
      const accountId='33333333-3333-4333-8333-333333333333', signal=new AbortController();
      Object.assign(h.account,{lease:()=>signal.signal});let paired=pk;
      Object.assign(h.devs.devices,{pairedPublicKey:()=>paired});
      const a=remoteView(REMOTE_A,remote);
      Object.assign(remote.client,{device:async()=>{
        if(transition==='switch'){await h.devs.show(remoteView(REMOTE_B,other));await h.devs.show(a);} else paired='changed';
        return {kind:'deviceStatus',status:{device:{id:REMOTE_A,name:'test',publicKey:pk},remote:{port:3000,addresses:[]},clients:{total:1,active:1}}};
      }});
      await h.devs.show(a);
      expect(await h.invoke(desktopChannels.recipeUse,{type:'begin',accountId,viewId:REMOTE_A,botId:'cli_fixture',groupId:'oc_fixture',
        recipeId:'44444444-4444-4444-8444-444444444444',versionId:'55555555-5555-4555-8555-555555555555'})).toMatchObject({ok:false});
      expect(h.account.request).not.toHaveBeenCalled();await h.bridge.dispose();
    }
  });
  it('links through the scoped shell, discards stale account generations, and never exposes raw device RPC', async () => {
    const h = harness();
    const accountId = REMOTE_A, session = REMOTE_B, botId = agentIdSchema.parse('cli_fixture');
    const groupId = groupIdSchema.parse('oc_fixture');
    const challengeId = '33333333-3333-4333-8333-333333333333', evidence = 'a'.repeat(64);
    let generation = new AbortController();
    const status: AccountStatus = {kind:'signedIn',accountId,displayName:'写作者',provider:'google',persistence:'memory'};
    const calls: RecipeAuthoringRequest[] = [];
    Object.assign(h.account,{status:() => status, lease:(id:string) => id === accountId ? generation.signal : undefined});
    h.account.request.mockImplementation(async (_id:string, path:string) => {
      expect(path).toBe('/v1/me');
      return Response.json({accountId});
    });
    Object.assign(h.owner.client, {
      device:async () => ({kind:'deviceStatus',status:{device:{id:REMOTE_A,name:'本机',publicKey:Buffer.alloc(32,4).toString('base64url')},
        remote:{addresses:[],port:3000},clients:{active:1,total:1}}}),
      snapshot:async () => ({agents:[{id:botId,name:'助手'}],groups:[{id:groupId,name:'产品群'}],memberships:[{agentId:botId,groupId}]}),
      recipeAuthoring:async (r:RecipeAuthoringRequest):Promise<RecipeAuthoringReply> => {
        calls.push(r);
        if (r.type === 'open') return {kind:'session', session, leaseMs:45000,linked:false};
        if (r.type === 'workflow') return {kind:'workflow',activity:0,ageMs:0,pausedContexts:[]};
        if (r.type === 'status') return {kind:'status',linked:false,operations:[],reconciliation:[]};
        if (r.type === 'beginLink') return {kind:'challenge',challengeId,code:'123456',expiresAt:Date.now()+30000};
        if (r.type === 'inspectLink') return {kind:'link',linked:false,evidence,recipient:{openId:'ou_admin',chatId:groupId,tenantKey:'test'}};
        if (r.type === 'confirmLink') return {kind:'link',linked:true};
        if (r.type === 'close') return {kind:'closed'};
        throw Error('unexpected RPC');
      },
    });
    const {shell,client} = createDesktopFacades({invoke:(channel,...args) => h.invoke(channel,...args), receive:() => () => {}});
    expect(client.recipeAuthoring).toBeUndefined();
    const request = shell.recipeAuthoring.request;
    const opened = await request({type:'open',viewId:'local',accountId,botId});
    if (opened.kind !== 'session') throw Error('expected authoring session');
    const {handle} = opened;
    expect(opened.target).toMatchObject({botName:'助手',accountName:'写作者'});
    expect(handle).not.toBe(session);
    expect(await h.invoke(desktopChannels.recipeAuthoring,{type:'answerField',session,botId,request:{},value:'fake'})).toMatchObject({ok:false});
    expect(await h.invoke(desktopChannels.recipeAuthoring,{type:'advance',session,ticket:'test'})).toMatchObject({ok:false});
    expect(await h.invoke(desktopChannels.recipeAuthoring,{type:'status',handle,accountId})).toMatchObject({ok:false});
    expect(await request({type:'beginLink',handle})).toMatchObject({kind:'challenge',challengeId});
    await expect(request({type:'confirmLink',handle,challengeId,evidence})).rejects.toThrow();
    await request({type:'inspectLink',handle,challengeId});
    await expect(request({type:'confirmLink',handle,challengeId,evidence})).resolves.toEqual({kind:'link',linked:true});
    generation.abort();
    generation = new AbortController();
    await expect(request({type:'status',handle})).rejects.toThrow();
    expect(calls.at(-1)).toEqual({type:'close',session,botId});
    expect(calls.filter(r => r.type === 'confirmLink')).toHaveLength(1);
    const fresh = await request({type:'open',viewId:'local',accountId,botId});
    if (fresh.kind !== 'session') throw Error('expected renewed session');
    const started = Date.now();
    const now = vi.spyOn(Date,'now');
    try {
      for (const minute of [10,20,29]) {
        now.mockReturnValue(started+minute*60_000);
        expect(await request({type:'status',handle:fresh.handle})).toMatchObject({kind:'session'});
      }
      now.mockReturnValue(started+30*60_000);
      await expect(request({type:'status',handle:fresh.handle})).rejects.toThrow('暂停');
      expect(calls.at(-1)).toEqual({type:'close',session,botId});
    } finally {now.mockRestore(); await h.bridge.dispose();}
  });
  it('forwards a schedule request with its bot and checks both arguments', async () => {
    const h = harness();
    const request = { action: 'list', chatId: 'oc_pay' };
    expect(await h.invoke(desktopChannels.schedule, 'cli_a', request)).toEqual({ ok: true, value: { kind: 'tasks', tasks: [], now: 1, timeZone: 'UTC' } });
    expect(h.schedule).toHaveBeenCalledExactlyOnceWith('cli_a', request);
    expect(await h.invoke(desktopChannels.schedule, request)).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.schedule, 'not-a-bot', request)).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.schedule, 'cli_a', { action: 'nope' })).toMatchObject({ ok: false });
    expect(h.schedule).toHaveBeenCalledOnce();
  });
  it('hands a daemon restart to the shell with the attached owner and forwards other commands', async () => {
    const h = harness();
    expect(await h.invoke(desktopChannels.run, { type: 'restartHost' })).toEqual({ ok: true, value: { kind: 'applied', revision: 2 } });
    expect(h.actions.restartHost).toHaveBeenCalledExactlyOnceWith({ pid: 1, startedAt: 'now', listen: '127.0.0.1:4000' }, expect.any(Function));
    expect(h.run).toHaveBeenCalledExactlyOnceWith({ type: 'restartHost' });
    expect(await h.invoke(desktopChannels.run, { type: 'refresh' })).toEqual({ ok: true, value: { kind: 'applied', revision: 2 } });
    expect(h.actions.restartHost).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenLastCalledWith({ type: 'refresh' });
  });

  it('keeps service operations shell-owned and validates authorized arguments', async () => {
    const h = harness();
    const wrong = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.service)?.(wrong, { type: 'service', action: 'install' })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'invalid' })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'install' }, 'extra')).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.setLoginItem, 'true')).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.setLoginItem, true, false)).toMatchObject({ ok: false });
    expect(h.actions.service).not.toHaveBeenCalled();
    expect(h.actions.setLoginItem).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'install' })).toEqual({ ok: true, value: { type: 'done', message: 'service updated' } });
    expect(await h.invoke(desktopChannels.setLoginItem, true)).toEqual({ ok: true, value: undefined });
    expect(h.actions.service).toHaveBeenCalledWith('install', h.owner.identity);
    expect(h.actions.setLoginItem).toHaveBeenCalledWith(true, h.owner.identity);
    expect(await h.invoke(desktopChannels.machine, { type: 'service', action: 'install' })).toMatchObject({ ok: false });
    // Only the two refreshes after the switches reached the daemon.
    expect(h.machine.mock.calls).toEqual([[{ type: 'status' }], [{ type: 'status' }]]);
    await h.bridge.dispose();
  });

  it('masks arbitrary errors and passes daemon messages through sanitized', async () => {
    const h = harness();
    h.actions.setLoginItem.mockRejectedValueOnce(new Error('uninstall_incomplete: SECRET_TOKEN'));
    expect(await h.invoke(desktopChannels.setLoginItem, false)).toEqual({ ok: false, error: { kind: 'validation', message: '桌面端操作没有成功，请重试。' } });
    h.actions.setLoginItem.mockRejectedValueOnce(new ServiceActionError('report', '没关掉：launchctl said token=t-g1044abcdefghijklmnopqrstuvwxyz0123'));
    expect(await h.invoke(desktopChannels.setLoginItem, false)).toEqual({ ok: false, error: { kind: 'validation', message: '没关掉：launchctl said token=…' } });
    h.actions.setLoginItem.mockRejectedValueOnce(new ServiceActionError('busy'));
    expect(await h.invoke(desktopChannels.setLoginItem, true)).toEqual({ ok: false, error: { kind: 'validation', message: '另一个后台服务操作正在进行，等它结束再试。' } });
    h.machine.mockRejectedValueOnce(new RpcError('upstream', '缺少飞书权限 im:chat:readonly（读取群信息）。\n在 Bot 设置点「一键开权限」。'));
    expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toEqual({ ok: false, error: {
      kind: 'rpc', code: 'upstream', message: '缺少飞书权限 im:chat:readonly（读取群信息）。 在 Bot 设置点「一键开权限」。' } });
    h.machine.mockRejectedValueOnce(new RpcError('bad code\n', 'Bot 没启用或没在运行'));
    expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toEqual({ ok: false, error: { kind: 'rpc', message: 'Bot 没启用或没在运行' } });
    await h.invoke(desktopChannels.subscribe);
    h.emitError(new RpcError('conflict', 'token=t-g1044abcdefghijklmnopqrstuvwxyz0123'));
    expect(h.webContents.send).toHaveBeenLastCalledWith(desktopChannels.event, { type: 'error', value: { kind: 'rpc', code: 'conflict', message: 'token=…' } });
    await h.bridge.dispose();
  });

  it.each([
    ['control and format characters', 'a\u0000b\u001b[31mc\u202ed\u200be\r\n\tf', 'a b [31mcde f'],
    ['URL credentials, queries and fragments', '打不开 https://user:pa55@open.feishu.cn/app/cli_a/auth?q=im:chat&token=x#frag 和 http://127.0.0.1:4000/x?credential=y',
      '打不开 https://open.feishu.cn/app/cli_a/auth 和 http://127.0.0.1:4000/x'],
    ['bearer tokens', 'Authorization: Bearer abc.def-123 failed', 'Authorization: …'],
    ['quoted auth headers and bare schemes', "headers: {authorization: 'Basic dXNlcjpwYXNz'} then Bearer eyJhbGciOiJIUzI1NiJ9.e30 rejected",
      "headers: {authorization: '…'} then Bearer … rejected"],
    ['API keys', 'Invalid API key sk-ant-api03-abcdefghijklmnop, api_key=abc, apiKey: "xyz"', 'Invalid API key …, api_key=…, apiKey: "…"'],
    ['credential-shaped values after an unquoted label', 'password: hunter22 and token: 0123456789abcdef', 'password: … and token: …'],
    ['ordinary words after bearer, basic or a secret label', 'Basic settings are invalid. Invalid token: expired; tokens: 1234 used',
      'Basic settings are invalid. Invalid token: expired; tokens: 1234 used'],
    ['file paths, which the web UI shows too', 'ENOENT: no such file /home/operator/.vonvon/bots/cli_a/setup.json', 'ENOENT: no such file /home/operator/.vonvon/bots/cli_a/setup.json'],
    ['secret-style values', 'unsupported secret form: {"app_secret":"s3cr3t","password":\'pw\', token = abc}', 'unsupported secret form: {"app_secret":"…","password":\'…\', token = …}'],
    ['quoted values with spaces, commas, the other quote or escapes', String.raw`{"app_secret":"abc def ghi"} {"secret":"a,b-c-d"} client_secret = "s e c" {"password":"it's a secret"} {"password":"ab\"cd ef"} secret:'a"b c' end`,
      String.raw`{"app_secret":"…"} {"secret":"…"} client_secret = "…" {"password":"…"} {"password":"…"} secret:'…' end`],
    ...['Bearer abcdefghijkl', 'Basic dXNlcjpwYXNz', 'Token abcdefgh12345678', 'Digest username="bob", response="deadbeef"']
      .map(value => [`an Authorization value under ${value.split(' ')[0]}`, `Authorization: ${value}`, 'Authorization: …']),
    ['authorization= under any scheme', 'headers: {authorization=Token abcdefgh}', 'headers: {authorization=…'],
    ['a quoted Authorization key with an unquoted value', '{"authorization": Token abc12345}', '{"authorization": …'],
    ['a long quoted value with spaces', `secret: "${'a'.repeat(260)} leaked words" end`, 'secret: "…" end'],
    ['base64 and base64url after Basic', 'Basic dXNlcjpwYXNz; Basic YTpi; Basic dXNlcjpw-Xz', 'Basic …; Basic …; Basic …'],
    ['a short token after Bearer', 'then Bearer abcdefghijkl rejected', 'then Bearer … rejected'],
    ['capitalised words after Basic', 'Basic Settings are invalid. Basic HTTP auth is off. Basic Information missing',
      'Basic Settings are invalid. Basic HTTP auth is off. Basic Information missing'],
    ['bare Feishu access tokens', 'invalid access t-g1044ghJRUIJJ5ELPPA7VQ5XWQUQAP4XMYWC4P7S here', 'invalid access … here'],
    ['empty text', ' \u0000 ', '后台请求失败，请重试。'],
  ])('sanitizes %s in daemon messages', (_name, raw, expected) => {
    expect(sanitizeDaemonMessage(raw)).toBe(expected);
  });

  it('scans only the start of a huge daemon message, so the patterns cannot stall the main process', () => {
    for (const raw of ['a-'.repeat(50_000), 'a.'.repeat(50_000), 'a://'.repeat(25_000), 'token '.repeat(20_000), 'secret:"'.repeat(15_000), 'basic '.repeat(20_000), '😀'.repeat(100_000)]) {
      const started = performance.now();
      const text = sanitizeDaemonMessage(raw);
      expect(performance.now() - started).toBeLessThan(250);
      expect(Array.from(text).length).toBeLessThanOrEqual(300);
    }
    // The cut lands inside a Feishu token after a long query string; its first characters must not show.
    const raw = `打不开 https://h/p?${'q'.repeat(1975)} t-g1044abcdefghijklmnopqrstuvwxyz0123`;
    expect(sanitizeDaemonMessage(raw)).toBe('打不开 https://h/p…');
  });

  it('caps daemon messages at 300 characters without splitting a character', () => {
    expect(sanitizeDaemonMessage('群'.repeat(300))).toBe('群'.repeat(300));
    const capped = sanitizeDaemonMessage('😀'.repeat(400));
    expect(Array.from(capped)).toHaveLength(300);
    expect(capped.endsWith('😀…')).toBe(true);
  });

  it('passes the daemon\'s snapshot through, login item included', async () => {
    const h = harness();
    expect(await h.invoke(desktopChannels.snapshot)).toEqual({ ok: true, value: await h.snapshot() });
    await h.invoke(desktopChannels.subscribe);
    const application = { platform: 'macos', version: '1', loginItem: true, dataPath: fixtureRoot, service: { state: 'running', skipped: false } };
    h.emitSnapshot({ revision: 2, application });
    h.emitSnapshot({ revision: 1, application: { ...application, loginItem: false } });
    h.emitSnapshot({ revision: 3, application: { ...application, loginItem: false } });
    expect(h.events()).toEqual([
      { type: 'snapshot', view: 'local', value: { revision: 2, application } },
      { type: 'snapshot', view: 'local', value: { revision: 3, application: { ...application, loginItem: false } } },
    ]);
    await h.bridge.dispose();
  });

  it('hands a drop during a helper started elsewhere to the shell instead of reporting it', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    h.actions.recoverConnection.mockReturnValue(true);
    h.emitError(new ConnectionError('drained by the web UI\'s helper'));
    expect(h.actions.recoverConnection).toHaveBeenCalledExactlyOnceWith(h.owner.identity);
    expect(h.actions.connectionLost).not.toHaveBeenCalled();
    expect(h.events()).toEqual([]);
    h.actions.recoverConnection.mockReturnValue(false);
    h.emitError(new ConnectionError('daemon crashed'));
    expect(h.actions.connectionLost).toHaveBeenCalledOnce();
    await h.bridge.dispose();
  });

  it('does not report an expected service drain as a lost connection', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    h.actions.isExpectedDisconnect.mockReturnValue(true);
    h.emitError(new ConnectionError('controlled stop'));
    expect(h.actions.connectionLost).not.toHaveBeenCalled();
    expect(h.events()).toEqual([]);
    await h.bridge.dispose();
  });
  // devices-ui-2 4.7: the 应用与启动 page asks whether quitting keeps this computer's daemon.
  it('answers quitKeepsDaemon from the shell, with no argument', async () => {
    const h = harness();
    expect(await h.invoke(desktopChannels.quitKeepsDaemon)).toEqual({ ok: true, value: true });
    expect(await h.invoke(desktopChannels.quitKeepsDaemon, 'x')).toMatchObject({ ok: false });
    expect(h.actions.quitKeepsDaemon).toHaveBeenCalledOnce();
    await h.bridge.dispose();
  });
  it('authorizes zero-argument CLI repair and overlays readonly CLI status', async () => {
    const h = harness();
    const wrongFrame = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    const wrongSender = { ...h.event, sender: {} } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.repairCli)?.(wrongFrame)).toMatchObject({ ok: false });
    expect(await handlers.get(desktopChannels.repairCli)?.(wrongSender)).toMatchObject({ ok: false });
    h.frame.url = 'https://example.invalid';
    expect(await h.invoke(desktopChannels.repairCli)).toMatchObject({ ok: false });
    h.frame.url = pathToFileURL(realpathSync(uiIndex)).href;
    expect(await h.invoke(desktopChannels.repairCli, { type: 'repairCli' })).toMatchObject({ ok: false });
    expect(h.actions.repairCli).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.repairCli)).toEqual({ ok: true, value: { type: 'done', message: 'installed' } });
    h.actions.repairCli.mockResolvedValueOnce({ type: 'invalid', message: 'bad' } as never);
    expect(await h.invoke(desktopChannels.repairCli)).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.machine, { type: 'repairCli' })).toMatchObject({ ok: false });
    expect(h.machine).not.toHaveBeenCalled();
    h.machine.mockResolvedValueOnce({ type: 'status', service: { platformName: 'macos', installed: false, running: false, servicePath: '', stdoutPath: '', stderrPath: '' }, host: null,
      cli: { kind: 'ready', bin: '/wrong', message: 'internal' } });
    expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toMatchObject({ ok: true, value: { cli: { kind: 'error', message: 'not registered' } } });
    expect(h.actions.observeCli).toHaveBeenCalledOnce();
    await h.bridge.dispose();
  });
  it('authorizes and validates the shell start request before forwarding the selected Bot', async () => {
    const h = harness();
    const wrong = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.startHost)?.(wrong, { type: 'startHost' })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost', bot: 42 })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost', bot: '' })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost' }, 'extra')).toMatchObject({ ok: false });
    expect(h.actions.startHost).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost' })).toEqual({ ok: true, value: { type: 'done', message: 'started' } });
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost', bot: 'cli_exact_Bot_ID' })).toMatchObject({ ok: true });
    expect(h.actions.startHost.mock.calls).toEqual([[undefined], ['cli_exact_Bot_ID']]);
    expect(h.machine).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });

  it('moves requests and events to the new owner and disposes the old connection', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    const nextSnapshot = { revision: 1 };
    let emitOld: ((value: unknown) => void) | undefined;
    let emitNext: ((value: unknown) => void) | undefined;
    const offOld = vi.fn();
    const old = {
      client: {
        snapshot: vi.fn(async () => ({ revision: 9 })),
        watchSnapshots: (listener: (value: unknown) => void) => { emitOld = listener; return offOld; },
        onLog: () => () => {}, onBackendInstall: () => () => {}, onDevice: () => () => {}, onError: () => () => {},
      },
      identity: { pid: 2, startedAt: 'old', listen: '127.0.0.1:4001' },
      dispose: vi.fn(async () => {}),
    } as unknown as AttachedDaemon;
    await h.bridge.replaceOwner(old);
    const next = {
      client: {
        snapshot: vi.fn(async () => nextSnapshot),
        watchSnapshots: (listener: (value: unknown) => void) => { emitNext = listener; return () => {}; },
        onLog: () => () => {}, onBackendInstall: () => () => {}, onDevice: () => () => {}, onError: () => () => {},
      },
      identity: { pid: 3, startedAt: 'new', listen: '127.0.0.1:4002' },
      dispose: vi.fn(async () => {}),
    } as unknown as AttachedDaemon;
    await h.bridge.replaceOwner(next);
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(offOld).toHaveBeenCalledOnce();
    h.webContents.send.mockClear();
    emitOld?.({ revision: 10 });
    emitNext?.(nextSnapshot);
    await Promise.resolve();
    expect(h.webContents.send).toHaveBeenCalledExactlyOnceWith(desktopChannels.event, { type: 'snapshot', view: 'local', value: { revision: 1 } });
    expect(await h.invoke(desktopChannels.snapshot)).toEqual({ ok: true, value: { revision: 1 } });
    await h.bridge.dispose();
    expect(next.dispose).toHaveBeenCalledOnce();
  });

  it('leaves no stale owner when the new connection cannot provide a snapshot', async () => {
    const h = harness();
    const next = {
      client: { snapshot: vi.fn(async () => { throw new Error('snapshot failed'); }), watchSnapshots: () => () => {}, onLog: () => () => {}, onBackendInstall: () => () => {}, onDevice: () => () => {}, onError: () => () => {} },
      identity: { pid: 4, startedAt: 'new', listen: '127.0.0.1:4003' },
      dispose: vi.fn(async () => {}),
    } as unknown as AttachedDaemon;
    await expect(h.bridge.replaceOwner(next)).rejects.toThrow('snapshot failed');
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(next.dispose).toHaveBeenCalledOnce();
    expect(await h.invoke(desktopChannels.snapshot)).toMatchObject({ ok: false });
    await h.bridge.dispose();
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it('exposes updater only to the authorized top-level document', async () => {
    const h = harness();
    const wrong = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.checkDesktopUpdate)?.(wrong)).toMatchObject({ ok: false });
    expect(await handlers.get(desktopChannels.retryDesktopUpdate)?.(wrong)).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.installDesktopUpdate, 'extra')).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.retryDesktopUpdate, 'extra')).toMatchObject({ ok: false });
    expect(h.actions.checkDesktopUpdate).not.toHaveBeenCalled();
    expect(h.actions.retryDesktopUpdate).not.toHaveBeenCalled();
    expect(h.actions.installDesktopUpdate).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.retryDesktopUpdate)).toMatchObject({ ok: true, value: { state: 'available', message: 'retried' } });
    expect(await h.invoke(desktopChannels.checkDesktopUpdate)).toMatchObject({ ok: true, value: { state: 'available' } });
    expect(await h.invoke(desktopChannels.installDesktopUpdate)).toMatchObject({ ok: true, value: { state: 'downloaded' } });
    expect(h.machine).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });
  it('returns a selected path or cancellation only to the authorized document', async () => {
    const h = harness();
    const wrong = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.chooseExecutablePath)?.(wrong)).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.chooseExecutablePath, 'extra')).toMatchObject({ ok: false });
    expect(h.actions.chooseExecutablePath).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.chooseExecutablePath)).toEqual({ ok: true, value: '/usr/local/bin/codex' });
    h.actions.chooseExecutablePath.mockResolvedValueOnce(null);
    expect(await h.invoke(desktopChannels.chooseExecutablePath)).toEqual({ ok: true, value: null });
    expect(h.actions.chooseExecutablePath).toHaveBeenCalledTimes(2);
    h.frame.url += '#fragment';
    expect(await h.invoke(desktopChannels.chooseExecutablePath)).toMatchObject({ ok: false });
    expect(h.actions.chooseExecutablePath).toHaveBeenCalledTimes(2);
    await h.bridge.dispose();
  });

  it('keeps the native multi-directory chooser behind the document boundary', async () => {
    const h = harness();
    const wrong = {...h.event, senderFrame:{url:h.frame.url}} as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.chooseDirectoryPaths)?.(wrong,true)).toMatchObject({ok:false});
    expect(await h.invoke(desktopChannels.chooseDirectoryPaths,'true')).toMatchObject({ok:false});
    expect(await h.invoke(desktopChannels.chooseDirectoryPaths,true,false)).toMatchObject({ok:false});
    expect(h.actions.chooseDirectoryPaths).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.chooseDirectoryPaths,true)).toEqual({ok:true,value:['/tmp/workspace','/tmp/docs']});
    expect(h.actions.chooseDirectoryPaths).toHaveBeenCalledExactlyOnceWith(true);
    h.actions.chooseDirectoryPaths.mockResolvedValueOnce(null);
    expect(await h.invoke(desktopChannels.chooseDirectoryPaths,false)).toEqual({ok:true,value:null});
    await h.bridge.dispose();
  });

  it('checks sender, main frame and exact document before parsing or invoking', async () => {
    const h = harness();
    const wrong = { ...h.event, senderFrame: { url: h.frame.url } } as IpcMainInvokeEvent;
    expect(await handlers.get(desktopChannels.run)?.(wrong, { type: 'refresh' })).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.snapshot, 'extra')).toMatchObject({ ok: false });
    h.frame.url += '#fragment';
    expect(await h.invoke(desktopChannels.snapshot)).toMatchObject({ ok: false });
    expect(h.snapshot).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });

  it('refuses shell-owned machine actions and dispatches daemon-owned methods', async () => {
    const h = harness();
    expect(await h.invoke(desktopChannels.machine, { type: 'service', action: 'stop' })).toMatchObject({ ok: false });
    expect(h.machine).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.machine, { type: 'logs' })).toMatchObject({ ok: true });
    expect(h.machine).toHaveBeenCalledWith({ type: 'logs' });
    expect(await h.invoke(desktopChannels.machine, { type: 'stopHost' })).toMatchObject({ ok: true });
    expect(h.machine).toHaveBeenCalledWith({ type: 'stopHost' });
    await h.bridge.dispose();
  });

  it('shows update failures to the window as their own Chinese message, and hides other errors behind a generic one', async () => {
    const h = harness();
    h.actions.checkDesktopUpdate.mockRejectedValueOnce(new DesktopUpdateError('检查更新失败：连不上更新服务器，请检查网络后重试。'));
    expect(await h.invoke(desktopChannels.checkDesktopUpdate)).toEqual({ ok: false, error: { kind: 'validation', message: '检查更新失败：连不上更新服务器，请检查网络后重试。' } });
    h.actions.retryDesktopUpdate.mockRejectedValueOnce(new DesktopUpdateError('没能清除上次安装的记录，请到官网重新下载安装：https://vonvon.cc/get/'));
    expect(await h.invoke(desktopChannels.retryDesktopUpdate)).toMatchObject({ ok: false, error: { message: expect.stringContaining('重新下载安装') } });
    h.actions.installDesktopUpdate.mockRejectedValueOnce(new Error('EACCES: /Users/someone/Library/secret'));
    expect(await h.invoke(desktopChannels.installDesktopUpdate)).toEqual({ ok: false, error: { kind: 'validation', message: '桌面端操作没有成功，请重试。' } });
    await h.bridge.dispose();
  });

  it('pushes the automatic update result to a subscribed window and replays the latest one after a reload', async () => {
    const h = harness();
    const found = { state: 'available' as const, current: '1.0.0', latest: '1.1.0', message: '有新版本' };
    h.bridge.publishUpdate(found);
    expect(h.webContents.send).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.subscribe)).toMatchObject({ ok: true });
    expect(h.events()).toEqual([{ type: 'update', value: found }]);
    const downloaded = { ...found, state: 'downloaded' as const };
    h.bridge.publishUpdate(downloaded);
    expect(h.webContents.send).toHaveBeenLastCalledWith(desktopChannels.event, { type: 'update', value: downloaded });
    h.webContents.send.mockClear();
    expect(await h.invoke(desktopChannels.subscribe)).toMatchObject({ ok: true });
    expect(h.events()).toEqual([{ type: 'update', value: downloaded }]);
    await h.bridge.dispose();
    h.webContents.send.mockClear();
    h.bridge.publishUpdate(found);
    expect(h.webContents.send).not.toHaveBeenCalled();
  });

  // devices-ui-4: the window says another device is updating this computer, after a reload too, until it is taken away.
  it('pushes the remote update line to the window, replays it after a reload, and forgets it once taken away', async () => {
    const h = harness();
    h.bridge.sendRemoteUpdate('「笔记本」正在更新这台电脑上的 Vonvon Bot。');
    expect(h.webContents.send).not.toHaveBeenCalled();
    await h.invoke(desktopChannels.subscribe);
    expect(h.events()).toEqual([{ type: 'remoteUpdate', text: '「笔记本」正在更新这台电脑上的 Vonvon Bot。' }]);
    h.webContents.send.mockClear();
    await h.invoke(desktopChannels.subscribe);
    expect(h.events()).toEqual([{ type: 'remoteUpdate', text: '「笔记本」正在更新这台电脑上的 Vonvon Bot。' }]);
    h.bridge.sendRemoteUpdate(undefined);
    expect(h.webContents.send).toHaveBeenLastCalledWith(desktopChannels.event, { type: 'remoteUpdate' });
    h.webContents.send.mockClear();
    await h.invoke(desktopChannels.subscribe);
    expect(h.events()).toEqual([]);
    await h.bridge.dispose();
    h.webContents.send.mockClear();
    h.bridge.sendRemoteUpdate('x');
    expect(h.webContents.send).not.toHaveBeenCalled();
  });

  it('replays a manual download after reload instead of the earlier automatic available result', async () => {
    const h = harness();
    const found = { state: 'available' as const, current: '1.0.0', latest: '1.1.0', message: '有新版本' };
    h.bridge.publishUpdate(found);
    await h.invoke(desktopChannels.subscribe);
    await h.invoke(desktopChannels.installDesktopUpdate);
    expect(h.webContents.send).toHaveBeenLastCalledWith(desktopChannels.event, {
      type: 'update', value: expect.objectContaining({ state: 'downloaded' }),
    });
    h.webContents.send.mockClear();
    await h.invoke(desktopChannels.subscribe);
    expect(h.events()).toEqual([{ type: 'update', value: expect.objectContaining({ state: 'downloaded' }) }]);
    await h.bridge.dispose();
  });

  it.each(['checkDesktopUpdate', 'retryDesktopUpdate'] as const)('retains a manual %s result and leaves it intact on failure', async action => {
    const h = harness();
    const found = { state: 'available' as const, current: '1.0.0', latest: '1.1.0', message: '有新版本' };
    h.actions[action].mockResolvedValueOnce(found);
    await h.invoke(desktopChannels[action]);
    h.actions[action].mockRejectedValueOnce(new Error('network failed'));
    await h.invoke(desktopChannels[action]);
    await h.invoke(desktopChannels.subscribe);
    expect(h.events().at(-1)).toEqual({ type: 'update', value: found });
    await h.bridge.dispose();
  });

  it('buffers errors and quit intent until subscription, then tears down once', async () => {
    const h = harness();
    h.emitError(new Error('raw credential 0123456789'));
    h.bridge.requestQuit();
    expect(h.webContents.send).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.subscribe)).toMatchObject({ ok: true });
    expect(h.webContents.send).toHaveBeenCalledWith(desktopChannels.event,
      { type: 'error', value: { kind: 'validation', message: '桌面端操作没有成功，请重试。' } });
    expect(h.webContents.send).toHaveBeenCalledWith(desktopChannels.event, { type: 'quitRequested' });
    h.bridge.requestQuit();
    expect(h.events()).toHaveLength(3);
    await Promise.all([h.bridge.dispose(), h.bridge.dispose()]);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(handlers.has(desktopChannels.machine)).toBe(false);
  });

  it('accepts only URLs covered by the frozen six-kind allowlist', async () => {
    await openAllowedExternal('https://vonvon.cc/changelog/');
    await openAllowedExternal('https://vonvon.cc/get/');
    expect(openExternal).toHaveBeenNthCalledWith(1, 'https://vonvon.cc/changelog/');
    expect(openExternal).toHaveBeenNthCalledWith(2, 'https://vonvon.cc/get/');
    for (const url of ['https://github.com/modelzen/vonvon-bot/releases', 'https://vonvon.cc.evil.test/get/', 'https://vonvon.cc/other/', 'https://bot.vonvon.cc/get/'])
      await expect(openAllowedExternal(url)).rejects.toThrow('Unsupported external link');
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('opens safe recipe documents only when explicitly requested through the App bridge',async()=>{
    const h=harness();
    const {shell}=createDesktopFacades({invoke:async(channel,...args)=>h.invoke(channel,...args),receive:()=>()=>{}});
    const links=['https://my.feishu.cn/share/base/ExampleReference6','https://vonvon.cc/docs/troubleshooting/','http://example.com/guide'];
    for(const url of links){await shell.openExternal(url,'recipe-document');expect(openExternal).toHaveBeenLastCalledWith(url);}
    for(const url of links)await expect(openAllowedExternal(url)).rejects.toThrow('Unsupported external link');
    for(const value of [
      {kind:'recipe-document',url:'javascript:alert(1)'}, {kind:'recipe-document',url:'data:text/html,test'},
      {kind:'recipe-document',url:'https://user:pass@example.com'}, {kind:'recipe-document',url:'//example.com'},
      {kind:'recipe-document',url:'not a URL'}, {kind:'recipe-document',url:'https://example.com',extra:true},
      {kind:'unrecognized',url:'https://example.com'},
    ])await expect(openAllowedExternal(value)).rejects.toThrow('Unsupported external link');
    expect(openExternal).toHaveBeenCalledTimes(3);await h.bridge.dispose();
  });

  it('removes earlier handlers if bridge installation fails', () => {
    failRegistration.channel = desktopChannels.directory;
    expect(() => harness()).toThrow('registration failed');
    expect(handlers.size).toBe(0);
  });
});

const runningStatus = { type: 'status' as const, host: { ownership: 'owned' as const, pid: 1 },
  service: { platformName: 'macos', installed: true, running: true, state: 'running' as const, pid: '1', servicePath: '', stdoutPath: '', stderrPath: '' },
  temporaryAgent: 'cli_x', cli: { kind: 'ready' as const, bin: '/bin/vonvon', message: 'ready' } };

it('s18g bridge stop uses shell before disconnect and publishes stopped status', async () => {
  const h = harness();
  await h.invoke(desktopChannels.subscribe);
  h.machine.mockImplementation(async request => {
    if (request.type === 'status') return runningStatus;
    if (request.type === 'stopHost') {
      queueMicrotask(() => h.emitError(new ConnectionError('server_shutdown')));
      return { type: 'done', message: '正在停止 daemon。' };
    }
    return { type: 'done', message: 'ok' };
  });
  h.actions.stopHost.mockImplementation(async (_previous, send) => {
    h.actions.isExpectedDisconnect.mockReturnValue(true);
    return send();
  });
  expect(await h.invoke(desktopChannels.machine, { type: 'stopHost' })).toMatchObject({ ok: true });
  await Promise.resolve();
  expect(h.actions.stopHost).toHaveBeenCalledExactlyOnceWith(h.owner.identity, expect.any(Function));
  expect(h.machine.mock.calls).toEqual([[{ type: 'status' }], [{ type: 'stopHost' }]]);
  expect(h.actions.recoverConnection).not.toHaveBeenCalled();
  expect(h.actions.connectionLost).not.toHaveBeenCalled();
  expect(h.webContents.send.mock.calls.map(call => call[1])).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  const stopped = await h.invoke(desktopChannels.machine, { type: 'status' });
  expect(stopped).toMatchObject({ ok: true, value: { host: null, service: { running: false, state: 'stopped' },
    cli: { kind: 'error', message: 'not registered' } } });
  expect((stopped as { value: Record<string, unknown> }).value).not.toHaveProperty('temporaryAgent');
  expect(h.machine).toHaveBeenCalledTimes(2);
  await h.bridge.dispose();
});

it('s18g bridge stop refusal leaves live machine status available', async () => {
  const h = harness();
  h.machine.mockResolvedValue(runningStatus);
  h.actions.stopHost.mockRejectedValueOnce(new StartHostRefusal('没停完'));
  expect(await h.invoke(desktopChannels.machine, { type: 'stopHost' })).toEqual({ ok: false,
    error: { kind: 'validation', message: '没停完' } });
  expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toMatchObject({ ok: true,
    value: { host: { pid: 1 }, service: { running: true } } });
  expect(h.machine).toHaveBeenCalledTimes(2);
  await h.bridge.dispose();
});

it('s18g bridge stop never overlays a replacement owner', async () => {
  const h = harness();
  h.machine.mockResolvedValue(runningStatus);
  let finish!: (reply: { type: 'done'; message: string }) => void;
  h.actions.stopHost.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const stopping = h.invoke(desktopChannels.machine, { type: 'stopHost' });
  await vi.waitFor(() => expect(h.actions.stopHost).toHaveBeenCalledOnce());
  const next = { client: { snapshot: vi.fn(async () => ({ revision: 1 })), machine: vi.fn(async () => ({
    ...runningStatus, host: { ownership: 'owned', pid: 2 } })), watchSnapshots: () => () => {},
    onLog: () => () => {}, onBackendInstall: () => () => {}, onDevice: () => () => {}, onError: () => () => {} },
  identity: { pid: 2, startedAt: 'next', listen: '127.0.0.1:4000' }, dispose: vi.fn(async () => {}) } as unknown as AttachedDaemon;
  await h.bridge.replaceOwner(next);
  finish({ type: 'done', message: 'daemon 已停止。' });
  await expect(stopping).resolves.toMatchObject({ ok: true });
  expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toMatchObject({ ok: true,
    value: { host: { pid: 2 }, service: { running: true } } });
  await h.bridge.dispose();
});

it('s18g bridge stop falls back to the last readable status', async () => {
  const h = harness();
  h.machine.mockResolvedValueOnce(runningStatus)
    .mockRejectedValueOnce(new RpcError('internal', '读不到服务状态'))
    .mockResolvedValueOnce({ type: 'done', message: '正在停止 daemon。' });
  expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toMatchObject({ ok: true });
  expect(await h.invoke(desktopChannels.machine, { type: 'stopHost' })).toMatchObject({ ok: true });
  const stopped = await h.invoke(desktopChannels.machine, { type: 'status' });
  expect(stopped).toMatchObject({ ok: true, value: { host: null, service: { running: false, state: 'stopped' } } });
  expect(h.machine).toHaveBeenCalledTimes(3);
  await h.bridge.dispose();
});

it('serves installed/stopped status after stop closes RPC, then uses the reattached owner', async () => {
  const h = harness();
  const status = { type: 'status' as const, host: { ownership: 'owned' as const, pid: 1 },
    service: { platformName: 'macos', installed: true, running: true, pid: '1', servicePath: '', stdoutPath: '', stderrPath: '' },
    cli: { kind: 'ready' as const, bin: '/bin/vonvon', message: 'ready' } };
  h.machine.mockResolvedValue(status);
  h.actions.service.mockImplementation(async () => {
    h.machine.mockRejectedValue(new ConnectionError('stopped'));
    return { type: 'done', message: 'stopped' };
  });
  expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'stop' })).toMatchObject({ ok: true });
  expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toMatchObject({ ok: true, value: { host: null, service: { installed: true, running: false } } });
  expect(h.machine).toHaveBeenCalledTimes(1);
  const next = { client: { snapshot: async () => ({ revision: 1 }), machine: async () => ({ ...status, host: { ownership: 'owned', pid: 2 } }),
    watchSnapshots: () => () => {}, onLog: () => () => {}, onBackendInstall: () => () => {}, onDevice: () => () => {}, onError: () => () => {} },
    identity: { pid: 2, startedAt: 'next', listen: '127.0.0.1:4000' }, dispose: async () => {} } as unknown as AttachedDaemon;
  await h.bridge.replaceOwner(next);
  expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toMatchObject({ ok: true, value: { host: { pid: 2 }, service: { running: true } } });
  await h.bridge.dispose();
});

function candidate(snapshot: () => Promise<unknown>) {
  let close: () => void = () => {};
  const closed = new Promise<never>((_resolve, reject) => { close = () => reject(new Error('connection closed')); });
  closed.catch(() => {});
  const dispose = vi.fn(async () => { close(); });
  const owner = { client: {
    snapshot: vi.fn(() => Promise.race([snapshot(), closed])),
    watchSnapshots: () => () => {}, onLog: () => () => {}, onBackendInstall: () => () => {}, onDevice: () => () => {}, onError: () => () => {},
  }, identity: { pid: 2, startedAt: 'next', listen: '127.0.0.1:4001' }, dispose } as unknown as AttachedDaemon;
  return { owner, dispose };
}

it('closes a replacement candidate whose first snapshot is pending when the bridge is disposed', async () => {
  const h = harness();
  await h.invoke(desktopChannels.subscribe);
  const next = candidate(() => new Promise(() => {}));
  const replacing = expect(h.bridge.replaceOwner(next.owner)).rejects.toThrow();
  await vi.waitFor(() => expect(next.owner.client.snapshot).toHaveBeenCalled());
  await h.bridge.dispose();
  await replacing;
  expect(next.dispose).toHaveBeenCalled();
  expect(h.events()).not.toContainEqual(expect.objectContaining({ type: 'reattached' }));
});

it('closes an owner handed over after disposal', async () => {
  const h = harness();
  await h.bridge.dispose();
  const next = candidate(async () => ({ revision: 3 }));
  await expect(h.bridge.replaceOwner(next.owner)).rejects.toThrow('Desktop connection is unavailable');
  expect(next.dispose).toHaveBeenCalledOnce();
});

it('cleans partial bindings without announcing a failed reattachment', async () => {
  const h = harness();
  await h.invoke(desktopChannels.subscribe);
  const off = vi.fn();
  const next = { client: { watchSnapshots: () => off, onLog: () => { throw new Error('bind failed'); } },
    dispose: vi.fn(async () => {}) } as unknown as AttachedDaemon;
  await expect(h.bridge.replaceOwner(next)).rejects.toThrow('bind failed');
  expect(off).toHaveBeenCalledOnce();
  expect(h.events()).toEqual([]);
  expect(next.dispose).toHaveBeenCalledOnce();
  await h.bridge.dispose();
});

it.each(['synchronous', 'pending'] as const)('preserves a newer %s watch snapshot during reattachment', async timing => {
  const h = harness();
  await h.invoke(desktopChannels.subscribe);
  let emit: (value: unknown) => void = () => {};
  const next = { client: {
    snapshot: async () => { if (timing === 'pending') { await Promise.resolve(); emit({ revision: 5 }); } return { revision: 1 }; },
    watchSnapshots: (listener: typeof emit) => { emit = listener; if (timing === 'synchronous') emit({ revision: 5 }); return () => {}; },
    onLog: () => () => {}, onBackendInstall: () => () => {}, onDevice: () => () => {}, onError: () => () => {},
  }, dispose: async () => {} } as unknown as AttachedDaemon;
  await h.bridge.replaceOwner(next);
  expect(h.events()).toEqual([
    { type: 'reattached', view: 'local' }, { type: 'snapshot', view: 'local', value: { revision: 5 } },
  ]);
  await h.bridge.dispose();
});

it('asks the current owner to read the service again after a switch, even a failed one, and leaves the snapshot to its push', async () => {
  const h = harness();
  await h.invoke(desktopChannels.subscribe);
  const next = { client: { snapshot: async () => ({ revision: 1 }), machine: vi.fn(async () => ({ type: 'done', message: 'ok' })),
    watchSnapshots: () => () => {}, onLog: () => () => {}, onBackendInstall: () => () => {}, onDevice: () => () => {}, onError: () => () => {} },
    identity: { pid: 2, startedAt: 'next', listen: '127.0.0.1:4000' }, dispose: async () => {} } as unknown as AttachedDaemon;
  h.actions.setLoginItem.mockImplementationOnce(async () => { await h.bridge.replaceOwner(next); });
  expect(await h.invoke(desktopChannels.setLoginItem, true)).toEqual({ ok: true, value: undefined });
  expect(next.client.machine).toHaveBeenCalledExactlyOnceWith({ type: 'status' });
  expect(h.machine).not.toHaveBeenCalled();
  h.actions.setLoginItem.mockRejectedValueOnce(new ServiceActionError('timeout'));
  expect(await h.invoke(desktopChannels.setLoginItem, false)).toMatchObject({ ok: false, error: { message: expect.stringContaining('3 分钟') } });
  expect(h.actions.setLoginItem).toHaveBeenLastCalledWith(false, next.identity);
  expect(next.client.machine).toHaveBeenCalledTimes(2);
  h.actions.service.mockRejectedValueOnce(new ServiceActionError('busy'));
  expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'uninstall' })).toMatchObject({ ok: false });
  expect(next.client.machine).toHaveBeenCalledTimes(3);
  expect(h.events().map(value => value.type)).toEqual(['reattached', 'snapshot']);
  await h.bridge.dispose();
});


it('delivers fresh snapshots through the facade across three replacements, including daemon pause', async () => {
  const h = harness();
  const initial = {
    revision: 10, observedAt: 1, stale: false, host: { kind: 'starting' },
    agents: [], groups: [], memberships: [], tools: [], jobs: [],
    application: { platform: 'macos', version: '1', loginItem: false, dataPath: fixtureRoot },
  };
  h.snapshot.mockResolvedValue(initial);
  let receive: (event: unknown) => void = () => {};
  h.webContents.send.mockImplementation((_channel, event) => receive(event));
  const { client } = createDesktopFacades({
    // The facade names the view itself.
    invoke: (channel, ...args) => handlers.get(channel)!(h.event, ...args),
    receive: listener => { receive = listener; return () => {}; },
  });
  const seen: Array<Awaited<ReturnType<VonvonClient['snapshot']>>> = [];
  const off = client.watchSnapshots(value => seen.push(value));
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  for (let crash = 1; crash <= 3; crash++) {
    const snapshot = { ...initial, revision: 1, observedAt: crash + 1,
      application: { ...initial.application, crashes: {
        records: [], ...(crash === 3 ? { paused: { since: 3, crashes: 3 } } : {}),
      } },
    };
    const next = candidate(async () => snapshot);
    await h.bridge.replaceOwner(next.owner);
    expect(seen.at(-1)).toEqual(snapshot);
  }
  expect(seen).toHaveLength(4);
  expect(seen.at(-1)?.application.crashes?.paused).toEqual({ since: 3, crashes: 3 });
  off();
  await h.bridge.dispose();
});


it.each(['rejected', 'resolved'] as const)('rejects an observed candidate connection loss even with a %s first snapshot', async state => {
  const h = harness();
  const next = candidate(async () => {
    if (state === 'rejected') throw new Error('Daemon connection closed');
    return { revision: 1 };
  });
  const loss = new ConnectionError('candidate crashed before binding');
  next.owner.client.onError = listener => { listener(loss); return () => {}; };
  await expect(h.bridge.replaceOwner(next.owner)).rejects.toBe(loss);
  expect(next.dispose).toHaveBeenCalledOnce();
  await h.bridge.dispose();
});

// devices-ui-1a 第 5 节 bridge: the page's view of one device. main 必败: there were no views.
/** After `reattached{X}`, every snapshot is X's (第 5 节"交错的共同断言"). */
function snapshotsFollowReattached(events: DesktopEvent[]): void {
  let shown = 'local';
  for (const event of events) {
    if (event.type === 'reattached') shown = event.view;
    if (event.type === 'snapshot') expect(event.view).toBe(shown);
  }
}
const read = { type: 'read', scope: { kind: 'host' } };

describe('devices-ui-1a views', () => {
  it('sends to the device shown, and nothing from a page of the one shown before', async () => {
    const h = harness();
    const localSettings = vi.fn(async () => ({ kind: 'local' }));
    Object.assign(h.owner.client, { settings: localSettings });
    const a = remoteClient();
    await h.devs.show(remoteView(REMOTE_A, a));
    expect(await h.invokeAs(REMOTE_A, desktopChannels.settings, read)).toEqual({ ok: true, value: { kind: 'settings' } });
    expect(await h.invoke(desktopChannels.settings, read)).toMatchObject({ ok: true });
    expect(a.calls.settings).toHaveBeenCalledTimes(2);
    const b = remoteClient();
    await h.devs.show(remoteView(REMOTE_B, b));
    expect(await h.invokeAs(REMOTE_A, desktopChannels.settings, read)).toEqual({ ok: false,
      error: { kind: 'connection', code: 'device_switched', message: '已经切到另一台设备，这次操作没有发出。' } });
    expect(await h.invokeAs('local', desktopChannels.settings, read)).toMatchObject({ ok: false, error: { code: 'device_switched' } });
    expect(await h.invokeAs('not-a-device', desktopChannels.settings, read)).toMatchObject({ ok: false });
    expect(a.calls.settings).toHaveBeenCalledTimes(2);
    expect(b.calls.settings).not.toHaveBeenCalled();
    expect(localSettings).not.toHaveBeenCalled();
    await h.devs.show({ kind: 'waiting', id: REMOTE_A });
    expect(await h.invoke(desktopChannels.settings, read)).toEqual({ ok: false,
      error: { kind: 'connection', code: 'device_unavailable', message: '还没连上「机房」。' } });
    await h.bridge.dispose();
  });

  it('refuses the six actions that only act on this computer while another device is shown', async () => {
    const h = harness();
    await h.devs.show(remoteView(REMOTE_A, remoteClient()));
    const refused = { ok: false, error: { kind: 'validation', code: 'local_only', message: '现在看的是「机房」，这个操作只对这台电脑有效。先切回这台电脑。' } };
    expect(await h.invoke(desktopChannels.startHost, { type: 'startHost' })).toEqual(refused);
    expect(await h.invoke(desktopChannels.service, { type: 'service', action: 'install' })).toEqual(refused);
    expect(await h.invoke(desktopChannels.setLoginItem, true)).toEqual(refused);
    expect(await h.invoke(desktopChannels.repairCli)).toEqual(refused);
    expect(await h.invoke(desktopChannels.chooseDirectoryPaths, true)).toEqual(refused);
    expect(await h.invoke(desktopChannels.chooseExecutablePath)).toEqual(refused);
    for (const action of ['startHost', 'service', 'setLoginItem', 'repairCli', 'chooseDirectoryPaths', 'chooseExecutablePath'] as const)
      expect(h.actions[action]).not.toHaveBeenCalled();
    // The page never negotiates, on any device.
    expect(await h.invoke(desktopChannels.admin, { type: 'negotiate', capabilities: [] })).toMatchObject({ ok: false, error: { code: 'shell_owned', message: '能力由桌面端自己声明。' } });
    await h.bridge.dispose();
  });

  it('sends a remote restart, stop and status to the device, past this computer\'s shell', async () => {
    const h = harness();
    const a = remoteClient();
    await h.devs.show(remoteView(REMOTE_A, a));
    expect(await h.invoke(desktopChannels.run, { type: 'restartHost' })).toEqual({ ok: true, value: { kind: 'applied', revision: 4 } });
    expect(h.devs.devices.expect).toHaveBeenCalledExactlyOnceWith('restart');
    expect(h.devs.devices.expect.mock.invocationCallOrder[0]).toBeLessThan(a.calls.run.mock.invocationCallOrder[0]!);
    expect(h.actions.restartHost).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toEqual({ ok: true, value: { type: 'status', remote: true } });
    expect(h.actions.observeCli).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.machine, { type: 'stopHost' })).toMatchObject({ ok: true });
    expect(h.devs.devices.expect).toHaveBeenLastCalledWith('stop');
    expect(h.actions.stopHost).not.toHaveBeenCalled();
    expect(await h.invoke(desktopChannels.close)).toEqual({ ok: true, value: undefined });
    expect(h.dispose).not.toHaveBeenCalled();
    expect(h.machine).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });

  it('passes a remote device\'s login-time switch to it, and keeps the rest shell-owned', async () => {
    const h = harness();
    const a = remoteClient();
    await h.devs.show(remoteView(REMOTE_A, a));
    expect(await h.invoke(desktopChannels.machine, { type: 'service', action: 'install' })).toMatchObject({ ok: true });
    expect(h.devs.devices.expect).toHaveBeenCalledExactlyOnceWith('restart');
    expect(a.calls.machine).toHaveBeenCalledExactlyOnceWith({ type: 'service', action: 'install' });
    for (const request of [{ type: 'repairCli' }, { type: 'service', action: 'start' }, { type: 'startHost' }])
      expect(await h.invoke(desktopChannels.machine, request)).toMatchObject({ ok: false });
    expect(a.calls.machine).toHaveBeenCalledOnce();
    await h.devs.show({ kind: 'local' });
    expect(await h.invoke(desktopChannels.machine, { type: 'service', action: 'install' })).toMatchObject({ ok: false });
    expect(h.machine).not.toHaveBeenCalled();
    expect(a.calls.machine).toHaveBeenCalledOnce();
    await h.bridge.dispose();
  });

  it('says reattached for the device switched to before its first snapshot, then only its snapshots', async () => {
    const h = harness();
    h.snapshot.mockResolvedValue({ revision: 50 } as never);
    await h.invoke(desktopChannels.subscribe);
    const b = remoteClient(3);
    await h.devs.show(remoteView(REMOTE_B, b));
    h.emitSnapshot({ revision: 51 });
    b.emitSnapshot({ revision: 4 });
    expect(h.events()).toEqual([
      { type: 'reattached', view: REMOTE_B },
      { type: 'snapshot', view: REMOTE_B, value: expect.objectContaining({ revision: 3 }) },
      { type: 'snapshot', view: REMOTE_B, value: { revision: 4 } },
    ]);
    const old = remoteClient(1);
    await h.devs.show(remoteView(REMOTE_A, old, 'maintenance'));
    expect(old.calls.snapshot).not.toHaveBeenCalled();
    expect(h.events().at(-1)).toEqual({ type: 'reattached', view: REMOTE_A });
    await h.bridge.dispose();
  });

  it('replaces this computer\'s connection quietly while a remote device is shown, and shows it on the way back', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    const owners: AttachedDaemon[] = [];
    h.bridge.onLocalOwner(owner => owners.push(owner));
    await h.devs.show(remoteView(REMOTE_A, remoteClient()));
    h.webContents.send.mockClear();
    const next = candidate(async () => ({ revision: 7 }));
    await h.bridge.replaceOwner(next.owner);
    expect(h.events()).toEqual([]);
    expect(h.bridge.localOwner()).toBe(next.owner);
    expect(owners).toEqual([next.owner]);
    expect(h.devs.devices.setLocal).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'online' }));
    await h.devs.show({ kind: 'local' });
    expect(h.events()).toEqual([{ type: 'reattached', view: 'local' }, { type: 'snapshot', view: 'local', value: { revision: 7 } }]);
    await h.bridge.dispose();
  });

  it('tells a new local connection while this computer is shown too', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    const owners: AttachedDaemon[] = [];
    h.bridge.onLocalOwner(() => { throw new Error('one listener fails'); });
    h.bridge.onLocalOwner(owner => owners.push(owner));
    const next = candidate(async () => ({ revision: 7 }));
    await h.bridge.replaceOwner(next.owner);
    expect(h.events()).toEqual([{ type: 'reattached', view: 'local' }, { type: 'snapshot', view: 'local', value: { revision: 7 } }]);
    expect(owners).toEqual([next.owner]);
    await h.bridge.dispose();
  });

  it('interleaved 1: back to this computer while its connection is replaced', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    const b = remoteClient(3);
    await h.devs.show(remoteView(REMOTE_B, b));
    let release!: (value: unknown) => void;
    const next = candidate(() => new Promise(resolve => { release = resolve; }));
    const replacing = h.bridge.replaceOwner(next.owner);
    await vi.waitFor(() => expect(next.owner.client.snapshot).toHaveBeenCalled());
    await h.devs.show({ kind: 'local' });
    b.emitSnapshot({ revision: 9 });
    release({ revision: 7 });
    await replacing;
    const events = h.events();
    expect(events.slice(events.findIndex(event => event.type === 'reattached' && event.view === 'local'))).toEqual([
      { type: 'reattached', view: 'local' }, { type: 'snapshot', view: 'local', value: { revision: 7 } },
    ]);
    snapshotsFollowReattached(events);
    await h.bridge.dispose();
  });

  it('interleaved 2: to a remote device while this computer\'s connection is replaced', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    const owners: AttachedDaemon[] = [];
    h.bridge.onLocalOwner(owner => owners.push(owner));
    let release!: (value: unknown) => void;
    const next = candidate(() => new Promise(resolve => { release = resolve; }));
    const replacing = h.bridge.replaceOwner(next.owner);
    await vi.waitFor(() => expect(next.owner.client.snapshot).toHaveBeenCalled());
    await h.devs.show(remoteView(REMOTE_B, remoteClient(3)));
    release({ revision: 7 });
    await replacing;
    const events = h.events();
    expect(events.filter(event => event.type === 'reattached')).toEqual([{ type: 'reattached', view: REMOTE_B }]);
    expect(events.filter(event => event.type === 'snapshot').map(event => event.type === 'snapshot' && event.view)).toEqual([REMOTE_B]);
    expect(h.bridge.localOwner()).toBe(next.owner);
    expect(owners).toEqual([next.owner]);
    snapshotsFollowReattached(events);
    await h.bridge.dispose();
  });

  it('interleaved 3: this computer\'s connection is replaced while switching back waits for its snapshot', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    await h.devs.show(remoteView(REMOTE_B, remoteClient(3)));
    let releaseOld!: (value: unknown) => void;
    h.snapshot.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve as (value: unknown) => void; }) as never);
    await h.devs.show({ kind: 'local' });
    expect(h.snapshot).toHaveBeenCalledOnce();
    await h.bridge.replaceOwner(candidate(async () => ({ revision: 7 })).owner);
    releaseOld({ revision: 40 });
    await settle();
    const events = h.events();
    expect(events.filter(event => event.type === 'reattached' && event.view === 'local')).toHaveLength(1);
    expect(events.slice(-2)).toEqual([{ type: 'reattached', view: 'local' }, { type: 'snapshot', view: 'local', value: { revision: 7 } }]);
    expect(events).not.toContainEqual(expect.objectContaining({ value: { revision: 40 } }));
    snapshotsFollowReattached(events);
    await h.bridge.dispose();
  });

  it('holds a lost local connection while a remote device is shown, and says it on the way back', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    await h.devs.show(remoteView(REMOTE_A, remoteClient()));
    h.emitError(new ConnectionError('daemon crashed'));
    expect(h.actions.recoverConnection).toHaveBeenCalledOnce();
    expect(h.actions.connectionLost).not.toHaveBeenCalled();
    expect(h.devs.devices.setLocal).toHaveBeenLastCalledWith({ status: 'offline' });
    expect(h.bridge.deferLocalLost()).toBe(true);
    await h.devs.show({ kind: 'local' });
    expect(h.actions.connectionLost).toHaveBeenCalledOnce();
    expect(h.bridge.deferLocalLost()).toBe(false);
    await h.bridge.dispose();
  });

  it('shows the stopped daemon again, not a page left loading, after a look at a remote device (Codex 审查 235-1)', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    h.machine.mockImplementation(async request => request.type === 'status' ? runningStatus : { type: 'done', message: '正在停止 daemon。' });
    h.emitSnapshot({ revision: 5 });
    // Stopped from 高级运行设置: the shell expects the drop, and the connection stays set but dead.
    h.actions.stopHost.mockImplementation(async (_previous, send) => { h.actions.isExpectedDisconnect.mockReturnValue(true); return send(); });
    expect(await h.invoke(desktopChannels.machine, { type: 'stopHost' })).toMatchObject({ ok: true });
    h.snapshot.mockRejectedValue(new ConnectionError('Daemon connection closed'));
    h.emitError(new ConnectionError('server_shutdown'));
    await h.devs.show(remoteView(REMOTE_A, remoteClient()));
    h.webContents.send.mockClear();
    await h.devs.show({ kind: 'local' });
    // The page built again for this computer gets what the page had, and 启动 daemon as before.
    expect(h.events()).toEqual([{ type: 'reattached', view: 'local' }, { type: 'snapshot', view: 'local', value: { revision: 5 } }]);
    expect(await h.invoke(desktopChannels.snapshot)).toEqual({ ok: true, value: { revision: 5 } });
    expect(await h.invoke(desktopChannels.machine, { type: 'status' })).toMatchObject({ ok: true, value: { host: null, service: { running: false } } });
    expect(h.actions.connectionLost).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });

  it('shows the last snapshot under the lost-connection message when the daemon died while a remote device was shown', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    h.emitSnapshot({ revision: 5 });
    await h.devs.show(remoteView(REMOTE_A, remoteClient()));
    h.snapshot.mockRejectedValue(new ConnectionError('Daemon connection closed'));
    h.emitError(new ConnectionError('daemon crashed'));
    h.webContents.send.mockClear();
    await h.devs.show({ kind: 'local' });
    expect(h.events()).toEqual([{ type: 'reattached', view: 'local' }, { type: 'snapshot', view: 'local', value: { revision: 5 } }]);
    expect(h.actions.connectionLost).toHaveBeenCalledOnce();
    expect(await h.invoke(desktopChannels.snapshot)).toEqual({ ok: true, value: { revision: 5 } });
    await h.bridge.dispose();
  });

  // 0.9.0 Mac 验收 S-4: `vonvon daemon stop` while another device was shown, then back here within the shell's minute of
  // reconnecting. The page built again asked the closed connection and stayed loading, 启动 daemon out of reach.
  it('gives a page built again for this computer its last snapshot while the shell reconnects to a daemon stopped from outside', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    h.actions.recoverConnection.mockReturnValue(true);
    h.emitSnapshot({ revision: 5 });
    await h.devs.show(remoteView(REMOTE_A, remoteClient()));
    // The closed client refuses every request with a plain Error.
    h.snapshot.mockRejectedValue(new Error('Daemon connection closed'));
    h.emitError(new ConnectionError('Daemon connection closed'));
    expect(h.devs.devices.setLocal).toHaveBeenLastCalledWith({ status: 'connecting' });
    h.webContents.send.mockClear();
    await h.devs.show({ kind: 'local' });
    expect(h.events()).toEqual([{ type: 'reattached', view: 'local' }, { type: 'snapshot', view: 'local', value: { revision: 5 } }]);
    expect(await h.invoke(desktopChannels.snapshot)).toEqual({ ok: true, value: { revision: 5 } });
    expect(h.actions.connectionLost).not.toHaveBeenCalled();
    // A minute on the shell gives up while this computer is shown: it says so itself, and the row goes offline.
    expect(h.bridge.deferLocalLost()).toBe(false);
    expect(h.devs.devices.setLocal).toHaveBeenLastCalledWith({ status: 'offline' });
    // 启动 daemon, or the shell found one started from the command line.
    h.webContents.send.mockClear();
    await h.bridge.replaceOwner(candidate(async () => ({ revision: 1 })).owner);
    expect(h.events()).toEqual([{ type: 'reattached', view: 'local' }, { type: 'snapshot', view: 'local', value: { revision: 1 } }]);
    expect(h.devs.devices.setLocal).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'online' }));
    await h.bridge.dispose();
  });

  // 0.9.0 Mac 验收 B-1: three requests for a snapshot of 875 KB on every switch, over a relay at 20 KB/s.
  it('asks a remote device for its snapshot before the binding does, and shares that answer with the new page', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    const a = remoteClient(3);
    let release!: (value: unknown) => void;
    a.calls.snapshot.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }) as never);
    const watch = vi.fn(a.calls.watchSnapshots);
    Object.assign(a.client, { watchSnapshots: watch });
    await h.devs.show(remoteView(REMOTE_A, a));
    expect(a.calls.snapshot.mock.invocationCallOrder[0]).toBeLessThan(watch.mock.invocationCallOrder[0]!);
    const page = h.invokeAs(REMOTE_A, desktopChannels.snapshot);
    await settle();
    expect(a.calls.snapshot).toHaveBeenCalledOnce();
    release({ revision: 3 });
    expect(await page).toEqual({ ok: true, value: { revision: 3 } });
    expect(h.events()).toEqual([{ type: 'reattached', view: REMOTE_A }, { type: 'snapshot', view: REMOTE_A, value: { revision: 3 } }]);
    // Shown: the page's requests go to the device again.
    expect(await h.invokeAs(REMOTE_A, desktopChannels.snapshot)).toMatchObject({ ok: true });
    expect(a.calls.snapshot).toHaveBeenCalledTimes(2);
    await h.bridge.dispose();
  });

  it('shows no error and asks nothing of the shell when a remote connection drops', async () => {
    const h = harness();
    await h.invoke(desktopChannels.subscribe);
    const a = remoteClient();
    await h.devs.show(remoteView(REMOTE_A, a));
    a.emitError(new ConnectionError('Daemon connection closed'));
    expect(h.events().filter(event => event.type === 'error')).toEqual([]);
    expect(h.actions.recoverConnection).not.toHaveBeenCalled();
    expect(h.actions.connectionLost).not.toHaveBeenCalled();
    await h.bridge.dispose();
  });

  it('passes this computer\'s own device events whichever device is shown, and the device list on subscribe', async () => {
    const h = harness();
    expect(await h.invoke(desktopChannels.subscribe)).toMatchObject({ ok: true });
    expect(h.webContents.send).toHaveBeenLastCalledWith(desktopChannels.event, { type: 'devices', value: h.devs.devices.state() });
    await h.devs.show(remoteView(REMOTE_A, remoteClient()));
    const paired = { change: 'client-paired', clientId: 'cl_0123456789abcdef', name: '笔记本', clientKind: 'desktop' };
    h.emitDevice(paired);
    expect(h.events().at(-1)).toEqual({ type: 'localDevice', value: paired });
    expect(h.events()).not.toContainEqual(expect.objectContaining({ type: 'device' }));
    h.webContents.send.mockClear();
    h.devs.emitState();
    expect(h.webContents.send).toHaveBeenCalledExactlyOnceWith(desktopChannels.event, expect.objectContaining({ type: 'devices' }));
    await h.bridge.dispose();
  });

  it('hands the device page\'s requests to the connections', async () => {
    const h = harness();
    expect(await h.invoke(desktopChannels.devicesSwitch, REMOTE_A)).toEqual({ ok: true, value: undefined });
    expect(h.devs.devices.switchTo).toHaveBeenCalledExactlyOnceWith(REMOTE_A);
    expect(await h.invoke(desktopChannels.devicesSwitch, 'nonsense')).toMatchObject({ ok: false });
    expect(await h.invoke(desktopChannels.devicesInspect, 'vonvon://pair#x')).toEqual({ ok: true, value: { ok: false, code: 'invalid_link' } });
    expect(await h.invoke(desktopChannels.devicesAdd, { link: 'vonvon://pair#x', extra: 1 })).toMatchObject({ ok: false });
    expect(h.devs.devices.add).not.toHaveBeenCalled();
    h.devs.devices.rename.mockRejectedValueOnce(new DeviceConnectionsError('invalid_name'));
    expect(await h.invoke(desktopChannels.devicesRename, REMOTE_A, '')).toEqual({ ok: false, error: { kind: 'validation', code: 'invalid_name', message: '名字要 1 到 40 个字。' } });
    expect(await h.invoke(desktopChannels.devicesRemove, REMOTE_A)).toEqual({ ok: true, value: { revokedRemotely: false } });
    await h.bridge.dispose();
  });
});

it('carries only typed acquisition outcomes through the actual community IPC and facade', async () => {
  const h = harness();
  const accountId = '11111111-1111-4111-8111-111111111111';
  const versionId = '22222222-2222-4222-8222-222222222222';
  Object.assign(h.account, {status: () => ({kind: 'signedIn', accountId})});
  const {shell} = createDesktopFacades({
    invoke: async (channel, ...args) => structuredClone(await handlers.get(channel)!(h.event, ...args)),
    receive: () => () => {},
  });
  const request = {type: 'acquire' as const, accountId, versionId, requestId: 'a2.01932a00-0000-7abc-8def-0123456789ab', code: 'TEST-CODE'};
  for (const [code, status] of [['operation_expired',410],['operation_clock_skew',422],['request_upgrade_required',409],['acquire_rate_limited',429]] as const) {
    h.account.request.mockResolvedValueOnce(Response.json({error:{code, message:'DO-NOT-FORWARD-CODE'}}, {status, headers:{'Retry-After':'123'}}));
    expect(await shell.community.request(request)).toEqual({ok:false,error:{code,retryAfter:123}});
  }
  h.account.request.mockResolvedValueOnce(Response.json({error:{code:'DO-NOT-FORWARD-CODE'}}, {status:503}));
  expect(await shell.community.request(request)).toEqual({ok:false,error:{code:'unavailable'}});
  h.account.request.mockRejectedValueOnce(new Error('DO-NOT-FORWARD-CODE'));
  expect(await shell.community.request(request)).toEqual({ok:false,error:{code:'unavailable'}});
  h.account.request.mockResolvedValueOnce(Response.json({recipeId:versionId,versionId,owned:false,acquired:true}));
  expect(await shell.community.request(request)).toEqual({ok:true,value:{recipeId:versionId,versionId,owned:false,acquired:true}});
  expect(Object.keys(shell.community)).toEqual(['request']);
  await h.bridge.dispose();
});

it('preserves the real redeem HTTP limiter outcome through serialized main IPC and the facade',async()=>{
  const apiSource=new URL('../../../services/recipe-api/src/http.mjs',import.meta.url).href;
  const errorSource=new URL('../../../services/recipe-api/src/errors.mjs',import.meta.url).href;
  const limiterSource=new URL('../../../services/recipe-api/src/limiter.mjs',import.meta.url).href;
  const {createRecipeServer}=await import(apiSource);
  const {ApiError}=await import(errorSource);
  const {codeAttempts}=await import(limiterSource);
  const execute=vi.fn(async()=>{throw new ApiError(422,'invalid_code');});
  const server:Server=createRecipeServer({verify:async()=>({issuer:'https://project.example/auth/v1',subject:REMOTE_A}),execute,attempts:codeAttempts({now:()=>1000})});
  const h=harness();
  try {
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();if(!address||typeof address==='string')throw new Error('Missing HTTP port');
    Object.assign(h.account,{status:()=>({kind:'signedIn',accountId:REMOTE_A}),request:vi.fn(async(_accountId:string,path:string,init:RequestInit)=>fetch(`http://127.0.0.1:${address.port}`+path,{...init,headers:{...init.headers,Authorization:'Bearer synthetic'}}))});
    const {shell}=createDesktopFacades({invoke:async(channel,...args)=>structuredClone(await handlers.get(channel)!(h.event,...args)),receive:()=>()=>{}});
    const request={type:'acquire' as const,accountId:REMOTE_A,versionId:REMOTE_B,requestId:'a2.01932a00-0000-7abc-8def-0123456789ab',code:'TEST-CODE'};
    for(let n=0;n<10;n++)expect(await shell.community.request(request)).toEqual({ok:false,error:{code:'invalid_code'}});
    expect(await shell.community.request(request)).toEqual({ok:false,error:{code:'rate_limited',retryAfter:600}});
    expect(execute).toHaveBeenCalledTimes(10);expect(Object.keys(shell.community)).toEqual(['request']);
  } finally {await h.bridge.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it('continues through the public shell IPC on its fixed local source after hide and another-device view',async()=>{
  const h=harness(),accountId=REMOTE_A,session=REMOTE_B,botId=agentIdSchema.parse('cli_creator'),groupId=groupIdSchema.parse('oc_creator');
  const signal=new AbortController(),calls:RecipeAuthoringRequest[]=[];
  const state:AccountStatus={kind:'signedIn',accountId,displayName:'作者',provider:'google',persistence:'memory'};
  Object.assign(h.account,{status:()=>state,lease:(id:string)=>id===accountId?signal.signal:undefined});
  h.account.request.mockImplementation(async()=>Response.json({accountId}));
  Object.assign(h.owner.client,{
    device:async()=>({kind:'deviceStatus',status:{device:{id:REMOTE_A,name:'本机',publicKey:Buffer.alloc(32,4).toString('base64url')},remote:{addresses:[],port:3000},clients:{active:1,total:1}}}),
    snapshot:async()=>({stale:false,host:{kind:'connected'},agents:[{id:botId,name:'原 Bot',running:true,connection:'connected',tenant:'feishu'}],groups:[{id:groupId,name:'原群'}],memberships:[{agentId:botId,groupId,enabled:true,stale:false}]}),
    recipeAuthoring:async(r:RecipeAuthoringRequest):Promise<RecipeAuthoringReply>=>{
      calls.push(r);
      switch(r.type){
        case 'creatorDiscover':return {kind:'creatorBinding',association:{binding:REMOTE_A,scope:'a'.repeat(64),recipient:{openId:'ou_author',chatId:groupId,tenantKey:'test'}},wakeId:null};
        case 'creatorOpen':return {kind:'creatorSession',session,binding:r.binding,scope:r.scope,leaseMs:45000};
        case 'creatorPoll':return {kind:'creatorJobs',jobs:[]};
        case 'workflow':return {kind:'workflow',activity:1,ageMs:0,pausedContexts:[]};
        case 'status':return {kind:'status',linked:true,operations:[],reconciliation:[]};
        case 'groupSourceIdentity':return {kind:'groupSourceIdentity',groupId,identity:'b'.repeat(64)};
        case 'beginHandoff':return {kind:'handoff',handoff:{retryId:r.retryId,groupId,state:'selecting'}};
        case 'close':return {kind:'closed'};
        default:throw Error(r.type);
      }
    },
  });
  const {shell}=createDesktopFacades({invoke:(channel,...args)=>h.invoke(channel,...args),receive:()=>()=>{}});
  const input={type:'creatorContinue' as const,retryId:REMOTE_A,accountId,entry:{kind:'source' as const,viewId:'local',botId,groupId}};
  expect(await shell.recipeAuthoring.request(input)).toEqual({kind:'creatorContinuing',delivery:'delivered',retryId:REMOTE_A,accountId,viewId:'local',botId,tenant:'feishu',botName:'原 Bot'});
  await shell.hideWindow();await h.devs.show(remoteView(REMOTE_A,remoteClient()));
  expect(await shell.recipeAuthoring.request(input)).toMatchObject({kind:'creatorContinuing',viewId:'local'});
  expect(calls.filter(r=>r.type==='creatorOpen')).toHaveLength(1);
  expect(calls.filter(r=>r.type==='open'||r.type==='close')).toEqual([]);
  await h.bridge.dispose();expect(calls.filter(r=>r.type==='close')).toEqual([{type:'close',botId,session}]);
});

it('routes exact resource intents through the native owner and refuses retired installer entry points', async () => {
  const h = harness(), accountId = REMOTE_A, botId = agentIdSchema.parse('cli_resource');
  const target = {recipeId: REMOTE_A, versionId: REMOTE_B};
  const input = {type: 'resourceHandoff' as const, accountId, viewId: 'local', botId, target, requestId: REMOTE_B};
  const deliver = vi.spyOn(RecipeCreatorSupervisor.prototype, 'resourceHandoff').mockImplementation(async request => ({
    kind: 'resourceHandoff', accountId: request.accountId, viewId: request.viewId, botId: request.botId,
    target: request.target, requestId: request.requestId, tenant: 'feishu', botName: '资源 Bot', delivery: 'sent',
  }));
  try {
    const {shell} = createDesktopFacades({invoke: (channel, ...args) => h.invoke(channel, ...args), receive: () => () => {}});
    expect(await shell.recipeAuthoring.request(input)).toMatchObject({kind: 'resourceHandoff', target, delivery: 'sent'});
    expect(deliver).toHaveBeenCalledExactlyOnceWith(input);
    expect(await h.invoke(desktopChannels.recipeUse, {type: 'begin', accountId, viewId: 'local', botId, ...target})).toMatchObject({ok: false});
    expect(await h.invoke(desktopChannels.recipeSource, {type: 'read', viewId: 'local', botId, groupId: 'oc_resource'})).toMatchObject({ok: false});
    expect(h.account.request).not.toHaveBeenCalled();
  } finally {deliver.mockRestore(); await h.bridge.dispose();}
});
