import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { TailscaleInfo } from './address';

export type Exec = (file: string, args: string[], options: { timeout: number }, done: (error: (Error & { code?: unknown }) | null, stdout: string) => void) => void;
const run: Exec = (file, args, options, done) => { execFile(file, args, { ...options, encoding: 'utf8', windowsHide: true }, (error, stdout) => done(error, String(stdout))); };

/** devices-ui-3 4.2: where the Tailscale app keeps its own command when it is not on PATH. The Mac app does not put it
 * there (and a background service's PATH is shorter still); the Windows installer may not either. */
export function bundledTailscale(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  if (platform === 'win32' && env.ProgramFiles) return [join(env.ProgramFiles, 'Tailscale', 'tailscale.exe')];
  return [];
}

/** devices 4.2 and D3 4.3: this machine's Tailscale addresses, both families, from `tailscale ip`. No command, here or
 * in the app's own place (devices-ui-3): not installed. A command that fails or does not answer in 5 seconds (tailscaled
 * not logged in yet): installed, no address. */
export function tailscaleIps({ exec = run, timeoutMs = 5_000, platform = process.platform, env = process.env }: { exec?: Exec; timeoutMs?: number; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): Promise<TailscaleInfo> {
  const commands = ['tailscale', ...bundledTailscale(platform, env)];
  return new Promise(resolve => {
    let settled = false;
    const done = (info: TailscaleInfo): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(info); } };
    // execFile's own timeout kills the child; this one answers even when the kill does not end it.
    const timer = setTimeout(() => done({ installed: true, ips: [] }), timeoutMs);
    timer.unref();
    const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
    const attempt = (index: number): void => {
      const file = commands[index];
      if (file === undefined) { done({ installed: false, ips: [] }); return; }
      try {
        exec(file, ['ip'], { timeout: timeoutMs }, (error, stdout) => {
          if (error && missing(error)) { attempt(index + 1); return; }
          if (error) { done({ installed: true, ips: [] }); return; }
          done({ installed: true, ips: stdout.split(/\s+/).filter(line => isIP(line) !== 0) });
        });
      } catch (error) {
        if (missing(error)) attempt(index + 1);
        else done({ installed: true, ips: [] });
      }
    };
    attempt(0);
  });
}
