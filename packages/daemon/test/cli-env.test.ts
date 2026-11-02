import { expect, it, vi } from 'vitest';
import { ConnectionError, RpcError, type VonvonClient } from '@vonvon/client';
import { rpcKinds, type BackendInstallEventPayload, type EnvironmentRequest } from '@vonvon/protocol';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { stepLines } from '../src/cli/commands/bot';
import {
  runEnvBackendInstall, runEnvCancel, runEnvInstall, runEnvLogin, runEnvProfileAdd, runEnvProfileInit, runEnvProfileInitState, runEnvScan, type EnvDependencies,
} from '../src/cli/commands/env';
import { runProviderModels } from '../src/cli/commands/provider';
import { CLI_PARITY_ALLOWLIST } from '../src/cli/parity-allowlist';
import { loadCommands } from './helpers/cli-commands';

/** cli-7-environment: vonvon env … and provider models, each through a fake client behind the real withDaemon. */
const OP1 = '11111111-1111-4111-8111-111111111111';
const OP2 = '22222222-2222-4222-8222-222222222222';
/** this command's request id (deps.requestId), and another caller's */
const REQ = '33333333-3333-4333-8333-333333333333';
const THEIRS = '44444444-4444-4444-8444-444444444444';
type Handle = (request: EnvironmentRequest) => unknown;
/**
 * A fake daemon: `handle` answers each environment request; `drop()` loses the connection as the real client does (each
 * request in flight fails, then the error is told), `push()` sends an install event.
 */
function envHarness(handle: Handle, extra: Record<string, unknown> = {}, o: { tty?: boolean; secret?: string; ms?: number } = {}) {
  let onError: ((error: Error) => void) | undefined;
  let onInstall: ((payload: BackendInstallEventPayload) => void) | undefined;
  let interrupt: (() => void) | undefined;
  const order: string[] = [];
  const inFlight = new Set<(error: Error) => void>();
  const failAll = (error: Error) => { for (const reject of [...inFlight]) reject(error); inFlight.clear(); };
  let dropped = false;
  const environment = vi.fn(async (request: EnvironmentRequest) => {
    order.push(request.type);
    if (dropped) throw new ConnectionError(new Error('Daemon connection closed'));
    return handle(request);
  });
  const client = {
    environment, close: vi.fn(async () => { failAll(new Error('Daemon connection closed')); }),
    onError: (listener: (error: Error) => void) => { onError = listener; return () => { onError = undefined; }; },
    onBackendInstall: (listener: (payload: BackendInstallEventPayload) => void) => { order.push('listen'); onInstall = listener; return () => { onInstall = undefined; }; },
    ...extra,
  };
  const connect = vi.fn(async () => client as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, { local: o.ms ?? 50, feishu: o.ms ?? 50 });
  let out = '';
  const deps: Partial<EnvDependencies> = {
    tty: o.tty ?? false,
    qr: async url => `[QR ${url}]\n`,
    onInterrupt: handler => { interrupt = handler; return () => { interrupt = undefined; }; },
    wait: () => new Promise(done => { setTimeout(done, 0); }),
    readSecret: async () => o.secret ?? '',
    requestId: () => REQ,
  };
  return {
    daemon, deps, connect, environment, order,
    io: (json = false) => ({ json, write: (text: string) => { out += text; } }),
    out: () => out, lines: () => out.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>),
    sent: () => environment.mock.calls.map(([request]) => request),
    drop: () => { dropped = true; const error = new ConnectionError(new Error('Daemon connection closed')); failAll(error); onError?.(error); },
    push: (payload: BackendInstallEventPayload) => onInstall?.(payload),
    interrupt: () => interrupt?.(),
    /** a request the daemon answers later, failed when the client closes or the connection drops, as the real one is */
    later: <T>() => {
      let settle!: (value: T) => void;
      let fail!: (error: Error) => void;
      const promise = new Promise<T>((resolve, reject) => { settle = resolve; fail = reject; inFlight.add(reject); });
      return { promise, settle: (value: T) => { inFlight.delete(fail); settle(value); }, fail: (error: Error) => { inFlight.delete(fail); fail(error); } };
    },
  };
}
const failure = (kind: string, message?: unknown, extra: object = {}) => expect.objectContaining({ kind, ...(message === undefined ? {} : { message }), ...extra });
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error('resolved'); }, (error: unknown) => error as { kind: string; message: string; reason?: string });

const tool = (name: string, extra: object = {}) => ({ tool: name, installation: 'missing', executable: null, version: null, managedVersion: null, latestVersion: null, updateAvailable: null, canUninstall: false, ...extra });
const TOOLS = [
  tool('codex', { installation: 'managed', executable: 'codex', version: '0.128.0', managedVersion: '0.128.0', latestVersion: '0.129.0', updateAvailable: true, canUninstall: true }),
  tool('claude'),
  tool('lark-cli', { installation: 'external', executable: 'lark-cli', version: '1.2.3', latestVersion: '1.2.3', updateAvailable: false, source: 'npm', updateInstructions: 'npm install -g @larksuite/cli' }),
];

