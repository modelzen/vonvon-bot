let UnsentRequestError: typeof import('../src/agent/types').UnsentRequestError;
let AppServerClient: typeof import('../src/agent/codex-appserver/app-server-client').AppServerClient;
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import v8 from 'node:v8';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let CodexAppServerBackend: typeof import('../src/agent/codex-appserver/backend').CodexAppServerBackend;
import { writeNodeExecutable } from './helpers/node-executable';
let refillWarmPool: typeof import('../src/agent/codex-appserver/client-pool').refillWarmPool;
let shutdownResidentClients: typeof import('../src/agent/codex-appserver/client-pool').shutdownResidentClients;
let takeWarmClient: typeof import('../src/agent/codex-appserver/client-pool').takeWarmClient;
let utilityRequest: typeof import('../src/agent/codex-appserver/client-pool').utilityRequest;
let connectGated: typeof import('../src/agent/codex-appserver/client-pool').connectGated;
let CONNECT_TIMEOUT_MS: number;

beforeEach(async () => {
  vi.resetModules();
  ({ UnsentRequestError } = await import('../src/agent/types'));
  ({ AppServerClient } = await import('../src/agent/codex-appserver/app-server-client'));
  ({ CodexAppServerBackend } = await import('../src/agent/codex-appserver/backend'));
  ({ CONNECT_TIMEOUT_MS, connectGated, refillWarmPool, shutdownResidentClients, takeWarmClient, utilityRequest } = await import('../src/agent/codex-appserver/client-pool'));
});

// M-2（research/08 probe 思路的单测化）：utility client 复用/出错即重建 + 容量 1
// 预热池（取走异步补位、bin 指纹防升级错位、预热通知不漏进会话流）。真机基准
// （spawn/init/thread-start 计时、interrupt 终态）见 test/probe-appserver.mjs。
// 假 codex app-server 在所有平台通过真实可执行入口运行。
const FAKE_SERVER = `#!/usr/bin/env node
// Version probes are short-lived CLI calls, not pooled app-server processes.
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
require('fs').appendFileSync(__filename + '.count', process.pid + '\\n');
let buf = '';
let prewarm;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (typeof msg.id !== 'number') continue; // notification — ignore
    const m = msg.method;
    const p = msg.params || {};
    if (m === 'die') process.exit(1); // 不回包直接死
    if (m === 'hang') continue; // 永不回包（wedged codex）
    if (m === 'rpc/error') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } });
      continue;
    }
    if (m === 'thread/start' && p.ephemeral) {
      prewarm = p;
      // 预热路径：先吐一条「噪音」通知再回包——验证取用时被清空
      const replyWarm = () => {
        send({ jsonrpc: '2.0', method: 'prewarm/noise', params: {} });
        send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'warm_eph' } } });
      };
      const fs = require('fs');
      fs.writeFileSync(__filename + '.warm-started', String(process.pid));
      if (fs.existsSync(__filename + '.hold-warm')) {
        const gate = setInterval(() => {
          if (fs.existsSync(__filename + '.hold-warm')) return;
          clearInterval(gate);
          replyWarm();
        }, 10);
      } else replyWarm();
      continue;
    }
    if (m === 'emit') send({ jsonrpc: '2.0', method: 'real/event', params: {} });
    const result =
      m === 'warm/params' ? prewarm :
      m === 'model/list' ? { data: [{ id: 'pool-model', isDefault: true }] } :
      m === 'thread/list' ? { data: [{ id: 't1', preview: 'hi', createdAt: 1, updatedAt: 2 }] } :
      m === 'thread/read' ? { thread: { turns: [] } } :
      m === 'thread/start' ? { cwd: p.cwd, runtimeWorkspaceRoots: p.runtimeWorkspaceRoots, approvalPolicy: p.approvalPolicy, sandbox: { type: 'dangerFullAccess' }, thread: { id: 'th_' + process.pid } } :
      {};
    send({ jsonrpc: '2.0', id: msg.id, result });
  }
});
setInterval(() => {}, 1 << 30); // stay alive until killed
`;

