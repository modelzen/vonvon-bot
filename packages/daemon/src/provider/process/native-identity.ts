import type { ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { spawnProcess } from '../../platform/spawn';
import type { ProcessIdentity, ReadProcessIdentity } from './posix-driver';
import { assertDeadline, beforeDeadline } from './tree-kill';
import type { ResourceCloseResult } from './tree-kill';

const identitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('live'), startedAtMs: z.number().positive().max(2 ** 42), groupId: z.number().int().positive().max(0x7fffffff) }).strict(),
  z.object({ kind: z.literal('missing') }).strict(),
  z.object({ kind: z.literal('unknown'), reason: z.string() }).strict(),
]);

const helperTimeoutMs = 1000;

export function nativeProcessIdentity(executable: string): ReadProcessIdentity {
  if (!isAbsolute(executable)) throw new Error('The native identity helper must have an absolute path');
  const unclosedHelpers = new Set<ChildProcess>();
  const helpers = new Map<ChildProcess, { cancel: () => void; closed: Promise<void> }>();
  let accepting = true;
  const read = async (pid: number, deadlineMs: number): Promise<ProcessIdentity> => {
    assertDeadline(deadlineMs);
    const startedAt = performance.now();
    if (!accepting) return { kind: 'unknown', reason: 'Native identity reader is closed' };
    if (startedAt >= deadlineMs) return { kind: 'unknown', reason: 'Native identity deadline expired' };
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return { kind: 'unknown', reason: 'Invalid process PID' };
    if (unclosedHelpers.size > 0) return { kind: 'unknown', reason: 'Native identity helper cleanup is unconfirmed' };
    const effectiveDeadline = Math.min(deadlineMs, startedAt + helperTimeoutMs);
    return new Promise<ProcessIdentity>(resolve => {
      let output = '';
      let settled = false;
      let child: ChildProcess;
      try { child = spawnProcess(executable, [String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { resolve({ kind: 'unknown', reason: 'Cannot start the native identity helper' }); return; }
      const timer = setTimeout(() => fail('Native identity helper timed out; cleanup is unconfirmed'), Math.max(0, effectiveDeadline - performance.now()));
      function finish(identity: ProcessIdentity): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.removeListener('data', onData);
        output = '';
        resolve(identity.kind !== 'unknown' && performance.now() >= effectiveDeadline
          ? { kind: 'unknown', reason: 'Native identity deadline expired' }
          : identity);
      }
      function fail(reason: string): void {
        if (settled) return;
        unclosedHelpers.add(child);
        finish({ kind: 'unknown', reason });
        // Keep observing close. Sending a signal does not prove helper cleanup.
        try { child.kill('SIGKILL'); }
        catch { /* The reader remains unavailable until close confirms cleanup. */ }
        child.stdout?.destroy();
      }
      function onData(chunk: string): void {
        if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > 4096) {
          fail('Native identity response exceeded its size limit; cleanup is unconfirmed');
        } else {
          output += chunk;
        }
      }
      child.on('error', () => fail('Native identity helper failed; cleanup is unconfirmed'));
      const closed = new Promise<void>(resolveClose => child.once('close', (code, signal) => {
        unclosedHelpers.delete(child);
        helpers.delete(child);
        resolveClose();
        if (settled) return;
        if (code !== 0 || signal !== null) {
          finish({ kind: 'unknown', reason: 'The native identity helper did not complete successfully' });
          return;
        }
        try {
          const result = identitySchema.safeParse(JSON.parse(output));
          finish(result.success ? result.data : { kind: 'unknown', reason: 'Invalid native identity response' });
        } catch { finish({ kind: 'unknown', reason: 'Invalid native identity response' }); }
      }));
      helpers.set(child, { cancel: () => fail('Native identity reader is closed; cleanup is unconfirmed'), closed });
      if (!child.stdout) {
        fail('Native identity helper has no output pipe; cleanup is unconfirmed');
        return;
      }
      child.stdout.on('error', () => fail('Cannot read native identity response; cleanup is unconfirmed'));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onData);
      if (performance.now() >= effectiveDeadline) fail('Native identity helper timed out; cleanup is unconfirmed');
    });
  };
  return Object.assign(read, {
    owesWork: (): boolean => helpers.size > 0,
    close: async (deadlineMs: number): Promise<ResourceCloseResult> => {
      assertDeadline(deadlineMs);
      accepting = false;
      for (const helper of helpers.values()) helper.cancel();
      if (helpers.size === 0) return 'closed';
      const result = await beforeDeadline(Promise.all([...helpers.values()].map(helper => helper.closed)), deadlineMs);
      return result.kind === 'completed' && helpers.size === 0 ? 'closed' : 'timeout';
    },
  });
}
