import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownedWorkUnverified } from '../../src/provider/policy/messages.zh';
import { AdmissionRefused, type HostedProcess, type ProcessHost } from '../../src/provider/process/process-host';
import { AppServerClient, JsonRpcError, JsonRpcPeer } from '../../src/provider/transport/jsonrpc';
import type { JsonRpcFrame } from '../../src/provider/transport/jsonrpc';
import { processHosts } from '../helpers/process-hosts';

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const peer = new JsonRpcPeer(input, output);
  const outbound: JsonRpcFrame[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      outbound.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  return { input, output, peer, outbound };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('JsonRpcPeer', () => {
  it('decodes a split frame, two frames in one chunk, and a split UTF-8 character', () => {
    const { input, peer } = fixture();
    const received: string[] = [];
    peer.onNotification = (_method, params) => {
      if (typeof params === 'string') received.push(params);
    };
    const first = Buffer.from('{"jsonrpc":"2.0","method":"one","params":"咖"}\n');
    const character = first.indexOf(Buffer.from('咖'));
    input.write(first.subarray(0, character + 1));
    input.write(first.subarray(character + 1));
    input.write('{"jsonrpc":"2.0","method":"two","params":"A"}\n{"jsonrpc":"2.0","method":"three","params":"B"}\n');
    expect(received).toEqual(['咖', 'A', 'B']);
  });

  it('answers server requests with numeric and string ids and defaults unknown methods', async () => {
    const { input, peer, outbound } = fixture();
    peer.onRequest = method => method === 'known' ? { result: { accepted: true } } : undefined;
    input.write('{"jsonrpc":"2.0","id":8,"method":"known"}\n');
    input.write('{"jsonrpc":"2.0","id":"remote-9","method":"other"}\n');
    await settle();
    expect(outbound).toEqual([
      { jsonrpc: '2.0', id: 8, result: { accepted: true } },
      { jsonrpc: '2.0', id: 'remote-9', error: { code: -32601, message: 'not handled' } },
    ]);
  });

  it('times out only its own request and preserves JSON-RPC error identity', async () => {
    const { input, peer, outbound } = fixture();
    const timed = peer.request('slow', {}, 10);
    const live = peer.request('live');
    expect(outbound.map(frame => frame.id)).toEqual([1, 2]);
    await expect(timed).rejects.toThrow('RPC slow response timed out; delivery unknown');
    input.write('{"jsonrpc":"2.0","id":2,"result":"ready"}\n');
    await expect(live).resolves.toBe('ready');
    const errored = peer.request('error');
    input.write('{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"bad request"}}\n');
    await expect(errored).rejects.toBeInstanceOf(JsonRpcError);
  });

  it('delivers every decoded inbound frame before dispatch, including replies and unknown methods', async () => {
    const { input, peer } = fixture();
    const frames: JsonRpcFrame[] = [];
    peer.onFrame = frame => frames.push(frame);
    const pending = peer.request('local');
    input.write('{"jsonrpc":"2.0","id":1,"result":true}\n');
    input.write('{"jsonrpc":"2.0","method":"unknown/notice","params":{"x":1}}\n');
    input.write('{"jsonrpc":"2.0","id":"server","method":"unknown/request"}\n');
    await expect(pending).resolves.toBe(true);
    await settle();
    expect(frames).toEqual([
      { jsonrpc: '2.0', id: 1, result: true },
      { jsonrpc: '2.0', method: 'unknown/notice', params: { x: 1 } },
      { jsonrpc: '2.0', id: 'server', method: 'unknown/request' },
    ]);
  });

  it.each(['request', 'notification'])('stops %s dispatch when onFrame closes, regardless of chunk boundaries', async kind => {
    for (const combined of [true, false]) {
      const { input, peer, outbound } = fixture();
      const frames: string[] = [];
      const requests: string[] = [];
      const notifications: string[] = [];
      peer.onFrame = frame => {
        if (typeof frame.method === 'string') frames.push(frame.method);
        peer.close();
      };
      peer.onRequest = method => { requests.push(method); return { result: true }; };
      peer.onNotification = method => notifications.push(method);
      const first = JSON.stringify({ method: 'first', ...(kind === 'request' ? { id: 7 } : {}) }) + '\n';
      const second = '{"method":"second"}\n';
      if (combined) input.write(first + second);
      else { input.write(first); input.write(second); }
      await peer.closed;
      input.end();
      await settle();
      expect({ requests, notifications, frames, outbound }).toEqual({
        requests: [], notifications: [], frames: ['first'], outbound: [],
      });
      await expect(peer.closed).resolves.toBeUndefined();
    }
  });

  it('stops buffered notifications after a callback closes and remains closed after EOF', async () => {
    for (const combined of [true, false]) {
      const { input, peer } = fixture();
      const notifications: string[] = [];
      const frames: string[] = [];
      peer.onFrame = frame => { if (typeof frame.method === 'string') frames.push(frame.method); };
      peer.onNotification = method => { notifications.push(method); peer.close(); };
      const first = '{"method":"first"}\n';
      const second = '{"method":"second"}\n';
      if (combined) input.write(first + second);
      else { input.write(first); input.write(second); }
      const closed = peer.closed;
      await closed;
      input.end();
      await settle();
      expect({ notifications, frames }).toEqual({ notifications: ['first'], frames: ['first'] });
      expect(peer.closed).toBe(closed);
      await expect(closed).resolves.toBeUndefined();
      await expect(peer.request('late')).rejects.toThrow('JSON-RPC peer closed');
    }
  });

  it('rejects pending requests and resolves closed on EOF, ignoring late frames', async () => {
    const { input, peer } = fixture();
    const pending = peer.request('held');
    input.end();
    await expect(pending).rejects.toThrow('JSON-RPC input ended');
    await expect(peer.closed).resolves.toBeUndefined();
    expect(() => peer.close()).not.toThrow();
    await expect(peer.request('late')).rejects.toThrow('JSON-RPC peer closed');
  });

  it('rejects pending requests and resolves closed once when output closes without an error', async () => {
    const { input, output, peer } = fixture();
    const pending = peer.request('held');
    output.destroy();
    await expect(pending).rejects.toThrow('JSON-RPC output closed');
    await expect(peer.closed).resolves.toBeUndefined();
    expect({ pending: peer.pendingCount, inputDestroyed: input.destroyed }).toEqual({ pending: 0, inputDestroyed: false });
    expect(() => peer.close()).not.toThrow();
    await expect(peer.request('late')).rejects.toThrow('JSON-RPC peer closed');
  });

  it('ignores malformed external frames without aborting a valid following frame', () => {
    const { input, peer } = fixture();
    const methods: string[] = [];
    peer.onNotification = method => methods.push(method);
    input.write('not-json\n[]\n{"jsonrpc":"2.0","method":"valid"}\n');
    expect(methods).toEqual(['valid']);
  });
});


const hosts = processHosts();
beforeAll(() => hosts.setup());
afterAll(() => hosts.teardown());

/** Runs `node <cwd>/app-server`, so no shell or cmd.exe wrapper holds a copy of the provider's pipes. */
async function connectFixture(prefix: string, onRequest: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, 'app-server'), `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
      ${onRequest}
    });
    setInterval(() => {}, 1000);
  `);
  const host = hosts.host();
  const client = new AppServerClient({ host, bin: process.execPath, cwd: dir, quietOutput: true });
  await client.connect();
  const [record] = host.snapshot();
  if (record?.providerPid === undefined) throw new Error('Fixture child did not start');
  return { dir, host, client, pid: record.providerPid };
}

