import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, replyEnvelopeSchema, serverInfoSchema, type Hello, type ReplyEnvelope, type ScheduleReply, type ScheduleRequest } from '@vonvon/protocol';
import type { AdminService, AdminServiceDeps } from '../src/admin/service';
import type { ShutdownControl } from '../src/host/lifecycle';

const f = vi.hoisted(() => ({
  deps: undefined as AdminServiceDeps | undefined,
  /** The supervisor and the single-bot run get an API that listens nowhere; the RPC tests get the real one. */
  fakeApi: false,
  bridgeSchedule: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('../src/core/logger', async original => ({ ...await original<typeof import('../src/core/logger')>(), log: { info() {}, warn() {}, fail() {} } }));
vi.mock('../src/agent', () => ({ createBackend: () => ({ doctor: async () => ({ ok: false, version: null, depState: 'not-installed' }) }), installBackendDep() {}, uninstallBackendDep() {} }));
vi.mock('../src/admin/service', async original => {
  const real = await original<typeof import('../src/admin/service')>();
  return { ...real, createAdminService: (deps: AdminServiceDeps) => { f.deps = deps; return real.createAdminService(deps); } };
});
vi.mock('../src/server/http', async original => {
  const real = await original<typeof import('../src/server/http')>();
  const nowhere = { port: 1, listen: '127.0.0.1:1', invalidate() {}, beginDrain: async () => {}, release: async () => {}, close: async () => {} };
  return { ...real, startApi: (options: Parameters<typeof real.startApi>[0]) => (f.fakeApi ? Promise.resolve(nowhere) : real.startApi(options)) };
});
vi.mock('../src/import/bridge/runtime', () => ({ bridgeImportRuntime: () => ({ importer: {}, guard: async () => undefined, bind() {}, releaseRemoved() {}, shutdown: async () => {}, dispose() {} }) }));
vi.mock('../src/agent/owned-process', () => ({ closeOwnedProviderProcesses: async () => {}, unconfirmedProviderPids: () => [] }));
vi.mock('../src/cli/commands/daemon-control', () => ({ spawnDaemonControl() {} }));
vi.mock('../src/config/bots', async original => ({ ...await original<typeof import('../src/config/bots')>(), loadBots: async () => ({ version: 1, bots: [{ appId: 'cli_a', name: 'cli_a', tenant: 'feishu', createdAt: 0 }] }) }));
vi.mock('../src/core/single-instance', async original => ({ ...await original<typeof import('../src/core/single-instance')>(), acquireSingleInstanceLock: () => () => {}, readSingleInstanceHolder: () => undefined }));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: vi.fn() }));
vi.mock('../src/bot/onboarding', () => ({
  ensureOnboarded: async () => ({ cfg: { accounts: { app: { id: 'cli_a', secret: 'test', tenant: 'feishu' } } }, secret: 'test', identity: { appId: 'cli_a', tenant: 'feishu', createdAt: 0 } }),
  announceEventsWhenLive() {},
}));
vi.mock('../src/bot/bridge', () => ({
  startBridge: async () => ({ channel: { getConnectionStatus: () => ({ state: 'connected' }) }, schedule: f.bridgeSchedule, shutdown: async () => {} }),
}));

function bot(appId: string) { return { appId, name: appId, tenant: 'feishu' as const, createdAt: 0 }; }
const list: ScheduleRequest = { action: 'list', chatId: 'oc_pay' };
const tasks: ScheduleReply = { kind: 'tasks', tasks: [], now: 1_700_000_000_000, timeZone: 'Asia/Tokyo' };
const refused: ScheduleReply = { kind: 'refused', reason: 'bot-not-running', message: 'Bot 没在运行，任务暂时看不到；启动后再来。' };

