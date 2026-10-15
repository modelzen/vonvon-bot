import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as settleIO } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput, AgentThread } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(), exit: vi.fn(), ready: false,
  job: { identity: Symbol('owned-job'), proof: undefined as symbol | undefined, stop: vi.fn(), dispose: vi.fn() },
  on: vi.fn((..._args: unknown[]) => {}),
  connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
  send: vi.fn(async (..._args: unknown[]) => ({})),
  createCard: vi.fn(async () => 'card'), finalCard: vi.fn(async () => true),
  backend: { id: 'codex', capabilities: { steer: true }, listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  apiCalls: [] as string[],
}));
vi.mock('node:child_process', async original => ({
  ...await original<object>(),
  spawn: () => { throw new Error('Native spawn forbidden in provider retention fixture'); },
  spawnSync: () => { throw new Error('Native spawnSync forbidden in provider retention fixture'); },
  exec: () => { throw new Error('Native exec forbidden in provider retention fixture'); },
  execSync: () => { throw new Error('Native execSync forbidden in provider retention fixture'); },
  execFile: () => { throw new Error('Native execFile forbidden in provider retention fixture'); },
  execFileSync: () => { throw new Error('Native execFileSync forbidden in provider retention fixture'); },
  fork: () => { throw new Error('Native fork forbidden in provider retention fixture'); },
}));
vi.mock('../src/platform/spawn', async original => ({
  ...await original<object>(), spawnProcess: fixture.spawn,
  spawnProcessSync: () => { throw new Error('Synchronous spawn forbidden in provider retention fixture'); },
}));
vi.mock('../src/agent/codex-appserver/windows-job', () => ({ WindowsCodexJob: class {
  executable = '/fixture/no-powershell';
  launch() { return []; }
  requestStop() { fixture.job.stop(); }
  get verifiedEmpty() { return fixture.job.proof === fixture.job.identity; }
  dispose() { fixture.job.dispose(); }
} }));
vi.mock('../src/core/logger', () => ({ log: fixture.log, withTrace: (_context: unknown, action: () => unknown) => action(), flushLogs: async () => {} }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => fixture.backend }));
vi.mock('../src/agent/codex-appserver/locate', () => ({ resolveCodexBin: () => '/fixture/no-provider' }));
vi.mock('../src/service/startup', () => ({ readStartupRegistration: async () => ({ kind: 'absent' }) }));
vi.mock('../src/project/registry', async original => ({
  ...await original<object>(), getProjectByChatId: async () => ({ name: 'fixture', chatId: 'chat', cwd: process.env.HOME, groupMode: 'single' }),
}));
vi.mock('../src/bot/session-store', async original => ({
  ...await original<object>(),
  getSession: async () => ({ threadId: 'topic', chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: process.env.HOME, summary: '' }),
  patchSession: async () => undefined, upsertSession: async () => undefined,
}));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = fixture.createCard;
    getCardId() { return 'card_entity'; }
    async updateElement() { return true; }
    streamCoalesced() {}
    async drain() {}
    setImageWorker() {}
    async settleImages() { return new Map(); }
    updateCard = fixture.finalCard;
    finalizeCard = fixture.finalCard;
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
vi.mock('../src/card/managed', async original => ({ ...await original<object>(), sendManagedCard: (...args: unknown[]) => fixture.send(...args) }));
vi.mock('@larksuiteoapi/node-sdk', async original => ({
  ...await original<object>(), createLarkChannel: () => ({
    on: fixture.on, connect: fixture.connect, disconnect: fixture.disconnect, send: fixture.send,
    rawClient: { im: { v1: {
      message: { get: async () => ({ data: { items: [{ thread_id: 'topic' }] } }) },
      messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) },
    } } },
  }),
}));
vi.mock('../src/bot/onboarding', () => ({
  ensureOnboarded: async () => {
    const { useBotDir } = await import('../src/config/paths');
    useBotDir('provider-lock-fixture');
    const cfg: AppConfig = {
      accounts: { app: { id: 'provider-lock-fixture', secret: 'fixture', tenant: 'feishu' } },
      preferences: { access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } },
    };
    return { cfg, secret: 'fixture' };
  },
  announceEventsWhenLive: async () => {},
}));
vi.mock('../src/admin/service', () => ({ createAdminService: () => ({}) }));
vi.mock('../src/server/http', async original => ({
  ...await original<object>(), startApi: async () => ({
    listen: '127.0.0.1:43119', port: 43119, invalidate() {},
    async beginDrain() { fixture.apiCalls.push('drain'); },
    async release() { fixture.apiCalls.push('release'); },
  }),
}));

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

let root: string;
let child: ChildProcess;
let group: 'present' | 'missing';
let directExited: boolean;
let signals: Array<{ pid: number; signal: Parameters<typeof process.kill>[1] }>;
let appProcess: EventEmitter;
let turn: ReturnType<typeof gate>;
let paths: typeof import('../src/config/paths').paths;
let dataAccess: typeof import('../src/config/data-access');
const shellPid = 987654321;
const nativeProcess = process;
const auditDir = fileURLToPath(new URL('../../../.audit/provider-lock-red', import.meta.url));