// main 必败: there was no env scan
it('env scan reads the sign-in of each installed tool, and one failing read leaves the rest', async () => {
  const h = envHarness(request => {
    if (request.type === 'scan') return { kind: 'tools', tools: TOOLS };
    if (request.type === 'authStatus' && request.tool === 'codex') return { kind: 'auth', tool: 'codex', state: 'signedIn', message: '已授权' };
    throw new RpcError('internal', '查不了');
  });
  await runEnvScan(h.io(true), h.daemon);
  expect(h.sent()).toEqual([{ type: 'scan' }, { type: 'authStatus', tool: 'codex' }, { type: 'authStatus', tool: 'lark-cli' }]);
  const json = JSON.parse(h.out()) as { ok: boolean; tools: Array<Record<string, unknown>> };
  expect(json.ok).toBe(true);
  expect(json.tools.map(each => each.auth)).toEqual([{ state: 'signedIn', message: '已授权' }, undefined, undefined]);
  const human = envHarness(request => request.type === 'scan' ? { kind: 'tools', tools: TOOLS }
    : { kind: 'auth', tool: (request as { tool: string }).tool, state: 'signedOut', message: '尚未授权' });
  await runEnvScan(human.io(), human.daemon);
  expect(human.out()).toBe([
    'Codex  0.128.0（托管，有新版本 0.129.0）  没配置好：在终端里运行 codex 配置（账号或自定义 API 都行）', 'Claude  没装',
    'lark-cli  1.2.3（系统里的，npm）  没登录：运行 vonvon env login lark-cli', '    npm install -g @larksuite/cli', ''].join('\n'));
});

const running = (id: string, extra: object = {}) => ({ kind: 'running', id, tool: 'codex', update: false, startedAt: 1, ...extra });
/** a running install this command's request started: its state carries the request id */
const mine = (id: string, extra: object = {}) => running(id, { requestId: REQ, ...extra });
/**
 * A tool install: the states in turn (the last one stays), and the install's own answer once a state with an end was
 * read (`now`, or busy: at once). `strict`: a daemon from before request ids, which refuses the field.
 */
function installer(states: unknown[], answer: unknown, hooks: { onRead?: (index: number) => void; now?: boolean; strict?: boolean } = {}) {
  let read = 0;
  let pending: { settle: (value: unknown) => void } | undefined;
  const h = envHarness(request => {
    if (request.type === 'toolInstallStatus') {
      const index = read++;
      const operation = states[Math.min(index, states.length - 1)] ?? null;
      hooks.onRead?.(index);
      if (operation && (operation as { kind: string }).kind !== 'running' && (operation as { id: string }).id === OP1) pending?.settle(answer);
      return { kind: 'toolInstall', operation };
    }
    if (request.type === 'install' || request.type === 'update') {
      if (hooks.strict && 'requestId' in request) throw new RpcError('invalid_request', '请求参数无效。');
      const reply = h.later<unknown>();
      pending = reply;
      if (hooks.now || (answer as { code?: string }).code === 'busy') reply.settle(answer);
      return reply.promise;
    }
    if (request.type === 'cancelInstall') { pending?.settle({ kind: 'refused', code: 'install-cancelled', message: '已取消安装，原工具仍可使用。' }); return { kind: 'toolInstall', operation: { kind: 'cancelled', id: OP1, message: '已取消。' } }; }
    if (request.type === 'scan') return { kind: 'tools', tools: [tool('codex', { installation: 'managed', version: '0.129.0' })] };
    throw new Error(`unexpected ${request.type}`);
  });
  return h;
}

// main 必败: there was no env install
it('env install follows its own operation to the end, not the one before it', async () => {
  const done = { kind: 'succeeded', id: OP1, message: 'codex 0.129.0 已安装。' };
  const h = installer([{ kind: 'failed', id: OP2, message: '上一次失败了' }, { kind: 'failed', id: OP2, message: '上一次失败了' }, mine(OP1), mine(OP1), done], { kind: 'applied', message: done.message });
  await runEnvInstall('codex', false, h.io(true), h.daemon, h.deps);
  expect(h.sent()[0]).toEqual({ type: 'install', tool: 'codex', requestId: REQ });
  expect(h.lines()).toEqual([
    { event: 'progress', state: 'running', operationId: OP1 },
    { ok: true, event: 'result', tool: 'codex', version: '0.129.0', message: 'codex 0.129.0 已安装。' },
  ]);
  const human = installer([null, mine(OP1, { update: true }), { ...done, message: 'codex 0.129.0 已更新。' }], { kind: 'applied', message: 'codex 0.129.0 已更新。' });
  await runEnvInstall('codex', true, human.io(), human.daemon, human.deps);
  expect(human.sent()).toContainEqual({ type: 'update', tool: 'codex', requestId: REQ });
  expect(human.out()).toBe('正在更新 Codex…（Ctrl-C 取消）\n✓ codex 0.129.0 已更新。\n');
  await expect(runEnvInstall('nope', false, human.io(), human.daemon, human.deps)).rejects.toEqual(failure('bad-args'));
});

// main 必败: there was no env install
it('env install: an install that failed exits 1, one refused before it started exits 4', async () => {
  const failed = installer([null, mine(OP1), { kind: 'failed', id: OP1, message: '网络不通' }], { kind: 'refused', code: 'install-failed', message: '网络不通' });
  expect(await caught(runEnvInstall('codex', false, failed.io(true), failed.daemon, failed.deps))).toEqual(failure('failed', '网络不通', { reason: 'install_failed' }));
  const busy = installer([null], { kind: 'refused', code: 'busy', message: '另一个本机环境操作正在进行。' });
  expect(await caught(runEnvInstall('codex', false, busy.io(true), busy.daemon, busy.deps))).toEqual(failure('refused', '另一个本机环境操作正在进行。', { reason: 'busy' }));
  expect(busy.sent().filter(request => request.type === 'cancelInstall')).toEqual([]);
});