let root: string;
type Modules = {
  startApi: typeof import('../src/server/http').startApi;
  runSupervisor: typeof import('../src/bot/supervisor').runSupervisor;
  runRun: typeof import('../src/cli/commands/run').runRun;
  spawnProcess: typeof import('../src/platform/spawn').spawnProcess;
  appDir: string;
};
let m: Modules;
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-schedule-rpc-')));
  for (const dir of ['home', 'vonvon']) mkdirSync(join(root, dir));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('VONVON_HOME', join(root, 'vonvon'));
  // Imported only now, so every data path is under the temporary home.
  m = {
    startApi: (await import('../src/server/http')).startApi,
    runSupervisor: (await import('../src/bot/supervisor')).runSupervisor,
    runRun: (await import('../src/cli/commands/run')).runRun,
    spawnProcess: (await import('../src/platform/spawn')).spawnProcess,
    appDir: (await import('../src/config/paths')).paths.appDir,
  };
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => { f.fakeApi = false; f.deps = undefined; });

function control(): ShutdownControl & { stop(): void } {
  let stop = (): void => {};
  const pending = new Promise<void>(resolve => { stop = resolve; });
  return { requested: false, waitForRequest: () => pending, requestStop() {}, requestRestart() {}, completeShutdown: release => release(), dispose() {}, stop: () => stop() };
}

/** One authenticated socket that says it is `clientKind` in its hello. */
async function connect(port: number, clientKind: Hello['clientKind']) {
  const credential = readFileSync(join(m.appDir, 'local-credential'), 'utf8').trim();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: unknown[] = [];
  socket.on('message', bytes => { frames.push(JSON.parse(bytes.toString())); });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientKind, credential }));
  await vi.waitFor(() => expect(frames.some(frame => serverInfoSchema.safeParse(frame).success)).toBe(true));
  return {
    async call(id: string, botId: string, request: ScheduleRequest): Promise<ReplyEnvelope> {
      socket.send(JSON.stringify({ type: 'request', id, method: 'schedule', payload: { botId, request } }));
      let found: ReplyEnvelope | undefined;
      await vi.waitFor(() => {
        found = frames.map(frame => replyEnvelopeSchema.safeParse(frame)).flatMap(parsed => parsed.success ? [parsed.data] : []).find(frame => frame.id === id);
        expect(found).toBeDefined();
      });
      return found!;
    },
    close: () => new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.close(); }),
  };
}

describe('schedule over RPC', () => {
  it.each([['cli', 'cli'], ['web', 'desktop'], ['desktop', 'desktop']] as const)('a %s client reaches the service as via %s, and the reply comes back as is', async (clientKind, via) => {
    const executeSchedule = vi.fn(async (): Promise<ScheduleReply> => tasks);
    const service = { listBots: async () => [], listProjects: async () => [], codexSetup: async () => ({ installation: 'missing', authentication: 'unknown', version: null, executable: null }), executeSchedule } as unknown as AdminService;
    const api = await m.startApi({ service, port: 0, control: control(), serviceActions: { platform: 'linux', readService: async () => ({ supported: false, installed: false, running: false }) } });
    try {
      const client = await connect(api.port, clientKind);
      expect(await client.call('list-1', 'cli_a', list)).toEqual({ type: 'response', id: 'list-1', method: 'schedule', payload: tasks });
      expect(executeSchedule).toHaveBeenLastCalledWith('cli_a', via, list);
      // A refusal is a reply; a write is answered as it comes, without a snapshot rebuild (the snapshot has no tasks).
      executeSchedule.mockResolvedValueOnce(refused);
      const run: ScheduleRequest = { action: 'runNow', chatId: 'oc_pay', taskId: 'st_0123456789abcdef' };
      expect(await client.call('run-1', 'cli_a', run)).toEqual({ type: 'response', id: 'run-1', method: 'schedule', payload: refused });
      expect(executeSchedule).toHaveBeenLastCalledWith('cli_a', via, run);
      await client.close();
    } finally { await api.close(); }
  });
});

