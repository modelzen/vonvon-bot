import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppServerClient } from '../src/agent/codex-appserver/app-server-client';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { bindCodexHost, shutdownResidentClients } from '../src/provider/engines/codex/client-pool';
import type { ProcessHost } from '../src/provider/process/process-host';
import { writeNodeExecutable } from './helpers/node-executable';
import { processHosts } from './helpers/process-hosts';

// 一个最小的假 codex app-server：应答 initialize / thread/start，收到 turn/start
// 即自杀且不回包（模拟 app-server 中途崩溃），在所有平台运行真实子进程。
const FAKE_SERVER = `#!/usr/bin/env node
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (typeof msg.id !== 'number') continue; // notification — ignore
    if (msg.method === 'turn/start') process.exit(1); // crash mid-turn, no reply
    const result = msg.method === 'thread/start' ? { thread: { id: 'th_test' } } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
setInterval(() => {}, 1 << 30); // stay alive until killed
`;

const dir = mkdtempSync(join(tmpdir(), 'app-server-liveness-'));
const { bin } = writeNodeExecutable(dir, 'codex', FAKE_SERVER);

const hosts = processHosts();
let host: ProcessHost;
beforeAll(() => {
  hosts.setup();
  host = hosts.host();
  bindCodexHost(host);
});
afterAll(async () => {
  await shutdownResidentClients();
  await hosts.teardown();
  rmSync(dir, { recursive: true, force: true });
});

describe('app-server 进程死亡自愈（QW-6）', () => {
  it('exited flips on child death; pending request rejects, later requests fail fast', async () => {
    const client = new AppServerClient({ host, bin, cwd: dir });
    await client.connect();
    expect(client.exited).toBe(false);

    // turn/start 让假 server 直接退出且不回包 → exit 处理器拒掉 pending
    await expect(client.request('turn/start', {})).rejects.toThrow(/app-server exited|JSON-RPC output closed/);
    expect(client.exited).toBe(true);
    // 死后的新请求立即拒绝，而不是写进断管
    await expect(client.request('thread/list')).rejects.toThrow(/closed/);
    await vi.waitFor(() => expect(host.snapshot()).toEqual([]));
  });

  it('thread.isAlive() goes false after the process dies mid-turn', async () => {
    const prev = process.env.CODEX_BIN;
    process.env.CODEX_BIN = bin;
    try {
      const backend = new CodexAppServerBackend();
      const thread = await backend.startThread({ cwd: dir });
      expect(thread.sessionId).toBe('th_test');
      expect(thread.isAlive()).toBe(true);

      // 消费这轮事件流：进程死亡 → 流随 notifications.close() 结束（或 start-race
      // 先吐一个 error 事件），循环必然终止
      for await (const ev of thread.runStreamed({ text: 'boom' }).events) {
        void ev;
      }
      // exit 事件与流结束之间有微小竞态，等到 isAlive 翻转为止
      await vi.waitFor(() => expect(thread.isAlive()).toBe(false));
    } finally {
      if (prev === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = prev;
    }
  });
});


describe('app-server shutdown completion', { timeout: 20_000 }, () => {
  it('settles a missing executable as a refused launch that leaves no owned record', async () => {
    const host = hosts.host();
    const client = new AppServerClient({ host, bin: join(dir, 'missing-app-server'), cwd: dir, initializeTimeoutMs: 10_000 });
    await expect(client.connect()).rejects.toThrow();
    await expect(client.close()).resolves.toBeUndefined();
    expect(host.snapshot()).toEqual([]);
    expect(host.owesWork()).toBe(false);
  });

  it('close escalates an ignored SIGTERM and retires the record only once the provider is gone', async () => {
    const fixture = writeNodeExecutable(dir, 'ignores-term', `
      process.on('SIGTERM', () => {});
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const msg=JSON.parse(line);
        if(msg.id)process.stdout.write(JSON.stringify({id:msg.id,result:{}})+'\\n');
      });
    `);
    const host = hosts.host();
    const client = new AppServerClient({ host, bin: fixture.bin, cwd: dir, initializeTimeoutMs: 10_000 });
    await client.connect();
    const [record] = host.snapshot();
    expect(record).toMatchObject({ providerId: 'codex', stage: 'running', ownership: 'bound' });
    await expect(client.close()).resolves.toBeUndefined();
    expect(client.exited).toBe(true);
    expect(host.snapshot()).toEqual([]);
    expect(() => process.kill(record!.providerPid!, 0)).toThrow();
  });
});
