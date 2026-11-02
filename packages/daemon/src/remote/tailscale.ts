import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import type { TailscaleInfo } from './address';

export type Exec = (file: string, args: string[], options: { timeout: number }, done: (error: (Error & { code?: unknown }) | null, stdout: string) => void) => void;
const run: Exec = (file, args, options, done) => { execFile(file, args, { ...options, encoding: 'utf8', windowsHide: true }, (error, stdout) => done(error, String(stdout))); };

/** devices 4.2 and D3 4.3: this machine's Tailscale addresses, both families, from `tailscale ip`. No command: not
 * installed. A command that fails or does not answer in 5 seconds (tailscaled not logged in yet): installed, no address.
 * The Tailscale app's own command where it is not on PATH (macOS, Windows) is U3's. */
export function tailscaleIps({ exec = run, timeoutMs = 5_000 }: { exec?: Exec; timeoutMs?: number } = {}): Promise<TailscaleInfo> {
  return new Promise(resolve => {
    let settled = false;
    const done = (info: TailscaleInfo): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(info); } };
    // execFile's own timeout kills the child; this one answers even when the kill does not end it.
    const timer = setTimeout(() => done({ installed: true, ips: [] }), timeoutMs);
    timer.unref();
    try {
      exec('tailscale', ['ip'], { timeout: timeoutMs }, (error, stdout) => {
        if (error) { done({ installed: error.code !== 'ENOENT', ips: [] }); return; }
        done({ installed: true, ips: stdout.split(/\s+/).filter(line => isIP(line) !== 0) });
      });
    } catch (error) {
      done({ installed: !(error instanceof Error && 'code' in error && error.code === 'ENOENT'), ips: [] });
    }
  });
}
