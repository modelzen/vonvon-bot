import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeOwnedProviderProcesses, OwnedProviderProcess, ProviderProcessExitError } from '../src/agent/owned-process';
import { JudgeCallError } from '../src/agent/types';
import { claudeWithFakeCli, writeWaitingClaudeCli } from './helpers/fake-claude-cli';

const fake = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/core/logger', () => ({ log: fake.log }));

// The Claude CLI (2.1.296, JP-VPS 2026-10-18) handles SIGTERM itself and exits 143 instead of dying
// of the signal. Our own SIGTERM ending a child that way is a clean stop (s23c review F2).
const win32 = process.platform === 'win32';
const roots: string[] = [];
const pids: number[] = [];
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'owned-term-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function owned(script: string, ready = true): Promise<OwnedProviderProcess> {
  const child = new OwnedProviderProcess(process.execPath, ['-e', script], { cwd: await tempRoot(), stdio: ['pipe', 'pipe', 'pipe'] }, 'Claude');
  pids.push(child.child.pid!);
  child.child.stderr?.resume();
  if (ready) await new Promise(resolve => child.child.stdout!.once('data', resolve));
  child.child.stdout!.resume();
  return child;
}
const onTerm = (code: number, delay: number) => `process.on('SIGTERM', () => setTimeout(() => process.exit(${code}), ${delay})); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;

describe('owned provider process exit status', () => {
  it.skipIf(win32)('a child that exits 143 after our SIGTERM closes cleanly', async () => {
    const child = await owned(onTerm(143, 30));
    await expect(child.close()).resolves.toBeUndefined();
    expect(await child.exited).toEqual({ kind: 'exit', code: 143, signal: null });
    expect(alive(child.child.pid!)).toBe(false);
  });

  it.skipIf(win32)('143 nobody asked for, or another code after our SIGTERM, is still an exit failure', async () => {
    const own = await owned('process.exit(143)', false);
    expect((await own.exited).code).toBe(143);
    await expect(own.close()).rejects.toBeInstanceOf(ProviderProcessExitError);
    const crash = await owned(onTerm(1, 0));
    await expect(crash.close()).rejects.toBeInstanceOf(ProviderProcessExitError);
    expect((await crash.exited).code).toBe(1);
  });

  // Last: closing the registry stops this module from starting any more owned processes.
  it.skipIf(win32)('closing the registry mid-judgement resolves when the CLI exits 143 on our SIGTERM', async () => {
    const root = await tempRoot();
    const { cli, pidFile } = await writeWaitingClaudeCli(root);
    const pending = claudeWithFakeCli(root, cli).judge!({ system: 'fake', input: 'fake', model: 'fake', schema: {}, cwd: root, signal: new AbortController().signal })
      .then(value => ({ value }), (error: unknown) => ({ error }));
    await expect.poll(async () => readFile(`${pidFile}.user`, 'utf8').catch(() => undefined), { timeout: 10_000 }).toBe('1');
    const pid = Number(await readFile(pidFile, 'utf8'));
    pids.push(pid);
    await expect(closeOwnedProviderProcesses()).resolves.toBeUndefined();
    const outcome = await pending;
    expect('error' in outcome && outcome.error).toBeInstanceOf(JudgeCallError);
    expect(alive(pid)).toBe(false);
    expect(fake.log.fail).not.toHaveBeenCalled();
  });
});
