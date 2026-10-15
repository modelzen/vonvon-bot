import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HostEndpoint } from '../host/discovery';
import { isStaleOwner, readRunningPidLock, type StaleOwner } from '../server/pid-lock';
import { stopVerifiedOwner, verifyPidLockOwner } from '../server/owner-verification';
import { renderDefinition, type Definition } from './definitions';
import { runtimeDistribution } from './distribution';
import { createServiceDrain, type DrainFailure, type DrainScope, type OwnerIdentity } from './drain';
import { SYSTEMD_UNIT_NAME, resolveServiceRoot, serviceTarget, type CanonicalRoot } from './identity';
import { readRegistration, type Registration } from './registration';

type CommandResult = { ok: boolean; status: number | null; stdout: string; stderr: string };
type UnitObservation =
  | { kind: 'absent' }
  | { kind: 'present'; loadState: string; fragmentPath: string; mainPid: number | null }
  | { kind: 'unknown'; detail: string };
type EnableObservation = { kind: 'enabled' } | { kind: 'not-enabled'; state: string } | { kind: 'unknown'; detail: string };
type TransactionOutcome = {
  kind: 'installed' | 'already-installed' | 'uninstalled' | 'not-installed'
    | 'install_refused' | 'install_rolled_back' | 'install_incomplete'
    | 'uninstall_refused' | 'uninstall_rolled_back' | 'uninstall_incomplete';
  detail: string;
  retained: OwnerIdentity | null;
  leftovers: readonly string[];
};
type Snapshot = { root: CanonicalRoot; target: { platform: 'linux'; unitPath: string }; expected: Uint8Array | null; temporaryLeftovers: string[] };
type RemovalResult =
  | { kind: 'unloaded' }
  | DrainFailure
  | { kind: 'withdrawal-failed' | 'unload-failed'; detail: string };
type Dependencies = {
  run: (args: string[], timeoutMs: number) => Promise<CommandResult>;
  resolveRoot: typeof resolveServiceRoot;
  registration: typeof readRegistration;
  distribution: typeof runtimeDistribution;
  readOwner: typeof readRunningPidLock;
  verifyOwner: typeof verifyPidLockOwner;
  stopOwner: typeof stopVerifiedOwner;
  mkdir: typeof mkdir;
  open: typeof open;
  rename: typeof rename;
  unlink: typeof unlink;
  freePort: () => Promise<number>;
  pause: (ms: number) => Promise<void>;
  now: () => number;
  home: string;
  xdgConfigHome: string | undefined;
  executable: string;
  capturedPath: string;
};

function runSystemctl(args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn('systemctl', ['--user', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); resolve({ ok: false, status: null, stdout, stderr: error.message }); });
    child.once('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !expired, status: expired ? null : code, stdout, stderr: expired ? 'systemctl client timed out' : stderr }); });
  });
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else if (address && typeof address !== 'string') resolve(address.port);
        else reject(new Error('Cannot select a service port'));
      });
    });
  });
}
const detailOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const identity = (owner: OwnerIdentity | null): OwnerIdentity | null => owner === null ? null : { pid: owner.pid, startedAt: owner.startedAt };
const sameOwner = (a: OwnerIdentity | null, b: OwnerIdentity | null): boolean => a === null ? b === null : b !== null && a.pid === b.pid && a.startedAt === b.startedAt;
const registrationDetail = (r: Registration): string => r.kind === 'other-root' ? `Registration belongs to ${r.recordedRoot}` : r.kind === 'unrecognized' ? `Unrecognized registration ${r.location}: ${r.reason}` : `Registration is ${r.kind}`;
function mainPid(value: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Malformed MainPID');
  return value === '0' ? null : Number(value);
}