async function until(predicate: () => boolean, description: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(0);
    await settleIO(5);
  }
  throw new Error(`Fixture did not reach ${description}`);
}

function observeExit(code = 0) {
  if (directExited) return;
  directExited = true;
  child.emit('exit', code, null);
  child.emit('close', code, null);
}

async function mutexState() {
  try {
    const acquired = await dataAccess.acquireMutex(paths.appDir, 'host', 0);
    await dataAccess.closeMutex(acquired);
    return 'released';
  } catch (error) {
    if (error instanceof Error && error.message.includes('busy')) return 'held';
    throw error;
  }
}

async function snapshot(label: string) {
  const state = {
    label, botLock: existsSync(paths.processesFile), daemonPid: existsSync(join(paths.appDir, 'daemon.pid')),
    hostMutex: await mutexState(), cliExits: fixture.exit.mock.calls.map(([code]) => code),
    apiCalls: [...fixture.apiCalls], group, directExited, jobProof: fixture.job.proof === fixture.job.identity,
    unconfirmedReports: fixture.log.warn.mock.calls.filter(([scope, event]) => scope === 'daemon-shutdown' && event === 'owned_work_unconfirmed').length,
  };
  appendFileSync(join(auditDir, 'observations.jsonl'), JSON.stringify({ root, ...state }) + '\n');
  return state;
}

describe.each([
  { platform: 'darwin', model: 'POSIX forced process-group cleanup', exitCode: 0 },
  { platform: 'win32', model: 'Windows unexpected supervisor exit', exitCode: 17 },
] as const)('$model', ({ platform, exitCode }) => {
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  fixture.ready = false;
  fixture.job.identity = Symbol('owned-job');
  fixture.job.proof = undefined;
  fixture.apiCalls.length = 0;
  group = 'present'; directExited = false; signals = []; turn = gate();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-provider-lock-')));
  mkdirSync(auditDir, { recursive: true });
  appendFileSync(join(auditDir, 'allocations.txt'), root + '\n');
  for (const dir of ['home', 'vonvon', 'codex']) mkdirSync(join(root, dir));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('VONVON_HOME', join(root, 'vonvon'));
  vi.stubEnv('CODEX_HOME', join(root, 'codex'));
  vi.stubEnv('CODEX_BIN', join(root, 'unavailable-codex'));
  vi.stubEnv('FEISHU_CODEX_PREWARM', '0');
  vi.stubEnv('VONVON_SERVICE', '');
  appProcess = new EventEmitter();
  const runtimeProcess = Object.create(nativeProcess);
  Object.defineProperties(runtimeProcess, {
    platform: { value: platform },
    send: { value: undefined },
    argv: { value: [nativeProcess.execPath, '/fixture/vonvon', 'daemon', 'run', '--bot', 'provider-lock-fixture', '--port', '0'] },
    exit: { value: fixture.exit },
    exitCode: { value: undefined, writable: true },
  });
  for (const method of ['on', 'once', 'off', 'removeListener', 'emit'] as const) {
    Object.defineProperty(runtimeProcess, method, { value: appProcess[method].bind(appProcess) });
  }
  vi.spyOn(nativeProcess, 'kill').mockImplementation((pid, signal) => {
    signals.push({ pid, signal });
    if (pid === nativeProcess.pid && signal === 0) return true;
    if (pid !== -shellPid) throw new Error(`Unowned signal target ${pid}`);
    if (group === 'missing') throw Object.assign(new Error('group absent'), { code: 'ESRCH' });
    return true;
  });
  vi.stubGlobal('process', runtimeProcess);
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    if (values.includes('vonvon daemon ready')) fixture.ready = true;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  child = new ChildProcess();
  Object.defineProperties(child, {
    pid: { value: shellPid },
    stdin: { value: new PassThrough() }, stdout: { value: new PassThrough() }, stderr: { value: new PassThrough() },
  });
  child.kill = vi.fn(() => { throw new Error('Direct child signal is not the process-tree ownership boundary'); });
  fixture.spawn.mockReset().mockReturnValueOnce(child).mockImplementation(() => { throw new Error('Unexpected provider birth'); });
  ({ paths } = await import('../src/config/paths'));
  dataAccess = await import('../src/config/data-access');
  const { OwnedCodexProcess } = await import('../src/agent/codex-appserver/owned-process');
  const owner = new OwnedCodexProcess('/fixture/no-provider', [], {});
  const thread: AgentThread = {
    sessionId: 'host', isAlive: () => !directExited,
    close: () => owner.close(), abort: async () => {}, steer: async () => {},
    runGoal: () => { throw new Error('Goal outside fixture contract'); },
    clearGoal: async () => {}, compact: async () => ({ compacted: false, usage: null }),
    runStreamed(_input: AgentInput) {
      return { turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: 'turn' };
        await turn.promise;
        yield { type: 'done', turnId: 'turn' };
      })() };
    },
  };
  fixture.backend.resumeThread.mockReset().mockResolvedValue(thread);
  fixture.backend.startThread.mockReset().mockResolvedValue(thread);
});