// main 必败: there was no env install
it('env install: Ctrl-C cancels its operation; a dropped connection is 6 after it started and 3 before', async () => {
  const stopped = installer([null, mine(OP1)], {}, { onRead: index => { if (index === 2) setTimeout(() => stopped.interrupt(), 0); } });
  expect(await caught(runEnvInstall('codex', false, stopped.io(true), stopped.daemon, stopped.deps))).toEqual(failure('interrupted', '已取消安装。'));
  expect(stopped.sent()).toContainEqual({ type: 'cancelInstall', operationId: OP1 });
  const after = installer([null, mine(OP1)], {}, { onRead: index => { if (index === 2) setTimeout(() => after.drop(), 0); } });
  expect(await caught(runEnvInstall('codex', false, after.io(true), after.daemon, after.deps))).toEqual(failure('outcome-unknown', expect.stringContaining('安装可能还在进行，运行 vonvon env scan 看。')));
  const before = installer([null], {}, { onRead: index => { if (index === 1) setTimeout(() => before.drop(), 0); } });
  expect(await caught(runEnvInstall('codex', false, before.io(true), before.daemon, before.deps))).toEqual(failure('connection'));
});

const login = (id: string, url?: string) => ({ kind: 'running', id, purpose: { kind: 'login', tool: 'lark-cli' }, startedAt: 1, ...(url ? { url } : {}) });
// main 必败: there was no env login
it('env login takes lark-cli only, and prints a link each time it changes', async () => {
  const none = envHarness(() => { throw new Error('sent'); });
  expect(await caught(runEnvLogin('codex', none.io(), none.daemon, none.deps))).toEqual(failure('bad-args', 'vonvon 只管 lark-cli 的登录；Codex、Claude 在它们自己的命令行里登录。'));
  expect(none.connect).not.toHaveBeenCalled();
  const states = [login(OP1, 'https://open.feishu.cn/a'), login(OP1, 'https://open.feishu.cn/a'), login(OP1, 'https://open.feishu.cn/b'), { kind: 'succeeded', id: OP1, message: '操作已完成。' }];
  const signIn = (tty = false) => {
    let read = 0;
    return envHarness(request => {
      if (request.type === 'startLogin') return { kind: 'operation', operation: login(OP1) };
      if (request.type === 'loginStatus') return { kind: 'operation', operation: states[Math.min(read++, states.length - 1)] };
      if (request.type === 'authStatus') return { kind: 'auth', tool: 'lark-cli', state: 'signedIn', message: '已授权' };
      throw new Error(`unexpected ${request.type}`);
    }, {}, { tty });
  };
  const h = signIn();
  await runEnvLogin('lark-cli', h.io(true), h.daemon, h.deps);
  expect(h.sent()[0]).toEqual({ type: 'startLogin', tool: 'lark-cli' });
  expect(h.lines()).toEqual([
    { event: 'progress', state: 'running', operationId: OP1 },
    { event: 'url', url: 'https://open.feishu.cn/a' }, { event: 'url', url: 'https://open.feishu.cn/b' },
    { ok: true, event: 'result', auth: { state: 'signedIn', message: '已授权' } },
  ]);
  const tty = signIn(true);
  await runEnvLogin('lark-cli', tty.io(), tty.daemon, tty.deps);
  expect(tty.out()).toBe(['正在登录 lark-cli…（Ctrl-C 取消）', '在浏览器里打开：https://open.feishu.cn/a', '或者用手机扫：', '[QR https://open.feishu.cn/a]',
    '在浏览器里打开：https://open.feishu.cn/b', '或者用手机扫：', '[QR https://open.feishu.cn/b]', '✓ lark-cli 已登录。', ''].join('\n'));
});

// main 必败: there was no env profile add
it('env profile add takes the App Secret from the prompt or stdin and prints it nowhere', async () => {
  const secret = 'S3cr3t-value-for-test';
  const profiles = [{ name: 'p1', appId: 'cli_x', brand: 'feishu', active: false }];
  const h = envHarness(() => ({ kind: 'profiles', profiles }), {}, { secret: `${secret}\n` });
  await runEnvProfileAdd('p1', { appId: 'cli_x' }, h.io(true), h.daemon, h.deps);
  expect(h.sent()).toEqual([{ type: 'profileAdd', name: 'p1', appId: 'cli_x', appSecret: secret, brand: 'feishu', use: false }]);
  expect(h.out()).not.toContain(secret);
  expect(JSON.parse(h.out())).toEqual({ ok: true, message: '已添加应用配置「p1」。', profiles });
  const human = envHarness(() => ({ kind: 'profiles', profiles }), {}, { secret });
  await runEnvProfileAdd('p1', { appId: 'cli_x', brand: 'lark', use: true }, human.io(), human.daemon, human.deps);
  expect(human.sent()).toEqual([expect.objectContaining({ brand: 'lark', use: true })]);
  expect(human.out()).toBe('✓ 已添加应用配置「p1」，现在用它。\n');
  // nothing to read: nothing sent, an argument error that names no secret
  const empty = envHarness(() => ({ kind: 'profiles', profiles }), {}, { secret: ' \n' });
  expect(await caught(runEnvProfileAdd('p1', { appId: 'cli_x' }, empty.io(), empty.daemon, empty.deps))).toEqual(failure('bad-args', expect.stringContaining('没读到 App Secret')));
  expect(empty.sent()).toEqual([]);
  // a secret the request refuses: the error names the field, never the value
  const bad = envHarness(() => ({ kind: 'profiles', profiles }), {}, { secret: 'a\u0000b' });
  const refused = await caught(runEnvProfileAdd('p1', { appId: 'cli_x' }, bad.io(), bad.daemon, bad.deps));
  expect(refused).toEqual(failure('bad-args'));
  expect(refused.message).not.toContain('a\u0000b');
  expect(await caught(runEnvProfileAdd('p1', { appId: 'cli_x', brand: 'x' }, bad.io(), bad.daemon, bad.deps))).toEqual(failure('bad-args', '--brand 写 feishu 或 lark。'));
});

