import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { HostEndpoint } from '../host/discovery';
import { readRunningPidLock } from '../server/pid-lock';
import { stopVerifiedOwner, verifyPidLockOwner } from '../server/owner-verification';
import { renderDefinition, type Definition } from './definitions';
import { runtimeDistribution } from './distribution';
import { createServiceDrain, type DrainFailure, type DrainScope, type OwnerIdentity } from './drain';
import { LAUNCHD_LABEL, resolveServiceRoot, serviceTarget, type CanonicalRoot } from './identity';
import { readRegistration, type Registration } from './registration';

type CommandResult = { ok: boolean; stdout: string; stderr: string };
type JobObservation =
  | { kind: 'absent' }
  | { kind: 'loaded'; pid: number | null; raw: string }
  | { kind: 'unknown'; detail: string };
type BarrierResult =
  | { kind: 'unloaded'; retained: OwnerIdentity | null }
  | DrainFailure
  | { kind: 'unload-unknown'; error: string; jobPresent: boolean | 'unknown' };
type BarrierRequest =
  | { scope: Extract<DrainScope, { kind: 'all-owners' }>; context: 'uninstall' | 'install-replacement' }
  | { scope: { kind: 'job-only'; context: 'uninstall-resumed' }; context: 'uninstall-resumed' }
  | { scope: { kind: 'job-only'; context: 'install-rollback' }; context: 'install-rollback' };
type Snapshot = {
  root: CanonicalRoot;
  target: { platform: 'darwin'; plistPath: string };
  expected: Uint8Array | null;
  kept: Uint8Array | null;
  temporaryLeftovers: string[];
};
export type LaunchdTransactionOutcome = {
  kind: 'installed' | 'already-installed' | 'uninstalled' | 'not-installed'
    | 'install_refused' | 'install_rolled_back' | 'install_incomplete'
    | 'uninstall_refused' | 'uninstall_rolled_back' | 'uninstall_incomplete';
  detail: string;
  retained: OwnerIdentity | null;
  leftovers: readonly string[];
};
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
  uid: number;
  executable: string;
  capturedPath: string;
};