afterEach(async () => {
  group = 'missing'; fixture.job.proof = fixture.job.identity; observeExit(); turn.release();
  appProcess.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(2000);
  if (fixture.ready) await until(() => fixture.exit.mock.calls.length > 0, 'CLI completion during cleanup');
  appProcess.emit('exit', 0);
  appProcess.removeAllListeners();
  appendFileSync(join(auditDir, 'signals.jsonl'), JSON.stringify({ root, signals }) + '\n');
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

it('retains all three real locks until tree death and direct exit are confirmed, then reaches the real CLI exit-1 consumer', async () => {
  expect(process.send).toBeUndefined();
  await import('../src/cli/index');
  await until(() => fixture.ready || fixture.exit.mock.calls.length > 0, 'inline daemon readiness');
  expect(fixture.exit).not.toHaveBeenCalled();
  expect(fixture.ready).toBe(true);
  expect(JSON.parse(readFileSync(paths.processesFile, 'utf8'))).toMatchObject({ pid: process.pid, appId: 'provider-lock-fixture' });
  expect(JSON.parse(readFileSync(join(paths.appDir, 'daemon.pid'), 'utf8'))).toMatchObject({ pid: process.pid, listen: '127.0.0.1:43119' });
  expect(await mutexState()).toBe('held');

  const registration = fixture.on.mock.calls.find(([event]) => event === 'message');
  if (!registration || typeof registration[1] !== 'function') throw new Error('Real bridge did not register its orchestrator message handler');
  const message: NormalizedMessage = {
    messageId: 'provider-lock-message', chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: 'exercise owned provider', senderId: 'owner', senderName: 'Owner', mentionedBot: true,
    createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false,
  };
  await registration[1](message);
  await until(() => fixture.backend.resumeThread.mock.calls.length === 1 && fixture.createCard.mock.calls.length === 1, 'owned thread adoption');
  turn.release();
  await until(() => fixture.finalCard.mock.calls.length > 0, 'completed provider turn');
  await vi.advanceTimersByTimeAsync(0);
  await snapshot('acquired-before-stop');

  appProcess.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(6000);
  await settleIO(30);
  const atSix = await snapshot('uncertain-at-6s');
  expect.soft(atSix).toMatchObject({ botLock: true, daemonPid: true, hostMutex: 'held', cliExits: [], apiCalls: ['drain'] });
  await vi.advanceTimersByTimeAsync(114000);
  await settleIO(30);
  const at120 = await snapshot('uncertain-at-120s');
  expect.soft(at120).toMatchObject({ botLock: true, daemonPid: true, hostMutex: 'held', cliExits: [], apiCalls: ['drain'] });
  expect.soft(fixture.log.warn).toHaveBeenCalledWith('daemon-shutdown', 'owned_work_unconfirmed', { pid: process.pid, pids: [shellPid] });
  if (platform === 'win32') {
    expect(fixture.job.stop.mock.calls.length).toBeGreaterThanOrEqual(115);
    expect(fixture.job.dispose).not.toHaveBeenCalled();
    expect(signals.every(({ pid, signal }) => pid === nativeProcess.pid && signal === 0)).toBe(true);
    fixture.job.proof = Symbol('unrelated-job');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await snapshot('unrelated-job-proof')).toMatchObject({ botLock: true, daemonPid: true, hostMutex: 'held', cliExits: [], jobProof: false });
    fixture.job.proof = fixture.job.identity;
  } else {
    expect.soft(signals.some(({ pid, signal }) => pid === -shellPid && signal === 'SIGKILL')).toBe(true);
  }

  group = 'missing';
  await vi.advanceTimersByTimeAsync(1000);
  await settleIO(30);
  expect.soft(await snapshot('tree-death-proven-direct-exit-unobserved')).toMatchObject({ botLock: true, daemonPid: true, hostMutex: 'held', cliExits: [] });
  observeExit(exitCode);
  await vi.advanceTimersByTimeAsync(1000);
  await until(() => fixture.exit.mock.calls.length > 0, 'actual CLI exit consumer');
  expect.soft(await snapshot('confirmed-death')).toMatchObject({ botLock: false, daemonPid: false, hostMutex: 'released', cliExits: [1], apiCalls: ['drain', 'release'] });
  if (platform === 'win32') expect(fixture.job.dispose).toHaveBeenCalledOnce();
  else expect(fixture.job.stop).not.toHaveBeenCalled();
  expect(fixture.disconnect).toHaveBeenCalledOnce();
  expect(fixture.spawn).toHaveBeenCalledOnce();
  expect(signals.every(({ pid, signal }) => pid === -shellPid || (pid === nativeProcess.pid && signal === 0))).toBe(true);
});

});