// main 必败: there was no env profile init --cancel
it('env profile init --cancel cancels an app profile being made, and exits 0 when none is', async () => {
  const idle = envHarness(() => ({ kind: 'operation', operation: null }));
  await runEnvProfileInitState('cancel', idle.io(true), idle.daemon);
  expect(JSON.parse(idle.out())).toEqual({ ok: true, cancelled: false });
  expect(idle.sent()).toEqual([{ type: 'profileInitStatus' }]);
  const busy = envHarness(request => request.type === 'profileInitStatus'
    ? { kind: 'operation', operation: { kind: 'running', id: OP1, purpose: { kind: 'profileInit' }, startedAt: 1 } }
    : { kind: 'operation', operation: { kind: 'cancelled', id: OP1, message: '已取消。' } });
  await runEnvProfileInitState('cancel', busy.io(true), busy.daemon);
  expect(busy.sent()).toEqual([{ type: 'profileInitStatus' }, { type: 'profileInitCancel', operationId: OP1 }]);
  expect(JSON.parse(busy.out())).toEqual({ ok: true, cancelled: true });
  // a lark-cli sign-in shares the state: it is not this one's to cancel
  const signIn = envHarness(() => ({ kind: 'operation', operation: login(OP1) }));
  await runEnvProfileInitState('cancel', signIn.io(), signIn.daemon);
  expect(signIn.sent()).toEqual([{ type: 'profileInitStatus' }]);
  expect(signIn.out()).toBe('没有在进行的应用配置。\n');
  const status = envHarness(() => ({ kind: 'operation', operation: null }));
  await runEnvProfileInitState('status', status.io(true), status.daemon);
  expect(JSON.parse(status.out())).toEqual({ ok: true, operation: null });
});

/** A component install: the reply after an event that came before it, then `events` one each. */
function component(events: BackendInstallEventPayload[], extra: Record<string, unknown> = {}) {
  const h = envHarness(request => {
    if (request.type === 'backendInstall') {
      h.push({ operationId: OP1, id: 'cbridge', update: false, item: { type: 'log', chunk: 'early\n' } });
      setTimeout(() => { for (const event of events) h.push(event); }, 0);
      return { kind: 'backendInstall', operationId: OP1, id: 'cbridge', update: false, attached: false, replay: [{ type: 'log', chunk: 'a\n' }, { type: 'log', chunk: 'b\n' }], ...extra };
    }
    if (request.type === 'backendCatalog') return { kind: 'backends', entries: [{ id: 'cbridge', displayName: 'C', depKind: 'npm-ondemand', depState: 'installed', installable: false, version: '1.0.0', installedVersion: '1.0.0', canUninstall: true }] };
    throw new Error(`unexpected ${request.type}`);
  });
  return h;
}
const event = (operationId: string, item: BackendInstallEventPayload['item']): BackendInstallEventPayload => ({ operationId, id: 'cbridge', update: false, item });

// main 必败: there was no env backend install
it('env backend install listens before it asks, prints the replay first, then its own events only', async () => {
  const h = component([event(OP2, { type: 'log', chunk: 'not mine\n' }), event(OP1, { type: 'log', chunk: 'c\n' }), event(OP1, { type: 'done' })]);
  await runEnvBackendInstall('cbridge', false, h.io(true), h.daemon, h.deps);
  expect(h.order.slice(0, 2)).toEqual(['listen', 'backendInstall']);
  expect(h.sent()[0]).toEqual({ type: 'backendInstall', id: 'cbridge', update: false, requestId: REQ });
  expect(h.lines()).toEqual([
    { event: 'progress', state: 'running', operationId: OP1, attached: false },
    { event: 'log', chunk: 'a\n' }, { event: 'log', chunk: 'b\n' }, { event: 'log', chunk: 'early\n' }, { event: 'log', chunk: 'c\n' },
    { ok: true, event: 'result', id: 'cbridge', version: '1.0.0' },
  ]);
  // control characters go, \r\n is a line break, and output that ends mid-line gets one before the result
  const human = component([event(OP1, { type: 'log', chunk: 'c\r\n\u001b[2Kd' }), event(OP1, { type: 'done' })]);
  await runEnvBackendInstall('cbridge', false, human.io(), human.daemon, human.deps);
  expect(human.out()).toBe('正在安装组件 cbridge…（Ctrl-C 取消）\na\nb\nearly\nc\n[2Kd\n✓ 已安装组件 cbridge 1.0.0。\n');
  const aborted = component([event(OP1, { type: 'error', code: 'aborted', message: '安装已取消。' })]);
  expect(await caught(runEnvBackendInstall('cbridge', false, aborted.io(true), aborted.daemon, aborted.deps))).toEqual(failure('failed', expect.stringContaining('安装已取消。'), { reason: 'cancelled' }));
  const broken = component([event(OP1, { type: 'error', code: 'install_failed', message: 'npm 失败' })]);
  expect(await caught(runEnvBackendInstall('cbridge', false, broken.io(true), broken.daemon, broken.deps))).toEqual(failure('failed', 'npm 失败', { reason: 'install_failed' }));
  // the replay holds the end already: nothing more comes
  const ended = component([], { replay: [{ type: 'log', chunk: 'a\n' }, { type: 'done' }] });
  await runEnvBackendInstall('cbridge', false, ended.io(true), ended.daemon, ended.deps);
  expect(ended.lines().at(-1)).toMatchObject({ ok: true, event: 'result', id: 'cbridge' });
});