describe('schedule replies over RPC', () => {
  it('answers a write without a snapshot rebuild, and a malformed reply with one short line', async () => {
    let broken = false;
    const deleted: ScheduleReply = { kind: 'deleted', taskId: 'st_0123456789abcdef' };
    const executeSchedule = vi.fn(async (): Promise<ScheduleReply> => deleted);
    const listBots = async () => { if (broken) throw new Error('bots.json unreadable'); return []; };
    const service = { listBots, listProjects: async () => [], codexSetup: async () => ({ installation: 'missing', authentication: 'unknown', version: null, executable: null }), executeSchedule } as unknown as AdminService;
    const api = await m.startApi({ service, port: 0, control: control(), serviceActions: { platform: 'linux', readService: async () => ({ supported: false, installed: false, running: false }) } });
    try {
      const client = await connect(api.port, 'cli');
      // The snapshot carries no tasks: a rebuild that fails now must not turn a write that landed into an error.
      broken = true;
      const remove: ScheduleRequest = { action: 'delete', chatId: 'oc_pay', taskId: 'st_0123456789abcdef', revision: 'r1' };
      expect(await client.call('delete-1', 'cli_a', remove)).toEqual({ type: 'response', id: 'delete-1', method: 'schedule', payload: deleted });
      // Any error rebuilds the snapshot first (http.ts), so this one runs with bots.json readable again.
      broken = false;
      executeSchedule.mockResolvedValueOnce({ kind: 'tasks', tasks: [{ id: 'x' }], now: 1, timeZone: 'UTC' } as unknown as ScheduleReply);
      expect(await client.call('list-1', 'cli_a', list)).toEqual({
        type: 'error', id: 'list-1', code: 'operation_failed', message: 'Bot 回的任务数据格式不对（daemon 和 Bot 进程版本可能不一致）。',
      });
      await client.close();
    } finally { await api.close(); }
  });
});

const echoChild = `
  const keepAlive = setInterval(() => {}, 1000);
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; setTimeout(() => { clearInterval(keepAlive); process.disconnect(); }, 50); };
  process.on('SIGTERM', stop);
  process.on('message', message => {
    if (message.type === 'bridge:shutdown') stop();
    else if (message.fcb === 'fcb.admin.req') process.send({ fcb: 'fcb.admin.res', id: message.id, ok: true, result: message.op.kind === 'status' ? { connection: 'connected' } : { echoed: message.op } });
  });
`;

/** Answers like echoChild, but drains for 1.5 s after bridge:shutdown and says in each answer whether it was stopping. */
const drainingChild = `
  const keepAlive = setInterval(() => {}, 1000);
  let stopping = false;
  process.on('SIGTERM', () => {});
  process.on('message', message => {
    if (message.type === 'bridge:shutdown') { stopping = true; setTimeout(() => { clearInterval(keepAlive); process.disconnect(); }, 1500); }
    else if (message.fcb === 'fcb.admin.req') process.send({ fcb: 'fcb.admin.res', id: message.id, ok: true, result: message.op.kind === 'status' ? { connection: 'connected' } : { echoed: message.op, stopping } });
  });
`;

