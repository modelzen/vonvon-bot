import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeCall } from '../src/agent/types';
import { writeNodeExecutable } from './helpers/node-executable';

type Pool = typeof import('../src/agent/codex-appserver/client-pool');
type Proc = typeof import('../src/agent/codex-appserver/judge-process');
let pool: Pool;
let proc: Proc;
let JudgeCallError: typeof import('../src/agent/types').JudgeCallError;
let CodexAppServerBackend: typeof import('../src/agent/codex-appserver/backend').CodexAppServerBackend;
let log: typeof import('../src/core/logger').log;

beforeEach(async () => {
  vi.resetModules();
  pool = await import('../src/agent/codex-appserver/client-pool');
  proc = await import('../src/agent/codex-appserver/judge-process');
  ({ JudgeCallError } = await import('../src/agent/types'));
  ({ CodexAppServerBackend } = await import('../src/agent/codex-appserver/backend'));
  ({ log } = await import('../src/core/logger'));
});

// A fake `codex app-server`. Every request goes to `<script>.log` with the pid. `MODE:<m>` in
// developerInstructions steers thread/start, in the turn input steers the turn. Files next to the
// script: `.mcp` (config/read lists, one per call, the last repeats; thread/start rejects names
// not in the last), `.skills`, `.config-error`, `.init-delay`, `.model-list-error`, `.exit-on-start`,
// `.version` (what `--version` prints; that run is not counted in `.pids`).
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('fs');
const base = __filename;
const read = (name, fallback) => { try { return JSON.parse(fs.readFileSync(base + '.' + name, 'utf8')); } catch { return fallback; } };
if (process.argv.includes('--version')) { process.stdout.write(read('version', 'codex-cli 0.163.0') + '\n'); process.exit(0); }
fs.appendFileSync(base + '.pids', process.pid + '\n');
if (read('exit-on-start', false)) process.exit(3);
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const reply = (id, result) => send({ id, result });
const later = (ms, f) => setTimeout(f, ms);
const modeOf = (text) => (/MODE:(\S+)/.exec(text || '') || [])[1] || 'ok';
const msOf = (mode) => Number(mode.split('=')[1] || 0);
let threads = 0;
let configReads = 0;
function turnEnd(threadId, turnId, text) {
  const item = (id, text, phase) => ({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id, text, phase, memoryCitation: null } } });
  const usage = (n) => ({ inputTokens: n, cachedInputTokens: n - 9, outputTokens: n - 8, totalTokens: 0, reasoningOutputTokens: Math.floor(n / 3) });
  return [
    item('c1', 'thinking out loud', 'commentary'),
    { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'f1', delta: 'final:' } },
    item('f1', 'final:' + text, 'final_answer'),
    { method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: usage(900), last: usage(11), modelContextWindow: null } } },
    { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } } },
  ];
}
const failed = (threadId, turnId, message, info) => ({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', items: [], error: { message, codexErrorInfo: info, additionalDetails: null } } } });
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (typeof msg.id !== 'number') return;
  const m = msg.method;
  const p = msg.params || {};
  fs.appendFileSync(base + '.log', JSON.stringify({ pid: process.pid, method: m, params: p }) + '\n');
  const mode = modeOf(m === 'thread/start' ? p.developerInstructions : p.input?.[0]?.text);
  const gate = 'hold-' + m.replaceAll('/', '-') + '-' + mode;
  if (read(gate, false)) {
    const timer = setInterval(() => {
      if (read(gate, false)) return;
      clearInterval(timer);
      respond(msg);
    }, 10);
    return;
  }
  respond(msg);
}
function respond(msg) {
  const m = msg.method;
  const p = msg.params || {};
  if (m === 'initialize') return later(read('init-delay', 0), () => reply(msg.id, {}));
  if (m === 'config/read') {
    if (read('config-error', false)) return send({ id: msg.id, error: { code: -32000, message: 'config broke' } });
    const seq = read('mcp', [[]]);
    const names = seq[Math.min(configReads++, seq.length - 1)];
    return reply(msg.id, { config: { mcp_servers: Object.fromEntries(names.map((n) => [n, { command: 'x', enabled: true }])) }, origins: {}, layers: null });
  }
  if (m === 'skills/list') return reply(msg.id, { data: [{ cwd: p.cwds[0], skills: read('skills', []), errors: [] }] });
  if (m === 'model/list') {
    if (read('model-list-error', false)) return send({ id: msg.id, error: { code: -32000, message: 'no list' } });
    return reply(msg.id, { data: [{ id: 'gpt-6-luna', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] });
  }
  if (m === 'thread/start') {
    const seq = read('mcp', [[]]);
    const known = seq[seq.length - 1];
    const gone = Object.keys((p.config && p.config.mcp_servers) || {}).find((n) => !known.includes(n));
    if (gone) return send({ id: msg.id, error: { code: -32600, message: 'failed to load configuration: invalid transport in mcp_servers.' + gone } });
    const mode = modeOf(p.developerInstructions);
    if (mode === 'stuck-start') return;
    if (mode === 'bad-start') return reply(msg.id, { thread: {} });
    const id = 'th' + (++threads) + '_' + process.pid;
    return later(mode.startsWith('slow-start=') ? msOf(mode) : 0, () => reply(msg.id, { thread: { id, ephemeral: true } }));
  }
  if (m === 'turn/start') {
    const text = p.input[0].text;
    const mode = modeOf(text);
    const threadId = p.threadId;
    const turnId = 'tu_' + threadId;
    const started = { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } } };
    const ok = () => reply(msg.id, { turn: { id: turnId, status: 'inProgress', items: [], error: null } });
    if (mode === 'exit') process.exit(1);
    if (mode === 'bad-turn-start') return reply(msg.id, {}); // no turn, and nothing follows
    if (mode === 'null-turn-start') { reply(msg.id, null); send(started); return turnEnd(threadId, turnId, text).forEach(send); }
    if (mode === 'early') { [started, ...turnEnd(threadId, turnId, text)].forEach(send); return ok(); }
    if (mode.startsWith('slow-turn-start=')) return later(msOf(mode), ok);
    ok();
    send(started);
    if (mode === 'hang') return;
    if (mode === 'quota') {
      send({ method: 'error', params: { threadId, turnId, willRetry: false, error: { message: 'You have hit your usage limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } } });
      return send(failed(threadId, turnId, 'You have hit your usage limit', 'usageLimitExceeded'));
    }
    if (mode === 'bad-usage') { // a usage update without last, then a normal end
      send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: {} } });
      return later(50, () => turnEnd(threadId, turnId, text).forEach(send));
    }
    if (mode === 'fail') return send(failed(threadId, turnId, (/ERR:(.*)/.exec(text) || [])[1], null));
    if (mode === 'interleave') { // each thread in order, threads interleaved
      let at = 0;
      for (const n of turnEnd(threadId, turnId, text)) { at += Math.floor(Math.random() * 40); later(at, () => send(n)); }
      return;
    }
    const delay = mode.startsWith('slow=') ? msOf(mode) : 0;
    return later(delay, () => turnEnd(threadId, turnId, text).forEach(send));
  }
  if (m === 'turn/interrupt') {
    reply(msg.id, {});
    return send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted', items: [], error: null } } });
  }
  if (m === 'thread/unsubscribe') return reply(msg.id, { status: 'unsubscribed' });
  reply(msg.id, {});
}
setInterval(() => {}, 1 << 30);
`;

const dirs: string[] = [];
let prevBin: string | undefined;
let fake: ReturnType<typeof makeFake>;

function makeFake() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-judge-'));
  dirs.push(dir);
  const { bin, script } = writeNodeExecutable(dir, 'codex', FAKE);
  prevBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const lines = (name: string): string[] => {
    try { return readFileSync(`${script}.${name}`, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
  };
  return {
    bin,
    cwd: dir,
    set: (name: string, value: unknown) => writeFileSync(`${script}.${name}`, JSON.stringify(value)),
    hold: (method: string, mode = 'ok') => {
      const file = `${script}.hold-${method.replaceAll('/', '-')}-${mode}`;
      writeFileSync(file, 'true');
      return () => writeFileSync(file, 'false');
    },
    pids: () => lines('pids').map(Number),
    requests: (method?: string) => lines('log')
      .map(line => JSON.parse(line) as { pid: number; method: string; params: Record<string, any> })
      .filter(r => !method || r.method === method),
  };
}

beforeEach(() => { fake = makeFake(); });

afterEach(async () => {
  await pool.shutdownResidentClients();
  if (prevBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = prevBin;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Observing a real child includes cold Node startup and scheduling on a busy CI runner.
const waitForProcess = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000 });

/** `start` steers thread/start, `turn` the turn (see FAKE). */
function call(turn = 'ok', o: { start?: string; signal?: AbortSignal; effort?: boolean; tag?: string } = {}): JudgeCall {
  return {
    system: `SMART 正文\nMODE:${o.start ?? 'ok'}`,
    input: `MODE:${turn}${o.tag ? ` ${o.tag}` : ''}`,
    model: 'gpt-6-luna',
    ...(o.effort === false ? {} : { effort: 'low' as const }),
    schema: { type: 'object', properties: { decision: { type: 'string' } } },
    cwd: fake.cwd,
    signal: o.signal ?? new AbortController().signal,
  };
}

function abortAfter(ms: number): { signal: AbortSignal; reason: Error } {
  const ctl = new AbortController();
  const reason = new Error('caller deadline');
  setTimeout(() => ctl.abort(reason), ms);
  return { signal: ctl.signal, reason };
}

const judge = (c: JudgeCall) => new CodexAppServerBackend().judge(c);
/** For a judgement that fails while the test awaits something else: the error, never unhandled. */
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => new Error('resolved'), (error: unknown) => error);
const threadOf = (r: { params: Record<string, any> }) => r.params.threadId as string;

describe('Codex 判断进程：参数和结果', () => {
  it('thread/start 带齐判断参数，盘点出的 MCP 和个人 skill 都关掉；turn/start 带 model、effort、outputSchema、summary', async () => {
    fake.set('mcp', [['global_probe']]);
    fake.set('skills', [{ name: 'user-skill-x', scope: 'user' }, { name: 'repo-skill', scope: 'repo' }, { name: 'sys', scope: 'system' }]);
    const c = call();
    await judge(c);
    const [start] = fake.requests('thread/start');
    expect(start!.params).toEqual({
      cwd: fake.cwd, model: 'gpt-6-luna', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
      developerInstructions: c.system, baseInstructions: proc.JUDGE_BASE_INSTRUCTIONS,
      config: {
        web_search: 'disabled',
        'features.enable_fanout': false, 'features.hooks': false,
        'features.multi_agent': false, 'features.multi_agent_v2': false,
        'features.apps': false, 'features.memories': false,
        memories: { use_memories: false, generate_memories: false },
        project_doc_max_bytes: 0,
        projects: { [fake.cwd]: { trust_level: 'untrusted' } },
        mcp_servers: { global_probe: { enabled: false } },
        skills: { bundled: { enabled: false }, config: [{ name: 'user-skill-x', enabled: false }, { name: 'repo-skill', enabled: false }] },
        'features.shell_tool': false, 'features.goals': false, 'features.view_image': false, 'features.sleep_tool': false,
      },
    });
    expect(proc.JUDGE_BASE_INSTRUCTIONS.trim()).not.toBe('');
    expect(fake.requests('config/read')[0]!.params).toEqual({ includeLayers: false, cwd: fake.cwd });
    expect(fake.requests('skills/list')[0]!.params).toEqual({ cwds: [fake.cwd] });
    const [turn] = fake.requests('turn/start');
    expect(turn!.params).toEqual({
      threadId: threadOf(turn!), input: [{ type: 'text', text: c.input, text_elements: [] }],
      model: 'gpt-6-luna', effort: 'low', outputSchema: c.schema, summary: 'none',
    });

    await judge(call('ok', { effort: false }));
    expect(fake.requests('turn/start')[1]!.params).not.toHaveProperty('effort');
  });

  it('取 final_answer，不混 commentary；用量取 total、记推理 token；第二次复用同一个进程，cold 只有第一次', async () => {
    const first = await judge(call());
    expect(first).toEqual({ text: 'final:MODE:ok', usage: { input: 900, cached: 891, output: 892, reasoning: 300 }, cold: true });
    const second = await judge(call());
    expect(second.cold).toBe(false);
    expect(new Set(fake.requests('thread/start').map(r => r.pid)).size).toBe(1);
    expect(fake.pids()).toHaveLength(1);
    // every thread is unsubscribed
    const pid = fake.pids()[0];
    await waitForProcess(() => expect(fake.requests('thread/unsubscribe').map(threadOf).sort()).toEqual([`th1_${pid}`, `th2_${pid}`]));
  });

  it('4 条并发、通知跨线程交错，各拿各的结果；cold 只给起进程的那一条', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(i => judge(call('interleave', { tag: `ID${i}` }))));
    expect(results.map(r => r.text)).toEqual([1, 2, 3, 4].map(i => `final:MODE:interleave ID${i}`));
    expect(results.map(r => r.cold)).toEqual([true, false, false, false]);
    expect(fake.pids()).toHaveLength(1);
  });

  it('thread/start 回包没有 thread.id → failed、写明回包异常，不算进程退出；进程照用', async () => {
    const error = await judge(call('ok', { start: 'bad-start' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JudgeCallError);
    expect(error).toMatchObject({ kind: 'failed', structured: false, message: expect.stringContaining('thread/start 回包异常') });
    expect((error as Error).message).not.toContain('退出了');
    expect(alive(fake.pids()[0]!)).toBe(true);
    expect((await judge(call())).cold).toBe(false);
  });

  it.each(['bad-turn-start', 'null-turn-start'])('turn/start 回包没有 turn.id（%s）→ 马上 failed、写明回包异常，没有 unhandledRejection，进程照用', async mode => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await judge(call());
      const { signal } = abortAfter(3000);
      const begun = Date.now();
      const error = await judge(call(mode, { signal })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JudgeCallError);
      expect(error).toMatchObject({ kind: 'failed', structured: false, message: expect.stringContaining('turn/start 回包异常') });
      expect(Date.now() - begun).toBeLessThan(2000);
      await sleep(100);
      expect(unhandled).toEqual([]);
      expect(alive(fake.pids()[0]!)).toBe(true);
      expect((await judge(call())).cold).toBe(false);
      expect(proc.judgeProcessStats().stuck).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('一条线程的通知缺字段 → 只这一条 failed（通知回包异常）；同进程另一条照常做完，不杀进程、不退避', async () => {
    const release = fake.hold('turn/start', 'held');
    const other = judge(call('held'));
    void other.catch(() => undefined);
    await waitForProcess(() => expect(fake.requests('turn/start')).toHaveLength(1));
    await expect(judge(call('bad-usage'))).rejects.toMatchObject({ kind: 'failed', message: expect.stringContaining('通知回包异常') });
    release();
    expect((await other).text).toBe('final:MODE:held');
    expect(fake.pids()).toHaveLength(1);
    expect(alive(fake.pids()[0]!)).toBe(true);
    expect((await judge(call())).cold).toBe(false);
  });

  it('turn/completed 比 turn/start 的回包先到，照样收得到', async () => {
    expect((await judge(call('early'))).text).toBe('final:MODE:early');
  });

  it('每条判断都重新盘点；盘点里有、config.toml 里已删的 MCP 让 thread/start 报错时，重新盘点、重试一次', async () => {
    fake.set('mcp', [['a', 'gone'], ['a']]);
    await judge(call());
    const starts = fake.requests('thread/start');
    expect(starts).toHaveLength(2);
    expect(starts[0]!.params.config.mcp_servers).toEqual({ a: { enabled: false }, gone: { enabled: false } });
    expect(starts[1]!.params.config.mcp_servers).toEqual({ a: { enabled: false } });
    expect(fake.requests('config/read')).toHaveLength(2);
    await judge(call());
    expect(fake.requests('config/read')).toHaveLength(3);
  });

  it('盘点失败照常判断，日志里有 inventory 的 error', async () => {
    fake.set('config-error', true);
    const info = vi.spyOn(log, 'info');
    expect((await judge(call())).text).toBe('final:MODE:ok');
    expect(info).toHaveBeenCalledWith('judge', 'inventory', expect.objectContaining({ error: expect.stringContaining('config broke') }));
  });

  it('peekModels：没拉过是 undefined，listModels 成功后是那份列表', async () => {
    const backend = new CodexAppServerBackend();
    expect(backend.peekModels()).toBeUndefined();
    const models = await backend.listModels();
    expect(backend.peekModels()).toBe(models);
    expect(models.map(m => m.id)).toEqual(['gpt-6-luna']);
  });

  it('peekModels：listModels 失败回落兜底列表时仍是 undefined', async () => {
    fake.set('model-list-error', true);
    const backend = new CodexAppServerBackend();
    expect((await backend.listModels()).length).toBeGreaterThan(0);
    expect(backend.peekModels()).toBeUndefined();
  });
});

describe('Codex 判断进程：超时和收尾', () => {
  it('turn 不结束：调用方的死线到了，发 turn/interrupt 和 thread/unsubscribe，进程不杀，下一条照常', async () => {
    const ctl = new AbortController();
    const reason = new Error('caller deadline');
    const pending = failure(judge(call('hang', { signal: ctl.signal })));
    // The deadline must fall in the turn, after the cold process has started.
    await waitForProcess(() => expect(fake.requests('turn/start')).toHaveLength(1));
    ctl.abort(reason);
    expect(await pending).toBe(reason);
    const [turn] = fake.requests('turn/start');
    await waitForProcess(() => expect(fake.requests('turn/interrupt').map(r => r.params)).toEqual([{ threadId: threadOf(turn!), turnId: `tu_${threadOf(turn!)}` }]));
    await waitForProcess(() => expect(fake.requests('thread/unsubscribe').map(threadOf)).toEqual([threadOf(turn!)]));
    expect(proc.judgeProcessStats()).toMatchObject({ interrupts: 1, stuck: 0 });
    const next = await judge(call());
    expect(next.cold).toBe(false);
    expect(fake.pids()).toHaveLength(1);
  });

  it('thread/start 等回包时放弃：进程不杀，同进程的另一条拿到结果；回包到了补发 unsubscribe，promise 这时才落定', async () => {
    await judge(call()); // warm
    const release = fake.hold('thread/start', 'held');
    const ctl = new AbortController();
    const reason = new Error('caller deadline');
    let settled = false;
    const late = failure(judge(call('ok', { start: 'held', signal: ctl.signal })));
    void late.then(() => { settled = true; });
    await waitForProcess(() => expect(fake.requests('thread/start')).toHaveLength(2));
    ctl.abort(reason);
    expect((await judge(call())).cold).toBe(false);
    expect(settled).toBe(false);
    release();
    expect(await late).toBe(reason);
    const pid = fake.pids()[0];
    // The held request creates its thread only after the concurrent judgement completes.
    await waitForProcess(() => expect(fake.requests('thread/unsubscribe').map(threadOf)).toEqual([`th1_${pid}`, `th2_${pid}`, `th3_${pid}`]));
    expect(fake.requests('turn/start')).toHaveLength(2); // no turn for the late one
    expect(fake.pids()).toHaveLength(1);
    expect(proc.judgeProcessStats().stuck).toBe(0);
  });

  it('turn/start 的回包晚于死线：回包到了先补发 turn/interrupt，再 unsubscribe', async () => {
    await judge(call()); // warm, so the deadline falls while turn/start waits
    await waitForProcess(() => expect(fake.requests('thread/unsubscribe')).toHaveLength(1));
    const release = fake.hold('turn/start', 'slow-turn-start=0');
    const ctl = new AbortController();
    const reason = new Error('caller deadline');
    let settled = false;
    const pending = failure(judge(call('slow-turn-start=0', { signal: ctl.signal })));
    void pending.then(() => { settled = true; });
    await waitForProcess(() => expect(fake.requests('turn/start')).toHaveLength(2));
    ctl.abort(reason);
    await sleep(0);
    expect(settled).toBe(false);
    release();
    expect(await pending).toBe(reason);
    const thread = threadOf(fake.requests('turn/start')[1]!);
    await waitForProcess(() => expect(fake.requests().filter(r => r.method === 'turn/interrupt' || r.method === 'thread/unsubscribe').slice(1))
      .toEqual([
        expect.objectContaining({ method: 'turn/interrupt', params: { threadId: thread, turnId: `tu_${thread}` } }),
        expect.objectContaining({ method: 'thread/unsubscribe', params: { threadId: thread } }),
      ]));
  });

  it('RPC 卡死（注入 stuckMs）→ 杀进程，同进程在跑的另一条 failed，进退避，退避后重建', async () => {
    proc.configureJudgeProcess({ stuckMs: 300, backoffMs: [500] });
    await judge(call()); // the process is up
    const running = failure(judge(call('hang')));
    await waitForProcess(() => expect(fake.requests('turn/start')).toHaveLength(2));
    const stuck = judge(call('ok', { start: 'stuck-start' }));
    await expect(stuck).rejects.toMatchObject({ kind: 'failed' });
    expect(await running).toMatchObject({ kind: 'failed', message: 'Codex 判断进程退出了' });
    const [pid] = fake.pids();
    await waitForProcess(() => expect(alive(pid!)).toBe(false));
    expect(proc.judgeProcessStats().stuck).toBe(1);
    await expect(judge(call())).rejects.toMatchObject({ kind: 'unavailable', message: expect.stringContaining('秒后再试') });
    await sleep(550);
    expect((await judge(call())).cold).toBe(true);
    expect(fake.pids()).toHaveLength(2);
  });

  it('总时长超过 stuckMs、每个 RPC 都及时回包：不算卡死，进程不杀', async () => {
    proc.configureJudgeProcess({ stuckMs: 200 });
    expect((await judge(call('slow=600'))).text).toBe('final:MODE:slow=600');
    expect((await judge(call('slow=600'))).cold).toBe(false);
    await sleep(300); // past stuckMs after the unsubscribe replies too
    expect(proc.judgeProcessStats().stuck).toBe(0);
    expect(fake.pids()).toHaveLength(1);
    expect(alive(fake.pids()[0]!)).toBe(true);
  });

  it('连接超时（initialize 迟迟不回）→ failed、进程被杀、不在注册表里，接着 unavailable', async () => {
    // Leave time for a cold Node process to start on the macOS CI runner, then stall initialize.
    proc.configureJudgeProcess({ connectMs: 2000, backoffMs: [10_000] });
    fake.set('init-delay', 30_000);
    await expect(judge(call())).rejects.toMatchObject({ kind: 'failed', message: expect.stringContaining('起不来') });
    const [pid] = fake.pids();
    expect(fake.requests('initialize')).toHaveLength(1);
    await waitForProcess(() => expect(alive(pid!)).toBe(false));
    await waitForProcess(() => expect(pool.residentCount()).toBe(0));
    await expect(judge(call())).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fake.pids()).toHaveLength(1);
  });

  it('二进制一启动就退出 → failed、不在注册表里，接着 unavailable', async () => {
    proc.configureJudgeProcess({ backoffMs: [10_000] });
    fake.set('exit-on-start', true);
    await expect(judge(call())).rejects.toMatchObject({ kind: 'failed', message: expect.stringContaining('起不来') });
    await waitForProcess(() => expect(fake.pids()).toHaveLength(1));
    expect(alive(fake.pids()[0]!)).toBe(false);
    await waitForProcess(() => expect(pool.residentCount()).toBe(0));
    await expect(judge(call())).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fake.pids()).toHaveLength(1);
  });

  it('进程中途退出 → 在跑的 failed、不在注册表里；退避期内 unavailable，过了重建；成功一次退避清零', async () => {
    proc.configureJudgeProcess({ backoffMs: [300, 10_000] });
    const running = failure(judge(call('hang')));
    await waitForProcess(() => expect(fake.requests('turn/start')).toHaveLength(1));
    await expect(judge(call('exit'))).rejects.toMatchObject({ kind: 'failed' });
    expect(await running).toMatchObject({ kind: 'failed', structured: false });
    await waitForProcess(() => expect(pool.residentCount()).toBe(0));
    await expect(judge(call())).rejects.toMatchObject({ kind: 'unavailable' });
    await sleep(350);
    expect((await judge(call())).cold).toBe(true);
    // the success reset the backoff: the next exit waits 300 ms again, not 10 s
    await expect(judge(call('exit'))).rejects.toMatchObject({ kind: 'failed' });
    await sleep(350);
    expect((await judge(call())).text).toBe('final:MODE:ok');
    expect(fake.pids()).toHaveLength(3);
  });
});

describe('Codex 判断进程：错误归类', () => {
  it('error 通知 usageLimitExceeded → quota、structured；进程不杀', async () => {
    await expect(judge(call('quota'))).rejects.toEqual(expect.objectContaining({ kind: 'quota', structured: true }));
    expect((await judge(call())).cold).toBe(false);
  });

  it.each([
    ['requires a newer version of Codex. Please upgrade', undefined, 'version', true],
    ["The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.", 'codex-cli 0.148.0', 'version', true],
    ["The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.", 'codex-cli 0.163.0', 'model', true],
    ["The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.", null, 'model', true],
    ['invalid credential for the gateway', undefined, 'auth', false],
    ['something odd', undefined, 'failed', false],
  ])('turn failed "%s"（版本 %s）→ %s', async (message, version, kind, structured) => {
    const readVersion = vi.fn(async () => version ?? null);
    proc.configureJudgeProcess({ version: readVersion });
    const error = await judge(call(`fail\nERR:${message}`)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JudgeCallError);
    expect(error).toMatchObject({ kind, structured, message });
    expect(readVersion).toHaveBeenCalledTimes(message.includes('not supported') ? 1 : 0);
  });
});

describe('Codex 判断进程：原地升级后的版本', () => {
  it('"not supported" 按新进程读到的新版本归类，不用 locate 缓存里的旧版本', async () => {
    const message = "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.";
    fake.set('version', 'codex-cli 0.150.0');
    await expect(judge(call(`fail\nERR:${message}`))).rejects.toMatchObject({ kind: 'version' });
    // upgraded in place: same path, new fingerprint, new version
    fake.set('version', 'codex-cli 0.163.0');
    appendFileSync(fake.bin, '\n# upgraded\n');
    await expect(judge(call(`fail\nERR:${message}`))).rejects.toMatchObject({ kind: 'model' });
    expect(fake.pids()).toHaveLength(2);
  });
});

describe('Codex 判断进程：空闲、换版本、关机', () => {
  it('空闲 idleMs 后关掉，下一条起新进程', async () => {
    proc.configureJudgeProcess({ idleMs: 200 });
    await judge(call());
    const [pid] = fake.pids();
    await waitForProcess(() => expect(alive(pid!)).toBe(false));
    await waitForProcess(() => expect(pool.residentCount()).toBe(0)); // untracked once close() settles, just after the exit
    expect((await judge(call())).cold).toBe(true);
    expect(fake.pids()).toHaveLength(2);
  });

  it('起进程的那条判断先放弃了：进程照样连完，空闲后关掉', async () => {
    proc.configureJudgeProcess({ idleMs: 300 });
    const release = fake.hold('initialize');
    const ctl = new AbortController();
    const reason = new Error('caller deadline');
    const pending = failure(judge(call('ok', { signal: ctl.signal })));
    await waitForProcess(() => expect(fake.requests('initialize')).toHaveLength(1));
    ctl.abort(reason);
    expect(await pending).toBe(reason);
    await waitForProcess(() => expect(fake.pids()).toHaveLength(1));
    const [pid] = fake.pids();
    expect(alive(pid!)).toBe(true);
    release();
    await waitForProcess(() => expect(proc.judgeProcessStats().spawned).toBe(1));
    await waitForProcess(() => expect(alive(pid!)).toBe(false));
    await waitForProcess(() => expect(pool.residentCount()).toBe(0));
    expect(fake.requests('thread/start')).toHaveLength(0);
  });

  it('二进制指纹变了：在跑的留在旧进程做完，新判断起新进程，旧的空下来就关', async () => {
    const release = fake.hold('turn/start', 'held');
    const running = judge(call('held'));
    void running.catch(() => undefined);
    await waitForProcess(() => expect(fake.requests('turn/start')).toHaveLength(1));
    appendFileSync(fake.bin, '\n# upgraded\n');
    const fresh = await judge(call());
    expect(fresh.cold).toBe(true);
    const [oldPid, newPid] = fake.pids();
    expect(newPid).toBeDefined();
    expect(fake.requests('turn/start').map(r => r.pid)).toEqual([oldPid, newPid]);
    expect(alive(oldPid!)).toBe(true);
    expect(pool.residentCount()).toBe(2);
    release();
    expect((await running).text).toBe('final:MODE:held');
    await waitForProcess(() => expect(alive(oldPid!)).toBe(false));
    await waitForProcess(() => expect(pool.residentCount()).toBe(1));
    expect((await judge(call())).cold).toBe(false);
  });

  it('做满 recycleAfter 条换新：下一条起新进程（cold），旧进程关掉，没有判断失败', async () => {
    proc.configureJudgeProcess({ recycleAfter: 3 });
    const info = vi.spyOn(log, 'info');
    const colds: boolean[] = [];
    for (let i = 0; i < 7; i++) colds.push(Boolean((await judge(call())).cold));
    expect(colds).toEqual([true, false, false, true, false, false, true]);
    const [first, second, third] = fake.pids();
    expect(fake.pids()).toHaveLength(3);
    expect(new Set(fake.requests('turn/start').map(r => r.pid))).toEqual(new Set([first, second, third]));
    await waitForProcess(() => expect([first, second].map(pid => alive(pid!))).toEqual([false, false]));
    expect(alive(third!)).toBe(true);
    expect(proc.judgeProcessStats().recycled).toBe(2);
    expect(info).toHaveBeenCalledWith('judge', 'process-retire', expect.objectContaining({ why: 'count', judgements: 3 }));
  });

  it('换新不打断在飞的：做满时在跑的那条留在旧进程做完，旧进程这才关', async () => {
    proc.configureJudgeProcess({ recycleAfter: 2 });
    await judge(call());
    const release = fake.hold('turn/start', 'held');
    const running = judge(call('held'));
    void running.catch(() => undefined);
    await waitForProcess(() => expect(fake.requests('turn/start')).toHaveLength(2));
    const fresh = await judge(call());
    expect(fresh.cold).toBe(true);
    const [oldPid, newPid] = fake.pids();
    expect(alive(oldPid!)).toBe(true);
    release();
    expect((await running).text).toBe('final:MODE:held');
    expect(fake.requests('turn/start').map(r => r.pid)).toEqual([oldPid, oldPid, newPid]);
    await waitForProcess(() => expect(alive(oldPid!)).toBe(false));
    expect(alive(newPid!)).toBe(true);
  });

  it('换新时几条同时来：同一刻分给旧进程的那条照样做完，只起一个新进程，cold 只给起进程的那一条', async () => {
    proc.configureJudgeProcess({ recycleAfter: 2 });
    await judge(call());
    const results = await Promise.all([1, 2, 3].map(i => judge(call('ok', { tag: `ID${i}` }))));
    expect(results.map(r => r.text)).toEqual([1, 2, 3].map(i => `final:MODE:ok ID${i}`));
    expect(results.map(r => r.cold)).toEqual([false, true, false]);
    const [oldPid, newPid] = fake.pids();
    expect(fake.pids()).toHaveLength(2);
    expect(fake.requests('turn/start').map(r => r.pid)).toEqual([oldPid, oldPid, newPid, newPid]);
    expect(proc.judgeProcessStats()).toMatchObject({ spawned: 2, recycled: 1 });
    await waitForProcess(() => expect(alive(oldPid!)).toBe(false));
  });

  it('shutdownResidentClients 关掉判断进程，在跑的马上结束，之后再起被拒', async () => {
    const running = failure(judge(call('hang')));
    await waitForProcess(() => expect(fake.requests('turn/start')).toHaveLength(1));
    await pool.shutdownResidentClients();
    expect(await running).toMatchObject({ kind: 'closed' });
    expect(alive(fake.pids()[0]!)).toBe(false);
    await expect(judge(call())).rejects.toMatchObject({ kind: 'closed' });
  });

  it('正在连接时关机：连接方自己关掉，没有孤儿进程', async () => {
    fake.hold('initialize');
    const pending = failure(judge(call()));
    await waitForProcess(() => expect(fake.requests('initialize')).toHaveLength(1));
    await pool.shutdownResidentClients();
    expect(await pending).toMatchObject({ kind: 'closed' });
    expect(fake.pids().filter(alive)).toEqual([]);
    expect(pool.residentCount()).toBe(0);
  });
});

describe('Codex 首启闸（R3-1）', () => {
  it('第一个进程回 initialize 之前不起第二个：会话、判断和预热依次起来，都成功', async () => {
    const release = fake.hold('initialize');
    const backend = new CodexAppServerBackend();
    const session = backend.startThread({ cwd: fake.cwd });
    const judged = judge(call());
    void session.catch(() => undefined);
    void judged.catch(() => undefined);
    await waitForProcess(() => expect(fake.requests('initialize')).toHaveLength(1));
    await sleep(300);
    expect(fake.pids()).toHaveLength(1);
    release();
    const thread = await session;
    try {
      expect((await judged).text).toBe('final:MODE:ok');
      // the session, the judge process and the prewarm refill the session's cold start asked for
      await waitForProcess(() => expect(fake.pids()).toHaveLength(3));
      await pool.refillWarmPool();
    } finally {
      await thread.close();
    }
  });

  it('会话冷启动连上之后才补预热位', async () => {
    const release = fake.hold('initialize');
    const session = new CodexAppServerBackend().startThread({ cwd: fake.cwd });
    void session.catch(() => undefined);
    await waitForProcess(() => expect(fake.requests('initialize')).toHaveLength(1));
    await sleep(300);
    expect(fake.pids()).toHaveLength(1);
    release();
    const thread = await session;
    try {
      expect(thread.sessionId).toBe(`th1_${fake.pids()[0]}`); // the session got the first process
      await waitForProcess(() => expect(fake.pids()).toHaveLength(2));
      await pool.refillWarmPool();
    } finally {
      await thread.close();
    }
  });
});