// main 必败: there was no env cancel
it('env cancel reads the operation id first, then cancels that one', async () => {
  const backend = envHarness(request => request.type === 'backendInstallStatus'
    ? { kind: 'backendInstallStatus', operation: { operationId: OP1, id: 'cbridge', update: false, state: 'running', replay: [], omittedBytes: 0 } }
    : { kind: 'applied', message: '已请求取消安装。' });
  await runEnvCancel('backend', 'cbridge', backend.io(true), backend.daemon);
  expect(backend.sent()).toEqual([{ type: 'backendInstallStatus', id: 'cbridge' }, { type: 'cancelBackendInstall', operationId: OP1 }]);
  expect(JSON.parse(backend.out())).toEqual({ ok: true, cancelled: true });
  const install = envHarness(request => request.type === 'toolInstallStatus' ? { kind: 'toolInstall', operation: running(OP1) } : { kind: 'refused', code: 'not-running', message: '安装操作已结束。' });
  await runEnvCancel('install', undefined, install.io(), install.daemon);
  expect(install.sent()).toEqual([{ type: 'toolInstallStatus' }, { type: 'cancelInstall', operationId: OP1 }]);
  expect(install.out()).toBe('没有在进行的安装。\n');
  await expect(runEnvCancel('backend', undefined, install.io(), install.daemon)).rejects.toEqual(failure('bad-args'));
  await expect(runEnvCancel('profile', undefined, install.io(), install.daemon)).rejects.toEqual(failure('bad-args'));
});

type Later = { promise: Promise<unknown>; settle: (value: unknown) => void; fail: (error: Error) => void };
const BUSY = { kind: 'refused', code: 'busy', message: '另一个本机环境操作正在进行。' };
// 审查 201 第 1 条: after a busy refusal the state was read, and another caller's end there taken for this one's (exit 0)
it("env install: busy stays refused (4), whatever another caller's install shows in the state", async () => {
  const theirs = { kind: 'succeeded', id: OP2, message: 'lark-cli installed by another caller' };
  const after = installer([null, theirs], BUSY);
  expect(await caught(runEnvInstall('codex', false, after.io(true), after.daemon, after.deps))).toEqual(failure('refused', BUSY.message, { reason: 'busy' }));
  expect(after.out()).toBe('');
  // their install of the same tool runs when this one asks, and its end is read before the busy answer is
  const states = [null, running(OP2), theirs];
  let read = 0;
  let reply: Later | undefined;
  const late = envHarness(request => {
    if (request.type === 'install') { reply = late.later<unknown>(); return reply.promise; }
    if (request.type === 'toolInstallStatus') {
      const operation = states[Math.min(read++, states.length - 1)];
      if (operation === theirs) setTimeout(() => reply?.settle(BUSY), 5);
      return { kind: 'toolInstall', operation };
    }
    throw new Error(`unexpected ${request.type}`);
  });
  expect(await caught(runEnvInstall('codex', false, late.io(true), late.daemon, late.deps))).toEqual(failure('refused', BUSY.message, { reason: 'busy' }));
  expect(late.out()).not.toContain('"result"');
  expect(late.out()).not.toContain('"progress"');
  expect(late.sent().filter(request => request.type === 'cancelInstall')).toEqual([]);
});

const profileRun = (id: string) => ({ kind: 'running', id, purpose: { kind: 'profileInit' }, startedAt: 1 });
type Harness = ReturnType<typeof envHarness>;
type Job = { job: string; status?: EnvironmentRequest['type']; cancel: EnvironmentRequest['type']; run: (h: Harness) => Promise<void> };
/** The four long jobs share track() and follow(): what Ctrl-C does is the same in each. */
const JOBS: Job[] = [
  { job: 'env install', status: 'toolInstallStatus', cancel: 'cancelInstall', run: h => runEnvInstall('codex', false, h.io(true), h.daemon, h.deps) },
  { job: 'env login', status: 'loginStatus', cancel: 'cancelLogin', run: h => runEnvLogin('lark-cli', h.io(true), h.daemon, h.deps) },
  { job: 'env profile init', status: 'profileInitStatus', cancel: 'profileInitCancel', run: h => runEnvProfileInit('p1', h.io(true), h.daemon, h.deps) },
  { job: 'env backend install', cancel: 'cancelBackendInstall', run: h => runEnvBackendInstall('cbridge', false, h.io(true), h.daemon, h.deps) },
];
/**
 * A daemon that has started `job` as OP1 and never ends it: its state reads say running, its cancel is never answered
 * unless the test does (`cancels`); no request times out locally. `hold`: a request stays in flight (`held()`): the first state read after the
 * progress line, or the component install's own request.
 */
function racing(job: Job, o: { hold?: boolean; wait?: EnvDependencies['wait']; client?: Record<string, unknown> } = {}) {
  let reads = 0;
  let held: Later | undefined;
  const cancels: Later[] = [];
  const h = envHarness(request => {
    if (request.type === job.cancel) { const reply = h.later<unknown>(); cancels.push(reply); return reply.promise; }
    if (request.type === job.status) {
      const index = reads++;
      if (o.hold && !held && h.out().includes('"progress"')) { held = h.later<unknown>(); return held.promise; }
      if (request.type === 'toolInstallStatus') return { kind: 'toolInstall', operation: mine(OP1) };
      return { kind: 'operation', operation: request.type === 'loginStatus' ? login(OP1) : profileRun(OP1) };
    }
    switch (request.type) {
      case 'install': return h.later<unknown>().promise;
      case 'startLogin': return { kind: 'operation', operation: login(OP1) };
      case 'profileInit': return { kind: 'operation', operation: profileRun(OP1) };
      case 'backendInstall':
        if (o.hold) { held = h.later<unknown>(); return held.promise; }
        return { kind: 'backendInstall', operationId: OP1, id: 'cbridge', update: false, attached: false, replay: [] };
      case 'backendInstallStatus': return { kind: 'backendInstallStatus', operation: { operationId: OP1, id: 'cbridge', update: false, requestId: REQ, state: 'running', replay: [], omittedBytes: 0 } };
    }
    throw new Error(`unexpected ${request.type}`);
  }, o.client ?? {}, { ms: 60_000 });
  if (o.wait) h.deps.wait = o.wait;
  return Object.assign(h, { reads: () => reads, held: () => held, cancels });
}
const cancelSent = async (h: Harness, job: Job) => { await vi.waitFor(() => { expect(h.sent()).toContainEqual({ type: job.cancel, operationId: OP1 }); }); };
const started = async (h: Harness) => { await vi.waitFor(() => { expect(h.out()).toContain('"progress"'); }); };

