import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { BWRAP_TRIAL, type ClaudeSandbox } from '@vonvon/protocol';

type Trial = { code: number | null; stderr: string; timedOut: boolean };
export type ProbeDependencies = {
  platform: NodeJS.Platform;
  path: string | undefined;
  executable: (file: string) => Promise<boolean>;
  run: (file: string, args: string[], timeoutMs: number) => Promise<Trial>;
  read: (file: string) => Promise<string | undefined>;
};

const STDERR_LIMIT = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** No shell, cwd `/`, stdout dropped, the first 4 KB of stderr kept, SIGKILL at the deadline. */
export function runTrial(file: string, args: string[], timeoutMs: number): Promise<Trial> {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd: '/', stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < STDERR_LIMIT) stderr = (stderr + chunk.toString()).slice(0, STDERR_LIMIT); });
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, stderr: error.message, timedOut }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stderr, timedOut }); });
  });
}

const defaults = (): ProbeDependencies => ({
  platform: process.platform, path: process.env.PATH,
  executable: file => Promise.all([access(file, constants.X_OK), stat(file)]).then(([, info]) => info.isFile(), () => false),
  run: runTrial,
  read: file => readFile(file, 'utf8').catch(() => undefined),
});

/** Looks through the PATH the way Claude's CLI does, without starting `which`. */
async function find(name: string, d: ProbeDependencies): Promise<string | null> {
  for (const dir of (d.path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, name);
    if (await d.executable(file)) return file;
  }
  return null;
}

/**
 * Linux only; undefined elsewhere. Claude Code finds `bwrap` and `socat` on the PATH and, for a normal user, only learns
 * that AppArmor or a sysctl blocks user namespaces when a turn starts, so the checklist runs bwrap once itself.
 */
export async function probeClaudeSandbox(overrides: Partial<ProbeDependencies> = {}): Promise<ClaudeSandbox | undefined> {
  const d = { ...defaults(), ...overrides };
  if (d.platform !== 'linux') return undefined;
  const [bwrap, socat] = await Promise.all([find('bwrap', d), find('socat', d)]);
  const base = { bwrap, socat: socat !== null };
  if (!bwrap) return { ...base, userns: 'unchecked' };
  const result = await d.run(bwrap, BWRAP_TRIAL, 5_000);
  if (result.code === 0 && !result.timedOut) return { ...base, userns: 'ok' };
  if ((await d.read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'))?.trim() === '1') return { ...base, userns: 'apparmor' };
  for (const [file, setting] of [['/proc/sys/kernel/unprivileged_userns_clone', 'kernel.unprivileged_userns_clone'], ['/proc/sys/user/max_user_namespaces', 'user.max_user_namespaces']] as const) {
    if ((await d.read(file))?.trim() === '0') return { ...base, userns: 'disabled', detail: setting };
  }
  const line = result.timedOut ? '5 秒内没有退出' : result.stderr.trim().split('\n')[0]?.replace(CONTROL, '').slice(0, 200) || `退出码 ${result.code}`;
  return { ...base, userns: 'failed', detail: line };
}