const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };

describe('AppServerClient input closure', () => {
  it('rejects pending work and ends the hosted provider when readable transport ends while the provider lives', async () => {
    const { dir, host, client, pid } = await connectFixture('jsonrpc-input-close-', "if (message.method === 'end-readable') require('node:fs').closeSync(1);");
    try {
      expect(gone(pid)).toBe(false);
      await expect(client.request('end-readable')).rejects.toThrow('JSON-RPC input ended');
      await expect(client.request('late')).rejects.toThrow('app-server client closed');
      await vi.waitFor(() => expect(host.snapshot()).toEqual([]), { timeout: 10_000 });
      expect(gone(pid)).toBe(true);
      const closed = client.close();
      expect(client.close()).toBe(closed);
      await expect(closed).resolves.toBeUndefined();
      expect(client.exited).toBe(true);
    } finally {
      try { await client.close(); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('rejects pending work and ends the hosted provider when its stdin closes while the provider and stdout live', async () => {
    const { dir, host, client, pid } = await connectFixture('jsonrpc-output-close-', '');
    try {
      const pending = client.request('never-answered');
      (client as unknown as { hosted: HostedProcess }).hosted.stdin.destroy();
      await expect(pending).rejects.toThrow('JSON-RPC output closed');
      await expect(client.request('late')).rejects.toThrow('app-server client closed');
      await vi.waitFor(() => expect(host.snapshot()).toEqual([]), { timeout: 10_000 });
      expect(gone(pid)).toBe(true);
      expect(client.exited).toBe(true);
    } finally {
      try { await client.close(); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('surfaces a refused admission as owned-work-unverified and spawns nothing', async () => {
    const host = { spawn: async () => { throw new AdmissionRefused(ownedWorkUnverified()); } } as unknown as ProcessHost;
    const client = new AppServerClient({ host, bin: process.execPath, cwd: tmpdir() });
    await expect(client.connect()).rejects.toThrow(ownedWorkUnverified().message);
    await expect(client.close()).resolves.toBeUndefined();
  });
});