// 审查 201 第 2 条: the dropped connection ended it as lost, 6
it.each(JOBS)('$job: Ctrl-C, then the connection drops before the cancel is answered: still 130', async job => {
  const h = racing(job);
  const result = caught(job.run(h));
  await started(h);
  h.interrupt();
  await cancelSent(h, job);
  h.drop();
  expect(await result).toEqual(failure('interrupted'));
});

// 审查 201 第 2 条: the request in flight failed and that failure was the command's
it.each(JOBS)('$job: Ctrl-C while a request is in flight, and that request fails: still 130, nothing read after', async job => {
  const h = racing(job, { hold: true });
  const result = caught(job.run(h));
  await vi.waitFor(() => { expect(h.held()).toBeDefined(); });
  h.interrupt();
  await cancelSent(h, job);
  const reads = h.reads();
  h.held()?.fail(new Error('poll failed during cancel'));
  await new Promise(done => { setTimeout(done, 20); });
  h.cancels[0]?.settle({ kind: 'applied', message: '已取消。' });
  expect(await result).toEqual(failure('interrupted'));
  expect(h.reads()).toBe(reads);
});

// 审查 201 第 2 条: the state was still read every pause while the cancel waited
it.each(JOBS)('$job: a second Ctrl-C ends it at once, and nothing is read after the first', async job => {
  const h = racing(job);
  const result = caught(job.run(h));
  await started(h);
  h.interrupt();
  const reads = h.reads();
  await cancelSent(h, job);
  // the pauses between reads (0 ms here) go by while the cancel is not answered
  await new Promise(done => { setTimeout(done, 20); });
  h.interrupt();
  expect(await result).toEqual(failure('interrupted'));
  expect(h.reads()).toBe(reads);
});

// 审查 201 第 2 条: the state was still read each second while the cancel waited
it.each(JOBS)('$job: a cancel never answered ends it after 5 s as 130, with nothing read meanwhile', async job => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const h = racing(job, { wait: ms => new Promise(done => { setTimeout(done, ms); }) });
    let ended = false;
    const result = caught(job.run(h)).finally(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.out()).toContain('"progress"');
    h.interrupt();
    const reads = h.reads();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.sent()).toContainEqual({ type: job.cancel, operationId: OP1 });
    expect(ended).toBe(false);
    expect(h.reads()).toBe(reads);
    await vi.advanceTimersByTimeAsync(1);
    expect(ended).toBe(true);
    expect(await result).toEqual(failure('interrupted'));
  } finally {
    vi.useRealTimers();
  }
});

const sentOf = (h: Harness, type: EnvironmentRequest['type']) => h.sent().filter(request => request.type === type);
/**
 * 审查 202: this request is refused busy, but the answer is late; meanwhile the state shows another caller's install of
 * the same tool (a new id, same tool, same update), which used to be taken for this one's.
 */
function overtaken(update: boolean) {
  let reply: Later | undefined;
  let reads = 0;
  const h = envHarness(request => {
    if (request.type === 'install' || request.type === 'update') { reply = h.later<unknown>(); return reply.promise; }
    if (request.type === 'toolInstallStatus') return { kind: 'toolInstall', operation: reads++ === 0 ? null : running(OP2, { update, requestId: THEIRS }) };
    if (request.type === 'cancelInstall') return { kind: 'toolInstall', operation: { kind: 'cancelled', id: OP2, message: '已取消。' } };
    throw new Error(`unexpected ${request.type}`);
  });
  return Object.assign(h, { reply: () => reply, reads: () => reads });
}

// 审查 202: Ctrl-C sent cancelInstall with the other caller's operationId and stopped their install
it.each([false, true])('env install/update (update: %s): busy answered late, another caller\'s install in the state: never shown, never cancelled', async update => {
  const cut = overtaken(update);
  const interrupted = caught(runEnvInstall('codex', update, cut.io(true), cut.daemon, cut.deps));
  // their state was read, and read again after it
  await vi.waitFor(() => { expect(cut.reads()).toBeGreaterThanOrEqual(3); });
  cut.interrupt();
  expect(await interrupted).toEqual(failure('interrupted', expect.stringContaining('没有取消')));
  expect(sentOf(cut, 'cancelInstall')).toEqual([]);
  expect(cut.out()).toBe('');
  expect(cut.sent()[0]).toEqual({ type: update ? 'update' : 'install', tool: 'codex', requestId: REQ });
  // the busy answer comes after their state was read: 4, and nothing shown
  const busy = overtaken(update);
  const refused = caught(runEnvInstall('codex', update, busy.io(true), busy.daemon, busy.deps));
  await vi.waitFor(() => { expect(busy.reads()).toBeGreaterThanOrEqual(3); });
  busy.reply()?.settle(BUSY);
  expect(await refused).toEqual(failure('refused', BUSY.message, { reason: 'busy' }));
  expect(sentOf(busy, 'cancelInstall')).toEqual([]);
  expect(busy.out()).toBe('');
});

