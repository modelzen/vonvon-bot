import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { BWRAP_TRIAL, probeClaudeSandbox, runTrial, type ProbeDependencies } from '../src/agent/claude-agent/sandbox-probe';

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); });

/** Fake PATH entries, a fake bwrap run and fake /proc files. */
function probe(found: string[], trial: Awaited<ReturnType<ProbeDependencies['run']>>, proc: Record<string, string> = {}, platform: NodeJS.Platform = 'linux') {
  const run = vi.fn(async () => trial);
  const overrides: Partial<ProbeDependencies> = { platform, path: '/usr/local/bin:relative:/usr/bin', executable: async file => found.includes(file), run, read: async file => proc[file] };
  return { run, result: () => probeClaudeSandbox(overrides) };
}
const ok = { code: 0, stderr: '', timedOut: false };
const refused = { code: 1, stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\nmore', timedOut: false };

it('checks nothing outside Linux and does not run a missing bwrap', async () => {
  expect(await probe(['/usr/bin/bwrap'], ok, {}, 'darwin').result()).toBeUndefined();
  const missing = probe(['/usr/bin/socat'], ok);
  expect(await missing.result()).toEqual({ bwrap: null, socat: true, userns: 'unchecked' });
  expect(missing.run).not.toHaveBeenCalled();
});

it('runs the first bwrap on the PATH once and reports a missing socat next to it', async () => {
  const both = probe(['/usr/local/bin/bwrap', '/usr/bin/bwrap', '/usr/bin/socat'], ok);
  expect(await both.result()).toEqual({ bwrap: '/usr/local/bin/bwrap', socat: true, userns: 'ok' });
  expect(both.run).toHaveBeenCalledWith('/usr/local/bin/bwrap', BWRAP_TRIAL, 5_000);
  expect(await probe(['/usr/bin/bwrap'], ok).result()).toEqual({ bwrap: '/usr/bin/bwrap', socat: false, userns: 'ok' });
});

it.each([
  [{ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' }, { userns: 'apparmor' }],
  [{ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n', '/proc/sys/kernel/unprivileged_userns_clone': '0\n' }, { userns: 'disabled', detail: 'kernel.unprivileged_userns_clone' }],
  [{ '/proc/sys/user/max_user_namespaces': '0\n' }, { userns: 'disabled', detail: 'user.max_user_namespaces' }],
  [{ '/proc/sys/user/max_user_namespaces': '15000\n' }, { userns: 'failed', detail: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' }],
])('classifies a failed trial with %j', async (proc, expected) => {
  expect(await probe(['/usr/bin/bwrap', '/usr/bin/socat'], refused, proc).result()).toEqual({ bwrap: '/usr/bin/bwrap', socat: true, ...expected });
});

it('keeps one clean line of a failure and calls a timeout a failure', async () => {
  const noisy = { code: 1, stderr: `\u001b[31mbwrap: ${'x'.repeat(300)}\u0007\nsecond`, timedOut: false };
  const detail = (await probe(['/usr/bin/bwrap'], noisy).result())?.detail ?? '';
  expect(detail).toMatch(/^\[31mbwrap: x+$/);
  expect(detail).toHaveLength(200);
  expect(await probe(['/usr/bin/bwrap'], { code: null, stderr: '', timedOut: true }).result()).toMatchObject({ userns: 'failed', detail: '5 秒内没有退出' });
});

it('runs a real executable from the PATH, skips one without the execute bit, and kills a trial at the deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-sandbox-probe-')); dirs.push(dir);
  const bwrap = join(dir, 'bwrap');
  await writeFile(bwrap, '#!/bin/sh\necho "fake: $1 $6" >&2\nexit 3\n'); await chmod(bwrap, 0o755);
  await writeFile(join(dir, 'socat'), '');
  expect(await probeClaudeSandbox({ platform: 'linux', path: dir, read: async () => undefined })).toEqual({ bwrap, socat: false, userns: 'failed', detail: 'fake: --ro-bind --unshare-all' });
  const started = Date.now();
  expect(await runTrial('/bin/sh', ['-c', 'exec sleep 30'], 100)).toEqual({ code: null, stderr: '', timedOut: true });
  expect(Date.now() - started).toBeLessThan(5_000);
});