export function createSystemdService(options: { root: string }, overrides: Partial<Dependencies> = {}) {
  const d: Dependencies = {
    run: runSystemctl, resolveRoot: resolveServiceRoot, registration: readRegistration,
    distribution: runtimeDistribution, readOwner: readRunningPidLock, verifyOwner: verifyPidLockOwner,
    stopOwner: stopVerifiedOwner, mkdir, open, rename, unlink, freePort,
    pause: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now,
    home: homedir(), xdgConfigHome: process.env.XDG_CONFIG_HOME, executable: process.execPath, capturedPath: process.env.PATH ?? '', ...overrides,
  };
  const drain = createServiceDrain({ readRunningPidLock: d.readOwner, stopVerifiedOwner: d.stopOwner, pause: d.pause });
  async function snapshot(): Promise<Snapshot> {
    const root = await d.resolveRoot(options.root);
    const target = serviceTarget({ platform: 'linux', home: d.home, xdgConfigHome: d.xdgConfigHome });
    if (target.platform !== 'linux') throw new Error('Invalid systemd target');
    return { root, target, expected: null, temporaryLeftovers: [] };
  }
  const registration = (s: Snapshot): Promise<Registration> => d.registration({ target: s.target, requestedRoot: s.root });
  function bytes(s: Snapshot, definition: Definition): Uint8Array {
    const rendered = renderDefinition({ target: s.target, ...definition });
    if (rendered.platform !== 'linux') throw new Error('Invalid systemd definition');
    return rendered.unit;
  }
  async function command(args: string[]): Promise<void> {
    const result = await d.run(args, 30_000);
    if (!result.ok || result.status !== 0) throw new Error(`systemctl ${args.join(' ')}: ${result.stderr || result.stdout || 'failed'}`);
  }
  async function observeUnit(): Promise<UnitObservation> {
    try {
      const result = await d.run(['show', '-p', 'LoadState', '-p', 'FragmentPath', '-p', 'MainPID', SYSTEMD_UNIT_NAME], 30_000);
      if (!result.ok || result.status !== 0) throw new Error(result.stderr || 'systemctl show failed');
      const fields = new Map<string, string>();
      for (const line of result.stdout.trimEnd().split('\n')) {
        const match = /^(LoadState|FragmentPath|MainPID)=(.*)$/.exec(line);
        if (!match?.[1] || match[2] === undefined || fields.has(match[1])) throw new Error('Malformed or duplicate systemctl show property');
        fields.set(match[1], match[2]);
      }
      const loadState = fields.get('LoadState');
      const fragmentPath = fields.get('FragmentPath');
      const pid = fields.get('MainPID');
      if (!loadState || !/^[a-z]+(?:-[a-z]+)*$/.test(loadState) || fragmentPath === undefined || pid === undefined) throw new Error('Incomplete systemctl show properties');
      const parsedPid = mainPid(pid);
      if (loadState === 'not-found') {
        if (parsedPid !== null || fragmentPath !== '') throw new Error('Inconsistent missing unit properties');
        return { kind: 'absent' };
      }
      return { kind: 'present', loadState, fragmentPath, mainPid: parsedPid };
    } catch (error) { return { kind: 'unknown', detail: detailOf(error) }; }
  }
  async function observeEnabled(): Promise<EnableObservation> {
    try {
      const r = await d.run(['is-enabled', SYSTEMD_UNIT_NAME], 30_000);
      const state = r.stdout.trim();
      if (r.ok && r.status === 0 && state === 'enabled') return { kind: 'enabled' };
      const successfulState = r.ok && r.status === 0 && /^(static|indirect|enabled-runtime|alias|generated|transient)$/.test(state);
      const disabledState = !r.ok && r.status === 1 && /^(disabled|linked|linked-runtime|masked|masked-runtime)$/.test(state);
      const missingState = !r.ok && (r.status === 1 || r.status === 4) && state === 'not-found';
      if (successfulState || disabledState || missingState) return { kind: 'not-enabled', state };
      throw new Error(r.stderr || 'Unknown systemctl is-enabled response');
    } catch (error) { return { kind: 'unknown', detail: detailOf(error) }; }
  }
  async function queryJobPid(): Promise<number | null> {
    const r = await d.run(['show', '-p', 'MainPID', '--value', SYSTEMD_UNIT_NAME], 30_000);
    if (!r.ok || r.status !== 0) throw new Error(r.stderr || 'MainPID query failed');
    return mainPid(r.stdout.trim());
  }
  async function checkExpected(s: Snapshot): Promise<void> {
    const current = await registration(s);
    if (s.expected === null && current.kind === 'absent') return;
    if (s.expected !== null && current.kind === 'ours' && Buffer.from(s.expected).equals(bytes(s, current.definition))) return;
    throw new Error(`Registration changed before mutation: ${registrationDetail(current)}`);
  }
  async function atomicWrite(s: Snapshot, content: Uint8Array): Promise<void> {
    await d.mkdir(dirname(s.target.unitPath), { recursive: true });
    const temporary = `${s.target.unitPath}.${randomUUID()}.tmp`;
    const file = await d.open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(content); await file.sync(); }
      finally { await file.close(); }
      await checkExpected(s);
      await d.rename(temporary, s.target.unitPath);
      s.expected = content;
    } catch (error) {
      try { await d.unlink(temporary); }
      catch (cleanupError) {
        if (cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT') throw error;
        s.temporaryLeftovers.push(temporary);
        throw new Error(`${detailOf(error)}; owned temporary cleanup failed at ${temporary}: ${detailOf(cleanupError)}`);
      }
      throw error;
    }
  }
  async function remove(s: Snapshot, scope: DrainScope): Promise<RemovalResult> {
    try {
      await checkExpected(s);
      if (s.expected !== null) {
        await command(['disable', SYSTEMD_UNIT_NAME]);
        await checkExpected(s);
        await d.unlink(s.target.unitPath);
        s.expected = null;
      }
    } catch (error) { return { kind: 'withdrawal-failed', detail: detailOf(error) }; }
    const result = await drain({ home: s.root, scope, queryJobPid });
    if (result.kind === 'drain-failed') return result;
    try {
      await command(['daemon-reload']);
      const reset = await d.run(['reset-failed', SYSTEMD_UNIT_NAME], 30_000);
      if (!(reset.ok && reset.status === 0) && !(!reset.ok && reset.status === 1)) {
        throw new Error(`systemctl reset-failed ${SYSTEMD_UNIT_NAME}: ${reset.stderr || reset.stdout || 'failed'}`);
      }
      await checkExpected(s);
      const observed = await observeUnit();
      if (observed.kind !== 'absent') throw new Error(observed.kind === 'unknown' ? observed.detail : 'Unit remains loaded');
      return { kind: 'unloaded' };
    } catch (error) { return { kind: 'unload-failed', detail: detailOf(error) }; }
  }
  async function outcome(s: Snapshot, kind: TransactionOutcome['kind'], detail: string): Promise<TransactionOutcome> {
    let retained: OwnerIdentity | null = null;
    const leftovers: string[] = s.temporaryLeftovers.map(path => `temporary file ${path}`);
    let unknown = false;
    try { retained = identity(await d.readOwner(s.root)); }
    catch (error) { unknown = true; leftovers.push(`owner unknown: ${detailOf(error)}`); }
    if (retained) leftovers.push(`retained pid ${retained.pid}`);
    try {
      const current = await registration(s);
      if (current.kind !== 'absent') leftovers.push(`unit ${s.target.unitPath}: ${current.kind}`);
      if (current.kind === 'unrecognized') unknown = true;
    } catch (error) { unknown = true; leftovers.push(`registration unknown: ${detailOf(error)}`); }
    const unit = await observeUnit();
    if (unit.kind !== 'absent') leftovers.push(`manager ${unit.kind}${unit.kind === 'unknown' ? `: ${unit.detail}` : `: ${unit.loadState}`}`);
    const enabled = await observeEnabled();
    if (enabled.kind !== 'not-enabled') leftovers.push(`enable state ${enabled.kind}${enabled.kind === 'unknown' ? `: ${enabled.detail}` : ''}`);
    unknown ||= unit.kind === 'unknown' || enabled.kind === 'unknown';
    if (unknown && (kind === 'install_rolled_back' || kind === 'uninstall_rolled_back' || kind === 'installed' || kind === 'already-installed' || kind === 'uninstalled' || kind === 'not-installed')) kind = (kind.startsWith('uninstall') || kind === 'not-installed') ? 'uninstall_incomplete' : 'install_incomplete';
    if (kind.endsWith('_incomplete')) detail += `; observed enable state ${enabled.kind === 'not-enabled' ? enabled.state : enabled.kind}`;
    return { kind, detail, retained, leftovers };
  }
  async function restore(s: Snapshot, content: Uint8Array | null): Promise<void> {
    await checkExpected(s);
    if (content !== null) {
      await atomicWrite(s, content);
      await command(['enable', SYSTEMD_UNIT_NAME]);
      await checkExpected(s);
      const enabled = await observeEnabled();
      if (enabled.kind !== 'enabled') throw new Error('Restoration enable state was not confirmed');
    }
  }
  async function rollbackResult(s: Snapshot, before: OwnerIdentity | null, detail: string): Promise<TransactionOutcome> {
    const result = await outcome(s, 'install_rolled_back', detail);
    if (!sameOwner(before, result.retained)) result.kind = 'install_incomplete';
    return result;
  }
  async function ready(s: Snapshot, port: number, wait: boolean, stale?: StaleOwner): Promise<HostEndpoint> {
    const deadline = d.now() + (wait ? 25_000 : 0);
    do {
      const owner = await d.readOwner(s.root);
      if (owner?.listen && !isStaleOwner(owner, stale)) {
        await d.verifyOwner(s.root, owner);
        if (owner.listen !== `127.0.0.1:${port}`) throw new Error(`Daemon PID ${owner.pid} already runs at ${owner.listen}, not requested port ${port}.`);
        return { pid: owner.pid, startedAt: owner.startedAt, listen: owner.listen, port };
      }
      if (d.now() >= deadline) break;
      await d.pause(50);
    } while (d.now() < deadline);
    if (stale) {
      // Nothing replaced the skipped owner; its earlier verification failure may have been transient, so try it once more.
      const owner = await d.readOwner(s.root);
      if (owner?.listen && isStaleOwner(owner, stale)) {
        await d.verifyOwner(s.root, owner);
        if (owner.listen !== `127.0.0.1:${port}`) throw new Error(`Daemon PID ${owner.pid} already runs at ${owner.listen}, not requested port ${port}.`);
        return { pid: owner.pid, startedAt: owner.startedAt, listen: owner.listen, port };
      }
      throw new Error(`Daemon PID ${stale.pid} could not be verified and no replacement became ready; readiness timed out.`);
    }
    throw new Error('Daemon readiness timed out');
  }
  return {
    async install(input: { port?: number } = {}): Promise<TransactionOutcome> {
      let s: Snapshot;
      try { s = await snapshot(); }
      catch (error) { return { kind: 'install_refused', detail: detailOf(error), retained: null, leftovers: [] }; }
      let before: OwnerIdentity | null = null;
      let previous: Uint8Array | null = null;
      let desired: Uint8Array;
      let port: number;
      try {
        const manager = await d.run(['is-system-running'], 30_000);
        const state = manager.stdout.trim();
        if (!(manager.ok && manager.status === 0 && state === 'running') && !(manager.status === 1 && state === 'degraded') && !(manager.ok && manager.status === 0 && state === 'degraded')) throw new Error(manager.stderr || `User manager unavailable: ${state}`);
        const distribution = await d.distribution();
        if (distribution.kind !== 'global-npm' && distribution.kind !== 'bundled') throw new Error('Distribution cannot install a service');
        const current = await registration(s);
        if (current.kind !== 'ours' && current.kind !== 'absent') throw new Error(registrationDetail(current));
        previous = current.kind === 'ours' ? bytes(s, current.definition) : null;
        s.expected = previous;
        const owner = await d.readOwner(s.root);
        before = identity(owner);
        if (owner) {
          await d.verifyOwner(s.root, owner);
          const match = /^127\.0\.0\.1:(\d+)$/.exec(owner.listen ?? '');
          if (!match) throw new Error('Running owner has no published port');
          port = Number(match[1]);
        } else port = input.port ?? (current.kind === 'ours' ? current.definition.port : await d.freePort());
        desired = bytes(s, { root: s.root, port, distribution: { kind: distribution.kind === 'bundled' ? 'desktop' : 'npm', executable: d.executable, entry: distribution.cliPath }, capturedPath: d.capturedPath });
        const unit = await observeUnit();
        const enabled = await observeEnabled();
        if (unit.kind === 'unknown' || enabled.kind === 'unknown') throw new Error(unit.kind === 'unknown' ? unit.detail : 'Enable state is unknown');
        const identical = previous !== null && Buffer.from(previous).equals(desired);
        if (identical && enabled.kind === 'enabled' && unit.kind === 'present' && unit.loadState === 'loaded' && unit.fragmentPath === s.target.unitPath) return outcome(s, 'already-installed', 'Already installed');
        if (!identical && unit.kind === 'present' && unit.mainPid !== null) throw new Error('Run vonvon daemon stop before replacing the service');
      } catch (error) { return outcome(s, 'install_refused', detailOf(error)); }
      let transactionOwnsRegistration = false;
      try {
        await checkExpected(s);
        if (s.expected === null || !Buffer.from(s.expected).equals(desired)) await atomicWrite(s, desired);
        transactionOwnsRegistration = true;
        for (const name of ['service.log', 'service.err.log']) { const log = await d.open(join(s.root, name), 'a', 0o600); await log.close(); }
        await command(['daemon-reload']);
        await command(['enable', '--now', SYSTEMD_UNIT_NAME]);
        const unit = await observeUnit();
        const enabled = await observeEnabled();
        if (unit.kind !== 'present' || unit.loadState !== 'loaded' || unit.fragmentPath !== s.target.unitPath || enabled.kind !== 'enabled') throw new Error('Manager did not confirm installed unit');
        await ready(s, port, before === null);
        return outcome(s, 'installed', 'Installed');
      } catch (error) {
        const reason = detailOf(error);
        if (!transactionOwnsRegistration) {
          try { await checkExpected(s); }
          catch (failure) { return outcome(s, 'install_incomplete', `${reason}; ${detailOf(failure)}`); }
          const unit = await observeUnit();
          const enabled = await observeEnabled();
          if (unit.kind !== 'absent' || s.temporaryLeftovers.length > 0 || (previous !== null && enabled.kind !== 'enabled')) return outcome(s, 'install_incomplete', reason);
          return rollbackResult(s, before, reason);
        }
        const kept = s.expected;
        const result = await remove(s, { kind: 'job-only', context: 'install-rollback' });
        if (result.kind === 'withdrawal-failed') return outcome(s, 'install_incomplete', `${reason}; ${result.detail}`);
        if (result.kind === 'drain-failed' && result.reason === 'stop_unconfirmed') return outcome(s, 'install_incomplete', `${reason}; ${result.reason}: ${result.detail}; no unload issued; neither definition was restored`);
        const detail = `${reason}; ${result.kind === 'drain-failed' ? `${result.reason}: ${result.detail}; previous definition was not restored` : result.kind === 'unload-failed' ? result.detail : 'transaction job unloaded'}`;
        try { await restore(s, result.kind === 'drain-failed' ? kept : previous); }
        catch (failure) { return outcome(s, 'install_incomplete', `${detail}; restore failed: ${detailOf(failure)}`); }
        if (result.kind !== 'unloaded') return outcome(s, 'install_incomplete', detail);
        return rollbackResult(s, before, detail);
      }
    },
    async uninstall(): Promise<TransactionOutcome> {
      let s: Snapshot;
      try { s = await snapshot(); }
      catch (error) { return { kind: 'uninstall_refused', detail: detailOf(error), retained: null, leftovers: [] }; }
      const current = await registration(s);
      if (current.kind !== 'ours' && current.kind !== 'absent') return outcome(s, 'uninstall_refused', registrationDetail(current));
      const unit = await observeUnit();
      if (unit.kind === 'unknown') return outcome(s, 'uninstall_incomplete', unit.detail);
      if (current.kind === 'absent' && unit.kind === 'absent') return outcome(s, 'not-installed', 'Not installed');
      const kept = current.kind === 'ours' ? bytes(s, current.definition) : null;
      s.expected = kept;
      const scope: DrainScope = current.kind === 'ours' ? { kind: 'all-owners' } : { kind: 'job-only', context: 'uninstall-resumed' };
      const result = await remove(s, scope);
      if (result.kind === 'withdrawal-failed') return outcome(s, 'uninstall_incomplete', result.detail);
      if (result.kind === 'drain-failed' && result.reason === 'stop_unconfirmed') return outcome(s, 'uninstall_incomplete', `${result.reason}: ${result.detail}; no unload issued`);
      if (result.kind !== 'unloaded') {
        const detail = result.kind === 'drain-failed' ? `${result.reason}: ${result.detail}` : result.detail;
        if (kept === null) return outcome(s, 'uninstall_incomplete', detail);
        try { await restore(s, kept); }
        catch (error) { return outcome(s, 'uninstall_incomplete', `${detail}; restore failed: ${detailOf(error)}`); }
        return outcome(s, 'uninstall_rolled_back', detail);
      }
      if (scope.kind === 'all-owners') {
        const final = await drain({ home: s.root, scope, queryJobPid: async () => null });
        if (final.kind === 'drain-failed') {
          const detail = `${final.reason}: ${final.detail}; unit already unloaded`;
          if (final.reason === 'stop_unconfirmed') return outcome(s, 'uninstall_incomplete', detail);
          try { await restore(s, kept); }
          catch (error) { return outcome(s, 'uninstall_incomplete', `${detail}; restore failed: ${detailOf(error)}`); }
          return outcome(s, 'uninstall_rolled_back', detail);
        }
      }
      return outcome(s, 'uninstalled', 'Uninstalled');
    },
    async start(input: { port?: number; staleOwner?: StaleOwner } = {}): Promise<HostEndpoint> {
      const s = await snapshot();
      const current = await registration(s);
      if (current.kind !== 'ours') throw new Error(registrationDetail(current));
      const port = current.definition.port;
      if (input.port !== undefined && input.port !== port) throw new Error(`Service uses port ${port}, not requested port ${input.port}.`);
      const owner = await d.readOwner(s.root);
      if (owner && !isStaleOwner(owner, input.staleOwner)) return ready(s, port, true);
      await command(['start', SYSTEMD_UNIT_NAME]);
      return ready(s, port, true, input.staleOwner);
    },
    async status() {
      const s = await snapshot();
      const current = await registration(s);
      const manager = await observeUnit();
      const enabled = await observeEnabled();
      const owner = await d.readOwner(s.root);
      let running = false;
      if (owner?.listen) { await d.verifyOwner(s.root, owner); running = true; }
      return { registration: current, manager, enabled, owner: identity(owner), running };
    },
  };
}