// 审查 202: what is this command's is proven by the request id it sent, in the progress and in the Ctrl-C before it
it.each([false, true])('env install/update (update: %s): its own install, by the request id, is shown and cancelled by its own id', async update => {
  const polled = installer([running(OP2, { update, requestId: THEIRS }), mine(OP1, { update })], {}, { onRead: index => { if (index === 2) setTimeout(() => polled.interrupt(), 0); } });
  expect(await caught(runEnvInstall('codex', update, polled.io(true), polled.daemon, polled.deps))).toEqual(failure('interrupted', `已取消${update ? '更新' : '安装'}。`));
  expect(polled.lines()).toEqual([{ event: 'progress', state: 'running', operationId: OP1 }]);
  expect(sentOf(polled, 'cancelInstall')).toEqual([{ type: 'cancelInstall', operationId: OP1 }]);
  // Ctrl-C before a read showed it: the read for the cancel finds it by the same rule
  const early = installer([null, mine(OP1, { update })], {}, { onRead: index => { if (index === 0) setTimeout(() => early.interrupt(), 0); } });
  expect(await caught(runEnvInstall('codex', update, early.io(true), early.daemon, early.deps))).toEqual(failure('interrupted', `已取消${update ? '更新' : '安装'}。`));
  expect(sentOf(early, 'cancelInstall')).toEqual([{ type: 'cancelInstall', operationId: OP1 }]);
  expect(early.out()).toBe('');
});

// 审查 202: a daemon without the request id has nothing to prove an install this command's; the CLI does not guess
it('env install on a daemon without request ids: no progress, its answer still ends it, Ctrl-C cancels nothing', async () => {
  const done = { kind: 'succeeded', id: OP1, message: 'codex 0.129.0 已安装。' };
  // from before the id: the field is refused as invalid, and the install asked again without it
  const strict = installer([null, running(OP1), done], { kind: 'applied', message: done.message }, { strict: true });
  await runEnvInstall('codex', false, strict.io(true), strict.daemon, strict.deps);
  expect(sentOf(strict, 'install')).toEqual([{ type: 'install', tool: 'codex', requestId: REQ }, { type: 'install', tool: 'codex' }]);
  expect(strict.lines()).toEqual([{ ok: true, event: 'result', tool: 'codex', version: '0.129.0', message: done.message }]);
  // takes the field, does not echo it: the same; Ctrl-C exits 130, says the install may run on, and sends no cancel
  for (const o of [{ strict: true }, {}]) {
    const cut: Harness = installer([null, running(OP1)], {}, { ...o, onRead: index => { if (index === 2) setTimeout(() => cut.interrupt(), 0); } });
    expect(await caught(runEnvInstall('codex', false, cut.io(true), cut.daemon, cut.deps))).toEqual(failure('interrupted', expect.stringContaining('如果已经开始，它会继续进行')));
    expect(sentOf(cut, 'cancelInstall')).toEqual([]);
    expect(cut.out()).toBe('');
  }
});

// 审查 202 P3 b: its own install had started, and a refusal outside INSTALL_ENDED (environment-closed) was 4
it('env install: once its own install was seen running, any refusal is how it ended (1); before that, one it can be refused with stays 4', async () => {
  const closing = { kind: 'refused', code: 'environment-closed', message: '本机环境正在退出。' };
  const started = installer([null, mine(OP1), { kind: 'failed', id: OP1, message: closing.message, requestId: REQ }], closing);
  expect(await caught(runEnvInstall('codex', false, started.io(true), started.daemon, started.deps))).toEqual(failure('failed', closing.message, { reason: 'install_failed' }));
  const before = installer([null], closing, { now: true });
  expect(await caught(runEnvInstall('codex', false, before.io(true), before.daemon, before.deps))).toEqual(failure('refused', closing.message, { reason: 'environment-closed' }));
});

// 审查 202 P3 a: after the 5 s cap the close handshake was still waited for, up to another second
it('a cancel never answered, then a close never finished: 130 shortly after the 5 s', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const job = JOBS[0]!;
    const h = racing(job, { wait: ms => new Promise(done => { setTimeout(done, ms); }), client: { close: () => new Promise(() => undefined) } });
    let ended = false;
    const result = caught(job.run(h)).finally(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.out()).toContain('"progress"');
    h.interrupt();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(ended).toBe(true);
    expect(await result).toEqual(failure('interrupted', '已取消安装。'));
  } finally {
    vi.useRealTimers();
  }
});

const backendState = (operationId: string, extra: object = {}) => ({ kind: 'backendInstallStatus', operation: { operationId, id: 'cbridge', update: false, state: 'running', replay: [], omittedBytes: 0, ...extra } });
// 审查 202: an install this request attached to, or one found before the reply by "same update", was cancelled
it('env backend install: Ctrl-C leaves an install it attached to, or one another request started, running', async () => {
  const attached = envHarness(request => {
    if (request.type === 'backendInstall') return { kind: 'backendInstall', operationId: OP2, id: 'cbridge', update: false, attached: true, replay: [{ type: 'log', chunk: 'theirs\n' }] };
    throw new Error(`unexpected ${request.type}`);
  });
  const followed = caught(runEnvBackendInstall('cbridge', false, attached.io(true), attached.daemon, attached.deps));
  await vi.waitFor(() => { expect(attached.out()).toContain('theirs'); });
  attached.interrupt();
  expect(await followed).toEqual(failure('interrupted', expect.stringContaining('没有取消')));
  expect(attached.sent()).toEqual([{ type: 'backendInstall', id: 'cbridge', update: false, requestId: REQ }]);
  // Ctrl-C before the reply: the running install carries another request's id, or none (a daemon from before it)
  for (const extra of [{ requestId: THEIRS }, {}]) {
    let reply: Later | undefined;
    const early = envHarness(request => {
      if (request.type === 'backendInstall') { reply = early.later<unknown>(); return reply.promise; }
      if (request.type === 'backendInstallStatus') return backendState(OP2, extra);
      throw new Error(`unexpected ${request.type}`);
    });
    const pending = caught(runEnvBackendInstall('cbridge', false, early.io(true), early.daemon, early.deps));
    await vi.waitFor(() => { expect(reply).toBeDefined(); });
    early.interrupt();
    expect(await pending).toEqual(failure('interrupted', expect.stringContaining('没有取消')));
    expect(early.sent().map(request => request.type)).toEqual(['backendInstall', 'backendInstallStatus']);
  }
});