const dirs: string[] = [];
let prevEnv: string | undefined;

/** 建一个假 codex，并把 CODEX_BIN 指过去；afterEach 统一关进程、删目录、还原 env。 */
function makeFakeCodex(): { bin: string; script: string; runs: () => number; pids: () => number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'appserver-pool-'));
  dirs.push(dir);
  const { bin, script } = writeNodeExecutable(dir, 'codex', FAKE_SERVER);
  prevEnv = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const pids = (): number[] => {
    try {
      return readFileSync(`${script}.count`, 'utf8').trim().split('\n').filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
  return { bin, script, runs: () => pids().length, pids };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

afterEach(async () => {
  await shutdownResidentClients();
  if (prevEnv === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = prevEnv;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('utility client 复用与出错即重建（M-2）', () => {
  it('model discovery uses a fresh client while listThreads/readHistory share the utility', async () => {
    const { runs } = makeFakeCodex();
    const backend = new CodexAppServerBackend();

    const models = await backend.listModels();
    expect(models.map((m) => m.id)).toEqual(['pool-model']);
    const threads = await backend.listThreads('/some/project');
    expect(threads.map((t) => t.sessionId)).toEqual(['t1']);
    const history = await backend.readHistory('/some/project', 't1');
    expect(history).toEqual({
      turns: [],
      totalTurns: 0,
      name: undefined,
      preview: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    });

    expect(runs()).toBe(2); // Model settings need a fresh snapshot; the other metadata RPCs still share one utility.
  });

  it('应用层 JSON-RPC error → 上抛但进程保留（健康进程不被 SIGKILL）', async () => {
    const { runs } = makeFakeCodex();
    await expect(utilityRequest('rpc/error')).rejects.toThrow('boom');
    expect(runs()).toBe(1);

    const res = await utilityRequest<{ data: { id: string }[] }>('model/list');
    expect(res.data[0]!.id).toBe('pool-model');
    expect(runs()).toBe(1); // 进程健康（它好好回了 error 包）——复用，不重建
  });

  it('一个调用方的 RPC error 不殃及并发在飞的请求（不 failAllPending）', async () => {
    makeFakeCodex();
    const [bad, good] = await Promise.allSettled([
      utilityRequest('rpc/error'),
      utilityRequest<{ data: { id: string }[] }>('model/list'),
    ]);
    expect(bad.status).toBe('rejected');
    expect((bad as PromiseRejectedResult).reason).toMatchObject({ message: 'boom' });
    expect(good.status).toBe('fulfilled'); // 旧行为会被 discard→SIGKILL 连坐打挂
    expect((good as PromiseFulfilledResult<{ data: { id: string }[] }>).value.data[0]!.id).toBe('pool-model');
  });

  it('进程死亡 → 后续调用自动重建', async () => {
    const { runs } = makeFakeCodex();
    await expect(utilityRequest('die')).rejects.toThrow(/app-server exited/);
    const res = await utilityRequest<{ data: { id: string }[] }>('model/list');
    expect(res.data[0]!.id).toBe('pool-model');
    expect(runs()).toBe(2);
  });

  it('超时（wedged codex）→ 报错并重建，不留挂死进程', async () => {
    const { runs } = makeFakeCodex();
    await expect(utilityRequest('hang', {}, { timeoutMs: 300 })).rejects.toThrow(/timed out/);
    const res = await utilityRequest<{ data: { id: string }[] }>('model/list');
    expect(res.data[0]!.id).toBe('pool-model');
    expect(runs()).toBe(2);
  });
});

describe('容量 1 预热池（M-2）', () => {
  it('补位→取走命中；池清空后再取扑空', async () => {
    const { bin, runs, pids } = makeFakeCodex();
    await refillWarmPool();
    expect(runs()).toBe(1);

    const client = takeWarmClient(bin);
    expect(client).not.toBeNull();
    expect(takeWarmClient(bin)).toBeNull(); // 容量 1：取走即空
    expect(await client!.request('warm/params')).toMatchObject({
      config: {
        features: { memories: false },
        memories: { use_memories: false, generate_memories: false },
        projects: { [tmpdir()]: { trust_level: 'untrusted' } },
      },
    });

    // 取走的热进程功能完好：真实 thread/start 直接可用
    const res = await client!.request<{ thread: { id: string } }>('thread/start', { cwd: '/p' });
    expect(res.thread.id).toBe(`th_${pids()[0]}`);
    expect(runs()).toBe(1); // 全程同一个进程
    await client!.close();
  });

  it('预热期间缓冲的通知被清空，不漏进会话事件流', async () => {
    const { bin } = makeFakeCodex();
    await refillWarmPool(); // 假 server 在 ephemeral thread/start 前吐了 prewarm/noise
    const client = takeWarmClient(bin)!;
    expect(client).not.toBeNull();

    await client.request('emit'); // 回包前先吐 real/event 通知
    const first = await client.stream()[Symbol.asyncIterator]().next();
    expect((first.value as { method: string }).method).toBe('real/event'); // 不是 prewarm/noise
    await client.close();
  });

  it('bin 指纹变化（codex 升级）→ 弃置热进程走冷路径', async () => {
    const { bin, runs } = makeFakeCodex();
    await refillWarmPool();
    expect(runs()).toBe(1);

    appendFileSync(bin, process.platform === 'win32' ? '\r\nrem upgraded\r\n' : '\n# upgraded\n'); // mtime+size 都变 —— 模拟原地升级
    expect(takeWarmClient(bin)).toBeNull();
    expect(runs()).toBe(1); // 没有偷偷用旧进程
  });

  it('fresh model discovery discards a ready warm slot while preserving utility and active clients', async () => {
    const { bin, pids } = makeFakeCodex();
    await utilityRequest('model/list');
    const utilityPid = pids()[0]!;
    await refillWarmPool();
    const oldWarmPid = pids()[1]!;
    const active = new AppServerClient({bin, cwd: tmpdir()});
    try {
      await active.connect();
      const activePid = active.pid!;
      await active.request('thread/start', {cwd: '/active-project'});

      expect((await new CodexAppServerBackend().listModels()).map(model => model.id)).toEqual(['pool-model']);

      expect(takeWarmClient(bin)).toBeNull();
      await vi.waitFor(() => expect(alive(oldWarmPid)).toBe(false));
      await expect(utilityRequest('model/list')).resolves.toHaveProperty('data');
      await expect(active.request('model/list')).resolves.toHaveProperty('data');
      expect(alive(utilityPid)).toBe(true);
      expect(alive(activePid)).toBe(true);
    } finally { await active.close(); }
  });

  it('fresh model discovery prevents an in-flight older warm process from entering the slot', async () => {
    const { bin, script } = makeFakeCodex();
    writeFileSync(`${script}.hold-warm`, 'hold');
    const warming = refillWarmPool();
    try {
      // This starts a real provider process; Windows ARM64 can spend more than
      // vi.waitFor's 1 s default in the launcher before initialize completes.
      await vi.waitFor(() => expect(existsSync(`${script}.warm-started`)).toBe(true), { timeout: CONNECT_TIMEOUT_MS });
      const oldWarmPid = Number(readFileSync(`${script}.warm-started`, 'utf8'));

      expect((await new CodexAppServerBackend().listModels()).map(model => model.id)).toEqual(['pool-model']);
      rmSync(`${script}.hold-warm`);
      await warming;

      expect(takeWarmClient(bin)).toBeNull();
      await vi.waitFor(() => expect(alive(oldWarmPid)).toBe(false));
    } finally {
      rmSync(`${script}.hold-warm`, {force: true});
      await warming;
    }
  });

  it('backend.startThread：冷路径触发补位，下一个会话复用热进程', async () => {
    const { bin, runs, pids } = makeFakeCodex();
    const cwd = join(bin, '..'); // 真实存在的目录（冷路径 spawn 的 cwd 必须存在）
    const backend = new CodexAppServerBackend();

    const t1 = await backend.startThread({ cwd });
    let t2: typeof t1 | undefined;
    try {
      // 先观察 backend 已发起补位，再等待这个在飞的预热完成。
      await vi.waitFor(() => expect(runs()).toBe(2), { timeout: 5000 });
      await refillWarmPool();
      const coldPid = Number(t1.sessionId.slice('th_'.length));
      expect(pids()).toContain(coldPid);
      const warmPids = pids().filter((pid) => pid !== coldPid);
      expect(warmPids).toHaveLength(1);

      t2 = await backend.startThread({ cwd });
      expect(t2.sessionId).toBe(`th_${warmPids[0]}`);
      await vi.waitFor(() => expect(runs()).toBe(3), { timeout: 5000 });
      await refillWarmPool();
      expect(runs()).toBe(3);
    } finally {
      await Promise.allSettled([t1.close(), t2?.close()]);
    }
  }, 30_000);
});

it('bounds a missing RPC response without killing unrelated requests', async () => {
  const { bin } = makeFakeCodex();
  const client = new AppServerClient({ bin, cwd: tmpdir() });
  try {
    await client.connect();
    const hanging = client.request('hang', {}, 30);
    const timedOut = expect(hanging).rejects.toThrow('delivery unknown');
    await expect(client.request('model/list', {})).resolves.toHaveProperty('data');
    await timedOut;
    expect((client as any).pending.size).toBe(0);
    await expect(client.request('model/list', {}, 1000)).resolves.toHaveProperty('data');
  } finally { await client.close(); }
});

it('classifies a locally closed request as definitely unsent', async () => {
 const client = new AppServerClient({bin:'unused',cwd:tmpdir()});
 await expect(client.request('turn/steer')).rejects.toBeInstanceOf(UnsentRequestError);
});
it('returning a notification iterator removes its pending read', async () => {
 const {bin} = makeFakeCodex(); const client = new AppServerClient({bin,cwd:tmpdir()});
 try {
  await client.connect();
  const abandoned = client.stream()[Symbol.asyncIterator]();
  const read = abandoned.next(); await abandoned.return?.();
  expect(await read).toMatchObject({done:true});
  await client.request('emit');
  const fresh = client.stream()[Symbol.asyncIterator]();
  expect(await fresh.next()).toMatchObject({done:false,value:{method:'real/event'}});
  await fresh.return?.();
 } finally {await client.close();}
});

describe('首启闸（R3-1）：同一个 CODEX_HOME 第一个进程回 initialize 之前不起第二个', () => {
  /** A fake AppServerClient whose connect settles when the test says so. */
  function fakeClient() {
    let ok!: () => void;
    let fail!: (error: Error) => void;
    const connect = vi.fn(() => new Promise<void>((resolve, reject) => { ok = resolve; fail = reject; }));
    return { connect, ok: () => ok(), fail: () => fail(new Error('app-server exited (code=1 signal=null)')) };
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const prevHome = process.env.CODEX_HOME;
  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
  });

  it('首启没落定不连第二个；成功以后闸常开，后面的一起连', async () => {
    const [a, b, c, d] = [fakeClient(), fakeClient(), fakeClient(), fakeClient()];
    const first = connectGated(a, 'codex');
    const waiting = [connectGated(b, 'codex'), connectGated(c, 'codex')];
    await tick();
    expect([a, b, c].map(x => x.connect.mock.calls.length)).toEqual([1, 0, 0]);
    a.ok();
    await first;
    await tick();
    expect([b, c].map(x => x.connect.mock.calls.length)).toEqual([1, 1]);
    b.ok(); c.ok();
    await Promise.all(waiting);
    void connectGated(d, 'codex');
    expect(d.connect).toHaveBeenCalledTimes(1);
  });

  it('首启失败就放闸，下一个接着试，仍然一次一个', async () => {
    const [a, b, c] = [fakeClient(), fakeClient(), fakeClient()];
    const first = connectGated(a, 'codex');
    const second = connectGated(b, 'codex');
    const third = connectGated(c, 'codex');
    await tick();
    a.fail();
    await expect(first).rejects.toThrow('code=1');
    await tick();
    expect([b, c].map(x => x.connect.mock.calls.length)).toEqual([1, 0]);
    b.ok();
    await second;
    await tick();
    expect(c.connect).toHaveBeenCalledTimes(1);
    c.ok();
    await third;
  });

  it('按 CODEX_HOME 分：另一个 CODEX_HOME 的首启不用等', async () => {
    const [a, b] = [fakeClient(), fakeClient()];
    process.env.CODEX_HOME = '/codex-home-a';
    void connectGated(a, 'codex');
    process.env.CODEX_HOME = '/codex-home-b';
    void connectGated(b, 'codex');
    await tick();
    expect([a, b].map(x => x.connect.mock.calls.length)).toEqual([1, 1]);
  });

  it('关闭时在等的马上放开（reject），不再连', async () => {
    const [a, b] = [fakeClient(), fakeClient()];
    // held far longer than the test may run: only shutdown can let b go
    void connectGated(a, 'codex', 60_000).catch(() => undefined);
    const waiting = connectGated(b, 'codex');
    await tick();
    await shutdownResidentClients();
    await expect(waiting).rejects.toThrow('closed');
    expect(b.connect).not.toHaveBeenCalled();
  });

  it('首启一直不落定：过了 holdMs 让下一个试，等的不会永远卡住', async () => {
    const [a, b] = [fakeClient(), fakeClient()];
    void connectGated(a, 'codex', 50);
    void connectGated(b, 'codex', 50);
    await tick();
    expect(b.connect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(b.connect).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it('等闸的时间不算进 utility 和预热自己的连接时限：首启快到时限才连上，等着的照样连上（审查 F1）', async () => {
    const { bin } = makeFakeCodex();
    // No real process: connect takes 500 ms of fake time, requests answer at once.
    const connect = vi.spyOn(AppServerClient.prototype, 'connect')
      .mockImplementation(() => new Promise(resolve => setTimeout(resolve, 500)));
    vi.spyOn(AppServerClient.prototype, 'request').mockResolvedValue({ data: [] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const holder = fakeClient();
      void connectGated(holder, bin);
      const listed = utilityRequest('model/list');
      void listed.catch(() => undefined);
      const warmed = refillWarmPool();
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 100);
      expect(connect).not.toHaveBeenCalled();
      holder.ok();
      // inside the old deadline the waiters' own connects would end past 15 s from their start
      await vi.advanceTimersByTimeAsync(1000);
      await expect(listed).resolves.toEqual({ data: [] });
      await warmed;
      expect(connect).toHaveBeenCalledTimes(2);
      expect(takeWarmClient(bin)).not.toBeNull();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('等闸只挂在这一轮上，不挂在活到关机的 Promise 上：等过 1,000 次，用过的 Promise 都能回收（审查 S3）', async () => {
    // plain objects: vitest keeps every vi.fn and the promises it returned
    const waitOnce = async (): Promise<void> => {
      let fail!: (error: Error) => void;
      const first = connectGated({ connect: () => new Promise<void>((_, reject) => { fail = reject; }) }, 'codex');
      const waiter = connectGated({ connect: () => Promise.reject(new Error('exit 1')) }, 'codex');
      fail(new Error('exit 1')); // the waiter then tries, fails too, and the gate is empty again
      await Promise.allSettled([first, waiter]);
    };
    await waitOnce();
    const live = (): number => v8.queryObjects(Promise) as number; // after a full GC
    const before = live();
    for (let i = 0; i < 1000; i++) await waitOnce();
    expect(live() - before).toBeLessThan(100);
  });
});
