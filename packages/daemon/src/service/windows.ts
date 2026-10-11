import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { win32 } from 'node:path';
import type { HostEndpoint } from '../host/discovery';
import { readRunningPidLock } from '../server/pid-lock';
import { stopVerifiedOwner, verifyPidLockOwner } from '../server/owner-verification';
import { renderDefinition, type Definition, type SerializedDefinition } from './definitions';
import { runtimeDistribution } from './distribution';
import { createServiceDrain, type DrainFailure, type DrainScope, type OwnerIdentity } from './drain';
import { resolveServiceRoot, serviceTarget, WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE, type CanonicalRoot } from './identity';
import type { LaunchdTransactionOutcome } from './launchd';
import { readRegistration, type Registration } from './registration';
import { readVonvonRunValue } from './win-startup';

type WindowsBytes = Extract<SerializedDefinition, { platform: 'win32' }>;
type WindowsTarget = { platform: 'win32'; vbsPath: string; cmdPath: string };
type Files = { cmd: Uint8Array | null; vbs: Uint8Array | null };
type Snapshot = { root: CanonicalRoot; target: WindowsTarget; files: Files; runValue: string | null; temporaryLeftovers: string[] };
type Removal = { kind: 'unloaded' } | DrainFailure | { kind: 'withdrawal-failed' | 'unload-failed'; detail: string };
type CommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type Dependencies = {
  run: (args: string[]) => CommandResult;
  readRun: typeof readVonvonRunValue;
  launch: (vbsPath: string) => Promise<void>;
  resolveRoot: typeof resolveServiceRoot;
  registration: typeof readRegistration;
  distribution: typeof runtimeDistribution;
  readOwner: typeof readRunningPidLock;
  verifyOwner: typeof verifyPidLockOwner;
  stopOwner: typeof stopVerifiedOwner;
  lstat: typeof lstat;
  readFile: typeof readFile;
  mkdir: typeof mkdir;
  open: typeof open;
  rename: typeof rename;
  unlink: typeof unlink;
  freePort: () => Promise<number>;
  pause: (milliseconds: number) => Promise<void>;
  now: () => number;
  executable: string;
  capturedPath: string;
};

function launch(vbsPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wscript.exe', ['//B', vbsPath], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer): void => { output += chunk.toString().slice(0, 64 * 1024 - output.length); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`wscript.exe launcher timed out: ${output}`)); }, 25_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`wscript.exe exited with ${code}: ${output}`));
    });
    child.unref();
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
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean => a === null ? b === null : b !== null && Buffer.from(a).equals(b);
const identity = (owner: OwnerIdentity | null): OwnerIdentity | null => owner === null ? null : { pid: owner.pid, startedAt: owner.startedAt };
const sameOwner = (a: OwnerIdentity | null, b: OwnerIdentity | null): boolean => a === null ? b === null : b !== null && a.pid === b.pid && a.startedAt === b.startedAt;
const registrationDetail = (r: Registration): string => r.kind === 'other-root' ? `Registration belongs to ${r.recordedRoot}` : r.kind === 'unrecognized' ? `Unrecognized registration ${r.location}: ${r.reason}` : `Registration is ${r.kind}`;