function runLaunchctl(args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: error.message }); });
    child.once('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !expired, stdout, stderr: expired ? 'launchctl client timed out' : stderr }); });
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
const sameOwner = (a: OwnerIdentity | null, b: OwnerIdentity | null): boolean => a === null ? b === null : b !== null && a.pid === b.pid && a.startedAt === b.startedAt;
const registrationDetail = (registration: Registration): string => registration.kind === 'other-root'
  ? `Registration belongs to ${registration.recordedRoot}`
  : registration.kind === 'unrecognized' ? `Unrecognized registration ${registration.location}: ${registration.reason}` : `Registration is ${registration.kind}`;
const identity = (owner: OwnerIdentity | null): OwnerIdentity | null => owner === null ? null : { pid: owner.pid, startedAt: owner.startedAt };

export function createLaunchdService(options: { root: string }, overrides: Partial<Dependencies> = {}) {
  const d: Dependencies = {
    run: runLaunchctl, resolveRoot: resolveServiceRoot, registration: readRegistration,
    distribution: runtimeDistribution, readOwner: readRunningPidLock, verifyOwner: verifyPidLockOwner,
    stopOwner: stopVerifiedOwner, mkdir, open, rename, unlink, freePort,
    pause: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now,
    home: homedir(), uid: userInfo().uid, executable: process.execPath, capturedPath: process.env.PATH ?? '',
    ...overrides,
  };
  const domain = `gui/${d.uid}`;
  const job = `${domain}/${LAUNCHD_LABEL}`;
  const drain = createServiceDrain({ readRunningPidLock: d.readOwner, stopVerifiedOwner: d.stopOwner, pause: d.pause });

  async function snapshot(): Promise<Snapshot> {
    const root = await d.resolveRoot(options.root);
    const target = serviceTarget({ platform: 'darwin', home: d.home });
    if (target.platform !== 'darwin') throw new Error('Invalid launchd target');
    return { root, target, expected: null, kept: null, temporaryLeftovers: [] };
  }
  const registration = (s: Snapshot): Promise<Registration> => d.registration({ target: s.target, requestedRoot: s.root });
  function bytes(s: Snapshot, definition: Definition): Uint8Array {
    const serialized = renderDefinition({ target: s.target, ...definition });
    if (serialized.platform !== 'darwin') throw new Error('Invalid launchd definition');
    return serialized.plist;
  }
  async function observeJob(): Promise<JobObservation> {
    try {
      const result = await d.run(['print', job], 30_000);
      const raw = result.stdout;
      if (!result.ok) {
        if (/Could not find service|service .*not found/i.test(result.stderr)) return { kind: 'absent' };
        return { kind: 'unknown', detail: result.stderr || 'launchctl print failed' };
      }
      const lines = raw.trimEnd().split('\n');
      if (lines.shift() !== `${job} = {` || lines.pop() !== '}') return { kind: 'unknown', detail: 'Unrecognized launchctl print output' };
      let depth = 1;
      let state: string | null = null;
      let pid: number | null = null;
      let nestedPid = false;
      for (const line of lines) {
        if (line.trim() === '') continue;
        const field = /^(\t+)([^\t].*)$/.exec(line);
        if (!field) return { kind: 'unknown', detail: 'Malformed launchctl job record' };
        const indentation = field[1]?.length;
        const value = field[2] ?? '';
        if (value === '}') {
          if (depth <= 1 || indentation !== depth - 1) return { kind: 'unknown', detail: 'Malformed launchctl job record' };
          depth--;
          continue;
        }
        if (indentation !== depth) return { kind: 'unknown', detail: 'Malformed launchctl job field indentation' };
        if (/^[^{}]+ = \{$/.test(value)) {
          if (depth === 1 && /^(pid|state)\b/.test(value)) return { kind: 'unknown', detail: 'Invalid launchctl job field' };
          depth++;
          continue;
        }
        if (/[{}]/.test(value)) return { kind: 'unknown', detail: 'Malformed launchctl job field' };
        if (depth !== 1) { if (/^pid\b/.test(value)) nestedPid = true; continue; }
        if (/^state\b/.test(value)) {
          const match = /^state = ([a-z]+(?: [a-z]+)*)$/.exec(value);
          if (state !== null || !match) return { kind: 'unknown', detail: 'Invalid launchctl job state' };
          state = match[1] ?? null;
        } else if (/^pid\b/.test(value)) {
          const match = /^pid = ([1-9][0-9]*)$/.exec(value);
          const parsed = Number(match?.[1]);
          if (pid !== null || !match || !Number.isSafeInteger(parsed)) return { kind: 'unknown', detail: 'Invalid launchctl job pid' };
          pid = parsed;
        }
      }
      if (depth !== 1 || state === null || (nestedPid && pid === null)) return { kind: 'unknown', detail: 'Ambiguous launchctl job record' };
      return { kind: 'loaded', pid, raw };
    } catch (error) { return { kind: 'unknown', detail: detailOf(error) }; }
  }
  async function atomicWrite(s: Snapshot, content: Uint8Array): Promise<void> {
    await d.mkdir(dirname(s.target.plistPath), { recursive: true });
    const temporary = `${s.target.plistPath}.${randomUUID()}.tmp`;
    const file = await d.open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(content); await file.sync(); }
      finally { await file.close(); }
      await d.rename(temporary, s.target.plistPath);
    } catch (error) {
      try { await d.unlink(temporary); }
      catch (cleanupError) {
        s.temporaryLeftovers.push(temporary);
        throw new Error(`${detailOf(error)}; temporary file cleanup failed at ${temporary}: ${detailOf(cleanupError)}`);
      }
      throw error;
    }
  }
  async function checkExpected(s: Snapshot): Promise<void> {
    const current = await registration(s);
    if (s.expected === null && current.kind === 'absent') return;
    if (s.expected !== null && current.kind === 'ours' && Buffer.from(s.expected).equals(bytes(s, current.definition))) return;
    throw new Error(`Registration changed before mutation: ${current.kind}`);
  }
  async function unloadBarrier(request: BarrierRequest, s: Snapshot): Promise<BarrierResult> {
    await checkExpected(s);
    s.kept = s.expected;
    if (s.expected !== null) await d.unlink(s.target.plistPath);
    s.expected = null;
    const result = await drain({ home: s.root, scope: request.scope, queryJobPid: async () => {
      const observation = await observeJob();
      if (observation.kind === 'unknown') throw new Error(observation.detail);
      return observation.kind === 'loaded' ? observation.pid : null;
    } });
    if (result.kind === 'drain-failed') return result;
    let command: CommandResult;
    try { command = await d.run(['bootout', job], 30_000); }
    catch (error) { command = { ok: false, stdout: '', stderr: detailOf(error) }; }
    const after = await observeJob();
    const jobPresent = after.kind === 'unknown' ? 'unknown' : after.kind === 'loaded';
    if (!command.ok || jobPresent !== false) return { kind: 'unload-unknown', error: command.stderr || (after.kind === 'unknown' ? after.detail : 'Job remains loaded'), jobPresent };
    return { kind: 'unloaded', retained: result.retained };
  }
  async function outcome(s: Snapshot, kind: LaunchdTransactionOutcome['kind'], detail: string): Promise<LaunchdTransactionOutcome> {
    let retained: OwnerIdentity | null = null;
    const leftovers = s.temporaryLeftovers.map(path => `temporary file ${path}`);
    try { retained = identity(await d.readOwner(s.root)); }
    catch (error) { leftovers.push(`owner unknown: ${detailOf(error)}`); }
    if (retained) leftovers.push(`retained pid ${retained.pid}`);
    const current = await registration(s);
    if (current.kind !== 'absent') leftovers.push(`plist ${s.target.plistPath}: ${current.kind}`);
    return { kind, detail, retained, leftovers };
  }
  async function restore(s: Snapshot, content: Uint8Array | null): Promise<void> {
    await checkExpected(s);
    if (content !== null) await atomicWrite(s, content);
    else if (s.expected !== null) await d.unlink(s.target.plistPath);
    s.expected = content;
  }
  async function rollbackResult(s: Snapshot, before: OwnerIdentity | null, reason: string): Promise<LaunchdTransactionOutcome> {
    const result = await outcome(s, 'install_incomplete', reason);
    if (s.temporaryLeftovers.length === 0 && sameOwner(before, result.retained) && !result.leftovers.some(item => item.startsWith('owner unknown'))) result.kind = 'install_rolled_back';
    return result;
  }
  async function barrierFailure(s: Snapshot, result: Exclude<BarrierResult, { kind: 'unloaded' }>, mode: 'uninstall' | 'replacement' | 'rollback', before: OwnerIdentity | null): Promise<LaunchdTransactionOutcome> {
    const kind = mode === 'uninstall' ? 'uninstall_incomplete' : 'install_incomplete';
    if (result.kind === 'unload-unknown') {
      const failed = await outcome(s, kind, `${result.error}; jobPresent=${result.jobPresent}`);
      return { ...failed, leftovers: [...failed.leftovers, `jobPresent=${result.jobPresent}`] };
    }
    const reason = `${result.reason}: ${result.detail}; job ${job} was not unloaded`;
    if (result.reason === 'stop_unconfirmed') return outcome(s, kind, `${reason}${mode === 'rollback' ? '; neither the new nor the previous definition was restored' : ''}`);
    if (s.kept === null) return outcome(s, kind, reason);
    try { await restore(s, s.kept); }
    catch (error) { return outcome(s, kind, `${reason}; restore failed: ${detailOf(error)}`); }
    if (mode === 'replacement') return rollbackResult(s, before, reason);
    return outcome(s, mode === 'uninstall' ? 'uninstall_rolled_back' : 'install_incomplete', `${reason}${mode === 'rollback' ? '; previous definition was not restored' : ''}`);
  }
  async function ready(s: Snapshot, port: number, wait: boolean): Promise<HostEndpoint> {
    const deadline = d.now() + (wait ? 25_000 : 0);
    do {
      const owner = await d.readOwner(s.root);
      if (owner?.listen) {
        await d.verifyOwner(s.root, owner);
        if (owner.listen !== `127.0.0.1:${port}`) throw new Error(`Daemon PID ${owner.pid} already runs at ${owner.listen}, not requested port ${port}.`);
        return { pid: owner.pid, startedAt: owner.startedAt, listen: owner.listen, port };
      }
      if (d.now() >= deadline) break;
      await d.pause(50);
    } while (d.now() < deadline);
    throw new Error('Daemon readiness timed out');
  }

  return {
    async install(input: { port?: number } = {}): Promise<LaunchdTransactionOutcome> {
      const s = await snapshot();
      let before: OwnerIdentity | null = null;
      let previous: Uint8Array | null = null;
      let desired: Uint8Array;
      let port: number;
      let initial: JobObservation;
      try {
        const domainResult = await d.run(['print', domain], 30_000);
        if (!domainResult.ok) throw new Error(domainResult.stderr || 'GUI domain unavailable');
        const distribution = await d.distribution();
        if (distribution.kind !== 'bundled' && distribution.kind !== 'global-npm') throw new Error('Distribution cannot install a service');
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
        initial = await observeJob();
        if (initial.kind === 'loaded' && previous === null) throw new Error('Interrupted uninstall; run vonvon service uninstall first');
        if (initial.kind === 'loaded' && previous !== null && Buffer.from(previous).equals(desired)) return outcome(s, 'already-installed', 'Already installed');
        if (initial.kind === 'loaded' && (owner !== null || initial.pid !== null)) throw new Error('Run vonvon daemon stop before replacing the service');
      } catch (error) { return outcome(s, 'install_refused', detailOf(error)); }
      if (initial.kind === 'loaded') {
        try {
          const barrier = await unloadBarrier({ scope: { kind: 'all-owners' }, context: 'install-replacement' }, s);
          if (barrier.kind !== 'unloaded') return barrierFailure(s, barrier, 'replacement', before);
        } catch (error) { return outcome(s, 'install_incomplete', detailOf(error)); }
      }
      let loaded = false;
      try {
        await checkExpected(s);
        if (s.expected === null || !Buffer.from(s.expected).equals(desired)) { await atomicWrite(s, desired); s.expected = desired; }
        for (const name of ['service.log', 'service.err.log']) { const log = await d.open(join(s.root, name), 'a', 0o600); await log.close(); }
        const bootstrap = await d.run(['bootstrap', domain, s.target.plistPath], 30_000);
        if (!bootstrap.ok) throw new Error(bootstrap.stderr || 'Bootstrap failed');
        loaded = true;
        const manager = await observeJob();
        if (manager.kind !== 'loaded') throw new Error('Manager did not confirm the loaded job');
        await ready(s, port, before === null);
        return outcome(s, 'installed', 'Installed');
      } catch (error) {
        const reason = detailOf(error);
        if (loaded) {
          try {
            const barrier = await unloadBarrier({ scope: { kind: 'job-only', context: 'install-rollback' }, context: 'install-rollback' }, s);
            if (barrier.kind !== 'unloaded') return barrierFailure(s, barrier, 'rollback', before);
            await restore(s, previous);
            return rollbackResult(s, before, `${reason}; previous job remains unloaded until daemon start or login`);
          } catch (failure) { return outcome(s, 'install_incomplete', `${reason}; rollback failed: ${detailOf(failure)}`); }
        }
        try { await restore(s, previous); }
        catch (failure) { return outcome(s, 'install_incomplete', `${reason}; restore failed: ${detailOf(failure)}`); }
        const manager = await observeJob();
        if (manager.kind !== 'absent') {
          const result = await outcome(s, 'install_incomplete', reason);
          return { ...result, leftovers: [...result.leftovers, `job ${job}: ${manager.kind}`] };
        }
        return rollbackResult(s, before, reason);
      }
    },
    async uninstall(): Promise<LaunchdTransactionOutcome> {
      const s = await snapshot();
      const current = await registration(s);
      if (current.kind !== 'ours' && current.kind !== 'absent') return outcome(s, 'uninstall_refused', registrationDetail(current));
      const manager = await observeJob();
      if (manager.kind === 'unknown') return outcome(s, 'uninstall_incomplete', manager.detail);
      if (current.kind === 'absent' && manager.kind === 'absent') return outcome(s, 'not-installed', 'Not installed');
      s.expected = current.kind === 'ours' ? bytes(s, current.definition) : null;
      try {
        const request: BarrierRequest = current.kind === 'ours'
          ? { scope: { kind: 'all-owners' }, context: 'uninstall' }
          : { scope: { kind: 'job-only', context: 'uninstall-resumed' }, context: 'uninstall-resumed' };
        const barrier = await unloadBarrier(request, s);
        if (barrier.kind !== 'unloaded') return barrierFailure(s, barrier, 'uninstall', null);
        if (current.kind === 'ours') {
          const final = await drain({ home: s.root, scope: { kind: 'all-owners' }, queryJobPid: async () => null });
          if (final.kind === 'drain-failed') return outcome(s, 'uninstall_incomplete', `${final.reason}: ${final.detail}`);
        }
        return outcome(s, 'uninstalled', 'Uninstalled');
      } catch (error) { return outcome(s, 'uninstall_incomplete', detailOf(error)); }
    },
    async start(input: { port?: number } = {}): Promise<HostEndpoint> {
      const s = await snapshot();
      const current = await registration(s);
      if (current.kind !== 'ours') throw new Error(registrationDetail(current));
      const port = current.definition.port;
      if (input.port && input.port !== port) throw new Error(`Service uses port ${port}, not requested port ${input.port}.`);
      const owner = await d.readOwner(s.root);
      if (owner) return ready(s, port, true);
      const manager = await observeJob();
      if (manager.kind === 'unknown') throw new Error(manager.detail);
      const command = await d.run(manager.kind === 'absent' ? ['bootstrap', domain, s.target.plistPath] : ['kickstart', job], 30_000);
      if (!command.ok) throw new Error(command.stderr || 'Service start failed');
      return ready(s, port, true);
    },
    async status() {
      const s = await snapshot();
      const current = await registration(s);
      const manager = await observeJob();
      const owner = await d.readOwner(s.root);
      let running = false;
      if (owner?.listen) { await d.verifyOwner(s.root, owner); running = true; }
      return { registration: current, manager, owner: identity(owner), running };
    },
  };
}
