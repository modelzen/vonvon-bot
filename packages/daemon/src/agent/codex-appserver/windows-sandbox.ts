import { statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { OwnedProviderProcess } from '../owned-process';
import { AppServerClient, JsonRpcPeer } from '../../provider/transport/jsonrpc';
import { binChildEnv } from '../../platform/tool-path';
import { binFingerprint } from './client-pool';
import type { WindowsSandboxCapability } from './full-only';

const TTL_MS = 30_000;
const PROBE_MS = 15_000;
type ProbeResult = { capability: WindowsSandboxCapability; shellPath?: string };
type Entry = ProbeResult & { key: string; expires: number };
const failed = (): ProbeResult => ({ capability: { status: 'probeFailed' } });

/**
 * Share refresh probes; synchronous readers never start a process. Retain the last
 * verdict for an unchanged identity so the message guard can reach start/resume,
 * which must await refresh before native execution. TTL applies to that refresh;
 * a changed binary, HOME, configuration or PATH invalidates synchronous reads too.
 */
export function createWindowsSandboxCache(
  probe: (bin: string) => Promise<ProbeResult>,
  fingerprint: (bin: string) => string,
  now: () => number = Date.now,
) {
  const entries = new Map<string, Entry>();
  const flights = new Map<string, Promise<ProbeResult>>();
  const identity = (bin: string) => JSON.stringify([bin, fingerprint(bin)]);
  function entry(bin: string): Entry | undefined {
    const cached = entries.get(bin);
    return cached?.key === identity(bin) ? cached : undefined;
  }
  return {
    cached(bin: string): WindowsSandboxCapability | undefined { return entry(bin)?.capability; },
    shellPath(bin: string): string | undefined { return entry(bin)?.shellPath; },
    async refresh(bin: string, opts: { force?: boolean } = {}): Promise<WindowsSandboxCapability> {
      const key = identity(bin);
      const running = flights.get(key);
      if (running) return (await running).capability;
      const cached = entry(bin);
      if (!opts.force && cached && cached.expires > now()) return cached.capability;
      const flight = (async (): Promise<ProbeResult> => {
        let result: ProbeResult;
        try { result = await probe(bin); } catch { result = failed(); }
        // A replaced executable/config must not inherit the old process's verdict or shell.
        if (identity(bin) !== key) return failed();
        entries.set(bin, { ...result, key, expires: now() + TTL_MS });
        return result;
      })();
      flights.set(key, flight);
      try { return (await flight).capability; }
      finally { if (flights.get(key) === flight) flights.delete(key); }
    },
  };
}

const ExecInfoSchema = z.object({ environmentInfo: z.object({
  capabilities: z.object({ windowsMxc: z.boolean() }),
  shell: z.unknown().optional(),
}) });
const ShellInfoSchema = z.object({ path: z.string().refine(isAbsolute) });
const ReadinessSchema = z.object({ status: z.enum(['ready', 'notConfigured', 'updateRequired']) });

/** MXC availability is a PSEC create/close probe, not readiness's configured-backend shortcut. */
async function probeWindowsSandbox(bin: string): Promise<ProbeResult> {
  const deadline = Date.now() + PROBE_MS;
  const remaining = () => Math.max(1, deadline - Date.now());
  let owned: OwnedProviderProcess | undefined;
  let peer: JsonRpcPeer | undefined;
  let client: AppServerClient | undefined;
  let result = failed();
  try {
    result = await (async (): Promise<ProbeResult> => {
      owned = new OwnedProviderProcess(bin, ['exec-server', '--listen', 'stdio'], {
        cwd: tmpdir(), env: binChildEnv(bin), stdio: ['pipe', 'pipe', 'pipe'],
      });
      const child = owned.child as ChildProcessWithoutNullStreams;
      peer = new JsonRpcPeer(child.stdout, child.stdin);
      child.stderr.resume();
      child.once('error', error => peer?.close(error));
      child.once('exit', () => peer?.close(new Error('sandbox probe exited')));
      peer.onInvalidFrame = () => peer?.close(new Error('invalid sandbox probe response'));
      const raw = await peer.request('initialize', { clientName: 'vonvon-sandbox-probe', resumeSessionId: null }, remaining());
      const parsed = ExecInfoSchema.safeParse(raw);
      if (!parsed.success) return failed();
      const info = parsed.data.environmentInfo;
      if (!info.capabilities.windowsMxc) return { capability: { status: 'unsupported' } };
      const shell = ShellInfoSchema.safeParse(info.shell);
      if (!shell.success) return failed();
      peer.notify('initialized');
      peer.close();
      child.stdin.end();
      await owned.close();
      owned = undefined;
      if (Date.now() >= deadline) return failed();
      // Explicit MXC avoids legacy readiness's service/ACL refresh path and cannot fall back.
      client = new AppServerClient({ bin, cwd: tmpdir(), quietOutput: true,
        initializeTimeoutMs: remaining(), clientName: 'vonvon-sandbox-probe',
        configOverrides: ['windows.sandbox="mxc"', 'features.prefer_mxc=false'],
      });
      await client.connect();
      const readiness = ReadinessSchema.safeParse(await client.request('windowsSandbox/readiness', undefined, remaining()));
      if (!readiness.success) return failed();
      const capability: WindowsSandboxCapability = readiness.data.status === 'ready'
        ? { status: 'ready', implementation: 'mxc' } : { status: readiness.data.status };
      return { capability, shellPath: shell.data.path };
    })();
  } catch (error) {
    // Transport exits may hide the configuration failure: unknown failures stay probeFailed.
    if (error instanceof Error && /windows\.(?:allow_mxc|require_mxc)|invalid Windows sandbox|mxc.*not allowed|not allowed.*mxc/i.test(error.message)) {
      result = { capability: { status: 'unsupported' } };
    }
  } finally {
    peer?.close();
    try { await owned?.close(); } catch { result = failed(); }
    try { await client?.close(); } catch { result = failed(); }
  }
  return result;
}

function stamp(path: string): string {
  try { const s = statSync(path); return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`; } catch { return 'absent'; }
}
function probeKey(bin: string): string {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const files = [join(home, 'config.toml'), join(home, 'requirements.toml')];
  if (process.env.ProgramData) files.push(join(process.env.ProgramData, 'OpenAI', 'Codex', 'requirements.toml'));
  return JSON.stringify([binFingerprint(bin), home, process.env.PATH, ...files.map(stamp)]);
}
const cache = createWindowsSandboxCache(probeWindowsSandbox, probeKey);
export const cachedWindowsSandbox = cache.cached;
export const windowsShellPath = cache.shellPath;
export const refreshWindowsSandbox = cache.refresh;
