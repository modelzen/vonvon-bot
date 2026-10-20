import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { SessionInUseError } from '../src/agent/types';
import { writeNodeExecutable } from './helpers/node-executable';

// s15b: a Codex session is let go after each run, its last compaction is read on
// resume, and a second writer's refusal surfaces as SessionInUseError.

// Fake app-server: thread/resume answers by threadId ('busy' = writer conflict,
// 'broken' = another error) and logs the answering pid so the test can see it exit.
const FAKE_SERVER = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let buf = '';
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const turns = {
  compacted: [
    { id: 't1', items: [{ type: 'userMessage', id: 'u1', content: [] }, { type: 'contextCompaction', id: 'cc-1' }] },
    { id: 't2', items: [{ type: 'contextCompaction', id: 'cc-2' }, { type: 'agentMessage', id: 'a1', text: 'x' }] },
    { id: 't3' },
  ],
  plain: [{ id: 't1', items: [{ type: 'agentMessage', id: 'a1', text: 'x' }] }],
};
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (typeof msg.id !== 'number') continue;
    const p = msg.params || {};
    if (msg.method === 'thread/resume') {
      fs.appendFileSync(path.join(__dirname, 'resume-pids'), process.pid + ' ' + p.threadId + '\\n');
      if (p.threadId === 'busy') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'thread-store conflict: thread busy already has an active writer' } });
        continue;
      }
      if (p.threadId === 'broken') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'thread not found' } });
        continue;
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { cwd: p.cwd, runtimeWorkspaceRoots: p.runtimeWorkspaceRoots, approvalPolicy: p.approvalPolicy, sandbox: { type: 'dangerFullAccess' }, thread: { id: p.threadId, ...(turns[p.threadId] ? { turns: turns[p.threadId] } : {}) } } });
      continue;
    }
    if (msg.method === 'turn/start') {
      if (JSON.stringify(p.input).includes('reject')) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'turn refused' } });
        continue;
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'tr' } } });
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: p.threadId, turn: { id: 'tr' } } });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: p.threadId, turn: { id: 'tr' } } });
      continue;
    }
    const result = msg.method === 'thread/start' ? { cwd: p.cwd, runtimeWorkspaceRoots: p.runtimeWorkspaceRoots, approvalPolicy: p.approvalPolicy, sandbox: { type: 'dangerFullAccess' }, thread: { id: 'th_fresh' } } : {};
    send({ jsonrpc: '2.0', id: msg.id, result });
  }
});
setInterval(() => {}, 1 << 30);
`;

const dir = mkdtempSync(join(tmpdir(), 'codex-resume-release-'));
const { bin } = writeNodeExecutable(dir, 'codex', FAKE_SERVER);

beforeEach(() => {
  vi.stubEnv('CODEX_BIN', bin);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await shutdownResidentClients();
  rmSync(dir, { recursive: true, force: true });
});

function resumePid(threadId: string): number {
  const lines = readFileSync(join(dir, 'resume-pids'), 'utf8').trim().split('\n');
  const hit = lines.reverse().find((l) => l.endsWith(` ${threadId}`));
  return Number(hit!.split(' ')[0]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Codex resume (s15b)', () => {
  it('reads the last contextCompaction across the resumed turns', async () => {
    const backend = new CodexAppServerBackend();
    const compacted = await backend.resumeThread({ cwd: dir, sessionId: 'compacted' });
    expect(compacted.lastCompaction).toBe('cc-2');
    expect(compacted.releaseAfterRun).toBe(true);
    await compacted.close();

    const plain = await backend.resumeThread({ cwd: dir, sessionId: 'plain' });
    expect(plain.lastCompaction).toBeUndefined();
    await plain.close();

    const bare = await backend.resumeThread({ cwd: dir, sessionId: 'no-turns' });
    expect(bare.lastCompaction).toBeUndefined();
    await bare.close();
  });

  it('a fresh thread is kept until its first turn is accepted, then released after runs', async () => {
    const thread = await new CodexAppServerBackend().startThread({ cwd: dir });
    expect(thread.releaseAfterRun).toBe(false);
    expect(thread.lastCompaction).toBeUndefined();
    const run = thread.runStreamed({ text: 'go' });
    // Not yet: codex has not accepted turn/start.
    expect(thread.releaseAfterRun).toBe(false);
    for await (const _ of run.events) { /* drain */ }
    expect(thread.releaseAfterRun).toBe(true);
    await thread.close();
  });

  it('a fresh thread whose turn/start is refused is still kept', async () => {
    const thread = await new CodexAppServerBackend().startThread({ cwd: dir });
    const run = thread.runStreamed({ text: 'reject' });
    const events = [];
    for await (const ev of run.events) events.push(ev);
    expect(events).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('turn refused') })]);
    expect(thread.releaseAfterRun).toBe(false);
    await thread.close();
  });

  it('a writer conflict throws SessionInUseError and the refused process is closed', async () => {
    const backend = new CodexAppServerBackend();
    const err = await backend.resumeThread({ cwd: dir, sessionId: 'busy' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(SessionInUseError);
    expect((err as SessionInUseError).sessionId).toBe('busy');
    expect(String(((err as Error).cause as Error).message)).toContain('already has an active writer');
    await vi.waitFor(() => expect(alive(resumePid('busy'))).toBe(false));
  });

  it('another resume error is rethrown as is, and its process is closed too', async () => {
    const backend = new CodexAppServerBackend();
    const err = await backend.resumeThread({ cwd: dir, sessionId: 'broken' }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SessionInUseError);
    expect((err as Error).message).toContain('thread not found');
    await vi.waitFor(() => expect(alive(resumePid('broken'))).toBe(false));
  });
});