// 审查 202: a daemon from before request ids refuses the field; the reply alone still names the install this one started
it('env backend install on a daemon from before request ids asks again without one, and cancels the install its reply names', async () => {
  const h = envHarness(request => {
    if (request.type === 'backendInstall' && 'requestId' in request) throw new RpcError('invalid_request', '请求参数无效。');
    if (request.type === 'backendInstall') return { kind: 'backendInstall', operationId: OP1, id: 'cbridge', update: false, attached: false, replay: [] };
    if (request.type === 'cancelBackendInstall') return { kind: 'applied', message: '已请求取消安装。' };
    throw new Error(`unexpected ${request.type}`);
  });
  const result = caught(runEnvBackendInstall('cbridge', false, h.io(true), h.daemon, h.deps));
  await started(h);
  h.interrupt();
  expect(await result).toEqual(failure('interrupted', '已取消组件安装。'));
  expect(h.sent()).toEqual([
    { type: 'backendInstall', id: 'cbridge', update: false, requestId: REQ }, { type: 'backendInstall', id: 'cbridge', update: false },
    { type: 'cancelBackendInstall', operationId: OP1 },
  ]);
});

// main 必败: there was no provider models
it('provider models asks the Provider by its backend id, and an unavailable list is refused', async () => {
  const models = [{ id: 'model-a', displayName: 'Model A', description: '', supportedEfforts: [], defaultEffort: 'medium', isDefault: true, hidden: false }];
  const collaboration = vi.fn(async () => ({ kind: 'providerModels', backend: 'claude-agent', state: 'ready', models }));
  const h = envHarness(() => undefined, { collaboration });
  await runProviderModels('claude', h.io(true), h.daemon);
  expect(collaboration).toHaveBeenCalledWith({ action: 'providerModels', backend: 'claude-agent' });
  expect(JSON.parse(h.out())).toEqual({ ok: true, backend: 'claude-agent', state: 'ready', models });
  const none = envHarness(() => undefined, { collaboration: async () => ({ kind: 'providerModels', backend: 'codex-appserver', state: 'unavailable', models: [], message: 'Provider 尚未安装或无法运行。' }) });
  expect(await caught(runProviderModels('codex', none.io(), none.daemon))).toEqual(failure('refused', expect.stringContaining('Provider 尚未安装或无法运行。'), { reason: 'models_unavailable' }));
  await expect(runProviderModels('cursor', none.io(), none.daemon)).rejects.toEqual(failure('bad-args'));
});

// 3ba7d5c9 必败: no --refresh, so a terminal could only read the list the daemon last read (#641, #629 cache it)
it('provider models --refresh asks the Provider again, as the Provider list refresh button does', async () => {
  const collaboration = vi.fn(async () => ({ kind: 'providerModels', backend: 'codex-appserver', state: 'ready', models: [] }));
  const h = envHarness(() => undefined, { collaboration });
  await runProviderModels('codex', h.io(true), h.daemon, true);
  expect(collaboration).toHaveBeenLastCalledWith({ action: 'providerModels', backend: 'codex-appserver', refresh: true });
  await runProviderModels('codex', h.io(true), h.daemon);
  expect(collaboration).toHaveBeenLastCalledWith({ action: 'providerModels', backend: 'codex-appserver' });
});

// main 必败: the step said 在网页里点「去本机环境」
it('bot status gives env scan for the 本机环境 step', () => {
  expect(stepLines({ id: 'claude', title: 'Claude', status: '未安装', tone: 'neutral', done: false, actions: [{ kind: 'environment', label: '去本机环境' }] }, 'cli_a'))
    .toEqual(['· Claude：未安装', '    运行 vonvon env scan']);
});

// main 必败: the 24 kinds were pending C7 in the allowlist
it('covers the 24 kinds of the 本机环境 page and the Provider models, none left in the allowlist', async () => {
  const commands = await loadCommands();
  const coverers = (kind: string) => commands.filter(command => command.covers.includes(kind)).map(command => command.path);
  const kinds = ['collaboration.providerModels', ...['scan', 'install', 'update', 'uninstall', 'toolInstallStatus', 'cancelInstall', 'backendCatalog', 'backendVersion', 'backendInstall',
    'backendInstallStatus', 'cancelBackendInstall', 'backendUninstall', 'backendLogin', 'authStatus', 'startLogin', 'loginStatus', 'cancelLogin', 'profileList', 'profileUse',
    'profileAdd', 'profileInit', 'profileInitStatus', 'profileInitCancel'].map(type => `environment.${type}`)];
  expect(kinds).toHaveLength(24);
  for (const kind of kinds) {
    expect(CLI_PARITY_ALLOWLIST[kind], kind).toBeUndefined();
    expect(coverers(kind).length, kind).toBeGreaterThan(0);
  }
  expect(coverers('environment.cancelInstall')).toEqual(['env install', 'env update', 'env cancel']);
  expect(coverers('collaboration.providerModels')).toEqual(['provider models']);
  // D1 deleted the dead kind outright
  expect(rpcKinds().map(entry => entry.kind)).not.toContain('environment.openVerification');
  expect(CLI_PARITY_ALLOWLIST['environment.openVerification']).toBeUndefined();
  const env = commands.filter(command => command.path.startsWith('env ') || command.path.startsWith('provider '));
  expect(env).toHaveLength(16);
  for (const command of env) expect(command.options, command.path).toContain('--json');
});