describe('the supervisor', () => {
  const processes: ChildProcess[] = [];
  afterEach(() => { for (const child of processes.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });

  it('answers refused bot-not-running for a bot without a process, and forwards the op to a running one', async () => {
    f.fakeApi = true;
    vi.mocked(m.spawnProcess).mockImplementation((_bin, _args, options) => {
      const child = spawn(process.execPath, ['-e', echoChild], options ?? {});
      processes.push(child);
      return child;
    });
    const host = control();
    const supervisor = m.runSupervisor([bot('cli_a')], { control: host });
    try {
      await vi.waitFor(() => expect(f.deps?.executeSchedule).toBeDefined());
      const deps = f.deps!;
      expect(await deps.executeSchedule!('cli_b', 'cli', list)).toEqual(refused);
      await vi.waitFor(async () => expect(await deps.liveStatus!('cli_a')).toMatchObject({ running: true }), { timeout: 10_000 });
      // The op the bot process gets: `run.ts` hands it to the bridge's schedule.
      expect(await deps.executeSchedule!('cli_a', 'desktop', list)).toEqual({ echoed: { kind: 'schedule', via: 'desktop', request: list } });
      await deps.applyBotActivation!('cli_a', false);
      expect(await deps.executeSchedule!('cli_a', 'desktop', list)).toEqual(refused);
    } finally {
      host.stop();
      await supervisor;
    }
  });
});

describe('the supervisor while a bot stops', () => {
  const processes: ChildProcess[] = [];
  afterEach(() => { for (const child of processes.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });

  it('answers refused bot-not-running without asking the draining process', async () => {
    f.fakeApi = true;
    vi.mocked(m.spawnProcess).mockImplementation((_bin, _args, options) => {
      const child = spawn(process.execPath, ['-e', drainingChild], options ?? {});
      processes.push(child);
      return child;
    });
    const host = control();
    const supervisor = m.runSupervisor([bot('cli_a')], { control: host });
    try {
      await vi.waitFor(() => expect(f.deps?.executeSchedule).toBeDefined());
      const deps = f.deps!;
      await vi.waitFor(async () => expect(await deps.liveStatus!('cli_a')).toMatchObject({ running: true }), { timeout: 10_000 });
      expect(await deps.executeSchedule!('cli_a', 'cli', list)).toEqual({ echoed: { kind: 'schedule', via: 'cli', request: list }, stopping: false });
      // The host stops: the bot stays enabled while its process drains.
      host.stop();
      const answers: unknown[] = [];
      await vi.waitFor(async () => {
        answers.push(await deps.executeSchedule!('cli_a', 'cli', list));
        expect(answers.at(-1)).toEqual(refused);
      }, { timeout: 10_000, interval: 20 });
      expect(answers.filter(answer => (answer as { stopping?: boolean }).stopping)).toEqual([]);
    } finally {
      host.stop();
      await supervisor;
    }
  });
});

describe('the bot process', () => {
  it('without a supervisor answers refused bot-not-running for a bot it does not run', async () => {
    f.fakeApi = true;
    f.bridgeSchedule = vi.fn(async (): Promise<ScheduleReply> => tasks);
    // No parent: `vonvon run` serves its own API. The vitest fork keeps its own bound send.
    const original = process.send;
    process.send = undefined;
    const host = control();
    const running = m.runRun('cli_a', { control: host });
    try {
      await vi.waitFor(() => expect(f.deps?.executeSchedule).toBeDefined(), { timeout: 10_000 });
      expect(await f.deps!.executeSchedule!('cli_b', 'cli', list)).toEqual(refused);
      expect(await f.deps!.executeSchedule!('cli_a', 'cli', list)).toEqual(tasks);
      expect(f.bridgeSchedule).toHaveBeenCalledExactlyOnceWith('cli', list);
    } finally {
      host.stop();
      await running;
      process.send = original;
    }
  });

  it('hands a schedule op from the supervisor to the bridge and answers with its reply', async () => {
    f.fakeApi = true;
    f.bridgeSchedule = vi.fn(async (): Promise<ScheduleReply> => tasks);
    const sent: unknown[] = [];
    const original = process.send;
    // A supervised child: the responder is installed only when there is a parent to answer.
    process.send = ((message: unknown, ...rest: unknown[]) => {
      if (message && typeof message === 'object' && 'fcb' in message) {
        sent.push(message);
        const callback = rest.find((arg): arg is (error: Error | null) => void => typeof arg === 'function');
        if (callback) queueMicrotask(() => callback(null));
        return true;
      }
      return original ? (original as (...args: unknown[]) => boolean).call(process, message, ...rest) : false;
    }) as typeof process.send;
    const before = new Set(process.listeners('message'));
    const host = control();
    const running = m.runRun('cli_a', { control: host });
    try {
      let respond: ((message: unknown) => void) | undefined;
      await vi.waitFor(() => {
        respond = process.listeners('message').find(listener => !before.has(listener)) as typeof respond;
        expect(respond).toBeDefined();
      });
      respond!({ fcb: 'fcb.admin.req', id: 7, op: { kind: 'schedule', via: 'cli', request: list } });
      await vi.waitFor(() => expect(sent).toContainEqual({ fcb: 'fcb.admin.res', id: 7, ok: true, result: tasks }));
      expect(f.bridgeSchedule).toHaveBeenCalledExactlyOnceWith('cli', list);
    } finally {
      host.stop();
      await running;
      for (const listener of process.listeners('message')) if (!before.has(listener)) process.removeListener('message', listener as never);
      process.send = original;
    }
  });
});