export function createWindowsService(options: { root: string }, overrides: Partial<Dependencies> = {}) {
  const d: Dependencies = {
    run: args => spawnSync('reg.exe', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true }),
    readRun: readVonvonRunValue, launch, resolveRoot: resolveServiceRoot, registration: readRegistration,
    distribution: runtimeDistribution, readOwner: readRunningPidLock, verifyOwner: verifyPidLockOwner,
    stopOwner: stopVerifiedOwner, lstat, readFile, mkdir, open, rename, unlink, freePort,
    pause: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now,
    executable: process.execPath, capturedPath: process.env.PATH ?? '', ...overrides,
  };
  const drain = createServiceDrain({ readRunningPidLock: d.readOwner, stopVerifiedOwner: d.stopOwner, pause: d.pause });
  function runValue(): string | null {
    const value = d.readRun();
    if (value.kind === 'absent') return null;
    if (value.kind === 'unavailable') throw new Error(value.reason);
    if (value.type !== 'REG_SZ') throw new Error('Windows Run value must be REG_SZ');
    return value.value;
  }
  async function fileBytes(path: string): Promise<Uint8Array | null> {
    try {
      const before = await d.lstat(path);
      if (!before.isFile() || before.size > 1024 * 1024) throw new Error(`Launcher must be a regular file under 1 MiB: ${path}`);
      const bytes = await d.readFile(path);
      const after = await d.lstat(path);
      if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || bytes.length > 1024 * 1024) throw new Error(`Launcher changed during read: ${path}`);
      return bytes;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async function snapshot(): Promise<Snapshot> {
    const root = await d.resolveRoot(options.root);
    const target = serviceTarget({ platform: 'win32', root });
    if (target.platform !== 'win32') throw new Error('Invalid Windows target');
    return { root, target, files: { cmd: null, vbs: null }, runValue: null, temporaryLeftovers: [] };
  }
  const registration = (s: Snapshot): Promise<Registration> => d.registration({ target: s.target, requestedRoot: s.root, windowsRun: d.readRun() });
  function bytes(s: Snapshot, definition: Definition): WindowsBytes {
    const rendered = renderDefinition({ target: s.target, ...definition });
    if (rendered.platform !== 'win32') throw new Error('Invalid Windows definition');
    return rendered;
  }
  async function capture(s: Snapshot): Promise<void> {
    s.runValue = runValue();
    s.files = { cmd: await fileBytes(s.target.cmdPath), vbs: await fileBytes(s.target.vbsPath) };
  }
  async function checkExpected(s: Snapshot): Promise<void> {
    if (runValue() !== s.runValue) throw new Error('Windows Run registration changed before mutation');
    for (const name of ['cmd', 'vbs'] as const) {
      if (!sameBytes(await fileBytes(s.target[`${name}Path`]), s.files[name])) throw new Error(`Launcher changed before mutation: ${s.target[`${name}Path`]}`);
    }
  }
  function command(args: string[]): void {
    const result = d.run(args);
    if (result.error || result.status !== 0) throw new Error(`reg.exe ${args[0]}: ${result.error?.message || result.stderr || result.stdout || 'failed'}`);
  }
  async function setRun(s: Snapshot, value: string | null): Promise<void> {
    await checkExpected(s);
    if (value === s.runValue) return;
    const previous = s.runValue;
    try {
      if (value === null) command(['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f']);
      else command(['add', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/t', 'REG_SZ', '/d', value, '/f']);
    } finally {
      const observed = runValue();
      if (observed !== previous && observed !== value) throw new Error('Windows Run registration changed during mutation');
      s.runValue = observed;
    }
    if (s.runValue !== value) throw new Error('Windows Run mutation was not confirmed');
  }
  async function write(s: Snapshot, name: 'cmd' | 'vbs', content: Uint8Array | null): Promise<void> {
    await checkExpected(s);
    if (sameBytes(s.files[name], content)) return;
    const path = s.target[`${name}Path`];
    if (content === null) { await d.unlink(path); s.files[name] = null; return; }
    await d.mkdir(win32.dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await d.open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(content); await file.sync(); }
      finally { await file.close(); }
      await checkExpected(s);
      await d.rename(temporary, path);
      s.files[name] = content;
    } catch (error) {
      try { await d.unlink(temporary); }
      catch (cleanupError) { if (!missing(cleanupError)) s.temporaryLeftovers.push(temporary); }
      throw error;
    }
  }
  async function restore(s: Snapshot, files: Files, value: string | null): Promise<void> {
    await write(s, 'cmd', files.cmd);
    await write(s, 'vbs', files.vbs);
    await setRun(s, value);
    await checkExpected(s);
  }
  async function remove(s: Snapshot, scope: DrainScope): Promise<Removal> {
    try { await setRun(s, null); }
    catch (error) { return { kind: 'withdrawal-failed', detail: detailOf(error) }; }
    const result = await drain({ home: s.root, scope, queryJobPid: async () => null });
    if (result.kind === 'drain-failed') return result;
    try {
      await write(s, 'cmd', null);
      await write(s, 'vbs', null);
      await checkExpected(s);
      return { kind: 'unloaded' };
    } catch (error) { return { kind: 'unload-failed', detail: detailOf(error) }; }
  }
  async function outcome(s: Snapshot, kind: LaunchdTransactionOutcome['kind'], detail: string): Promise<LaunchdTransactionOutcome> {
    let retained: OwnerIdentity | null = null;
    let unknown = false;
    const leftovers = s.temporaryLeftovers.map(path => `temporary file ${path}`);
    try { retained = identity(await d.readOwner(s.root)); }
    catch (error) { unknown = true; leftovers.push(`owner unknown: ${detailOf(error)}`); }
    if (retained) leftovers.push(`retained pid ${retained.pid}`);
    try { if (runValue() !== null) leftovers.push(`Run value ${WINDOWS_RUN_VALUE}`); }
    catch (error) { unknown = true; leftovers.push(`Run value unknown: ${detailOf(error)}`); }
    for (const path of [s.target.cmdPath, s.target.vbsPath]) {
      try { if (await fileBytes(path) !== null) leftovers.push(`launcher ${path}`); }
      catch (error) { unknown = true; leftovers.push(`launcher ${path}: ${detailOf(error)}`); }
    }
    if (unknown && !kind.endsWith('_refused') && !kind.endsWith('_incomplete')) kind = kind.startsWith('uninstall') || kind === 'not-installed' ? 'uninstall_incomplete' : 'install_incomplete';
    return { kind, detail, retained, leftovers };
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
      let s: Snapshot;
      try { s = await snapshot(); }
      catch (error) { return { kind: 'install_refused', detail: detailOf(error), retained: null, leftovers: [] }; }
      let before: OwnerIdentity | null = null;
      let previousFiles: Files;
      let previousRun: string | null;
      let desired: WindowsBytes;
      let port: number;
      try {
        command(['query', WINDOWS_RUN_KEY]);
        const current = await registration(s);
        if (current.kind !== 'ours' && current.kind !== 'absent') throw new Error(registrationDetail(current));
        const distribution = await d.distribution();
        if (distribution.kind !== 'global-npm' && distribution.kind !== 'bundled') throw new Error('Distribution cannot install a service');
        await capture(s);
        if (current.kind === 'absent' ? s.runValue !== null : s.runValue !== bytes(s, current.definition).runValue || !sameBytes(s.files.cmd, bytes(s, current.definition).cmd) || !sameBytes(s.files.vbs, bytes(s, current.definition).vbs)) throw new Error('Registration changed during preflight');
        previousFiles = { ...s.files }; previousRun = s.runValue;
        const owner = await d.readOwner(s.root);
        before = identity(owner);
        if (owner) {
          await d.verifyOwner(s.root, owner);
          const match = /^127\.0\.0\.1:(\d+)$/.exec(owner.listen ?? '');
          if (!match) throw new Error('Running owner has no published port');
          port = Number(match[1]);
        } else port = input.port ?? (current.kind === 'ours' ? current.definition.port : await d.freePort());
        desired = bytes(s, { root: s.root, port, distribution: { kind: distribution.kind === 'bundled' ? 'desktop' : 'npm', executable: d.executable, entry: distribution.cliPath }, capturedPath: d.capturedPath });
        const identical = s.runValue === desired.runValue && sameBytes(s.files.cmd, desired.cmd) && sameBytes(s.files.vbs, desired.vbs);
        if (identical) return outcome(s, 'already-installed', 'Already installed');
        if (current.kind === 'ours' && owner !== null) throw new Error('Run vonvon daemon stop before replacing the service');
      } catch (error) { return outcome(s, 'install_refused', detailOf(error)); }
      try {
        await write(s, 'cmd', desired.cmd);
        await write(s, 'vbs', desired.vbs);
        await setRun(s, desired.runValue);
        if (before === null) await d.launch(s.target.vbsPath);
        await ready(s, port, before === null);
        await checkExpected(s);
        return outcome(s, 'installed', 'Installed');
      } catch (error) {
        const reason = detailOf(error);
        const result = await remove(s, { kind: 'job-only', context: 'install-rollback' });
        if (result.kind === 'withdrawal-failed') return outcome(s, 'install_incomplete', `${reason}; ${result.detail}`);
        if (result.kind === 'drain-failed' && result.reason === 'stop_unconfirmed') return outcome(s, 'install_incomplete', `${reason}; ${result.detail}; nothing restored`);
        const detail = `${reason}; ${result.kind === 'unloaded' ? 'transaction launchers removed' : result.detail}`;
        try {
          await restore(s, result.kind === 'drain-failed' ? desired : previousFiles, result.kind === 'drain-failed' ? desired.runValue : previousRun);
        } catch (failure) { return outcome(s, 'install_incomplete', `${detail}; restore failed: ${detailOf(failure)}`); }
        const report = await outcome(s, result.kind === 'unloaded' && s.temporaryLeftovers.length === 0 ? 'install_rolled_back' : 'install_incomplete', detail);
        if (!sameOwner(before, report.retained)) report.kind = 'install_incomplete';
        return report;
      }
    },
    async uninstall(): Promise<LaunchdTransactionOutcome> {
      let s: Snapshot;
      try { s = await snapshot(); }
      catch (error) { return { kind: 'uninstall_refused', detail: detailOf(error), retained: null, leftovers: [] }; }
      let current: Registration;
      try {
        current = await registration(s);
        if (current.kind !== 'ours' && current.kind !== 'absent') return outcome(s, 'uninstall_refused', registrationDetail(current));
        await capture(s);
        if (current.kind === 'absent' ? s.runValue !== null : s.runValue !== bytes(s, current.definition).runValue || !sameBytes(s.files.cmd, bytes(s, current.definition).cmd) || !sameBytes(s.files.vbs, bytes(s, current.definition).vbs)) throw new Error('Registration changed during preflight');
      } catch (error) { return outcome(s, 'uninstall_refused', detailOf(error)); }
      if (current.kind === 'absent' && s.files.cmd === null && s.files.vbs === null) return outcome(s, 'not-installed', 'Not installed');
      const keptFiles = { ...s.files }; const keptRun = s.runValue;
      const scope: DrainScope = current.kind === 'ours' ? { kind: 'all-owners' } : { kind: 'job-only', context: 'uninstall-resumed' };
      let result = await remove(s, scope);
      if (result.kind === 'unloaded' && scope.kind === 'all-owners') {
        const final = await drain({ home: s.root, scope, queryJobPid: async () => null });
        if (final.kind === 'drain-failed') result = final;
      }
      if (result.kind === 'unloaded') return outcome(s, 'uninstalled', 'Uninstalled');
      if (result.kind === 'withdrawal-failed' || (result.kind === 'drain-failed' && result.reason === 'stop_unconfirmed') || keptRun === null) return outcome(s, 'uninstall_incomplete', `${result.kind === 'drain-failed' ? `${result.reason}: ` : ''}${result.detail}`);
      try { await restore(s, keptFiles, keptRun); }
      catch (error) { return outcome(s, 'uninstall_incomplete', `${result.detail}; restore failed: ${detailOf(error)}`); }
      return outcome(s, 'uninstall_rolled_back', result.detail);
    },
    async start(input: { port?: number } = {}): Promise<HostEndpoint> {
      const s = await snapshot();
      const current = await registration(s);
      if (current.kind !== 'ours') throw new Error(registrationDetail(current));
      const port = current.definition.port;
      if (input.port !== undefined && input.port !== port) throw new Error(`Service uses port ${port}, not requested port ${input.port}.`);
      if (await d.readOwner(s.root)) return ready(s, port, true);
      await d.launch(s.target.vbsPath);
      return ready(s, port, true);
    },
  };
}
