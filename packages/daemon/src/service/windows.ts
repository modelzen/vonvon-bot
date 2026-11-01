import { statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import type { HostEndpoint } from '../host/discovery';
import { isStaleOwner, readRunningPidLock, type PidLockInfo, type StaleOwner } from '../server/pid-lock';
import { stopVerifiedOwner, verifyPidLockOwner } from '../server/owner-verification';
import type { ServiceTransactionOutcome } from './adapter';
import { serviceStderrPath, serviceStdoutPath, type ServiceStatus } from './common';
import { renderDefinition, windowsTaskEnabled, type Definition } from './definitions';
import { runtimeDistribution, type Distribution } from './distribution';
import type { OwnerIdentity } from './drain';
import { createSidReader, resolveServiceRoot, serviceTarget, SidUnavailable, type CanonicalRoot } from './identity';
import { readDefinitionBytes, registrationFromBytes, TaskQueryFailed, type Registration } from './registration';
import { decodeConsoleText, runWindowsCommand, withTimeout, type WindowsRun } from './windows-command';

/** I4a §4.7: the fixed `reason` values of `service install|uninstall --json` on Windows; I2b's install.ps1 reads them. */
export type WindowsServiceReason =
  | 'sid_unavailable' | 'task_foreign' | 'task_other_root' | 'schtasks_denied' | 'schtasks_create_failed' | 'schtasks_run_failed'
  | 'schtasks_query_failed' | 'handover_failed' | 'not_registered' | 'schtasks_delete_failed';

/** I4a §4.3: the waits, all on the injected clock. */
export const WINDOWS_SERVICE_TIMING = { readyMs: 30_000, rerunAfterMs: 5_000, handoverMs: 15_000, killedMs: 5_000, stopMs: 10_000, pollMs: 500 } as const;
/** Written by `__win-supervise` (I4b; the I4a placeholder too): `{ pid, startedAt, version }` in the data root. */
export const SUPERVISOR_PID_FILE = 'supervisor.pid';
export const NOT_RUNNING_WARNING = '任务已启动，daemon 30 秒内没起来；看 vonvon daemon logs';

type WinTarget = { platform: 'win32'; taskName: string; sid: string };
type Snapshot = { root: string; exists: boolean; target: WinTarget };
type Observation = { kind: 'query-failed'; detail: string } | { kind: 'read'; registration: Registration; xml: Buffer | null };
type Program = Definition['distribution'];

export type WindowsServiceDependencies = {
  /** `schtasks`, `whoami`, `taskkill`; wrapped in the 15-second limit (I4a §4.3). */
  run: WindowsRun;
  sid: () => Promise<string>;
  resolveRoot: typeof resolveServiceRoot;
  distribution: () => Promise<Distribution>;
  readLock: typeof readRunningPidLock;
  verifyOwner: typeof verifyPidLockOwner;
  /** `machine.stopHost` over loopback to a verified owner, as the Linux handover does. */
  stopHost: typeof stopVerifiedOwner;
  /** The pid in `<root>\supervisor.pid`, or null. */
  readSupervisor: (root: string) => Promise<number | null>;
  isAlive: (pid: number) => boolean;
  isFile: (path: string) => boolean;
  mkdtemp: (prefix: string) => Promise<string>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  /** Removes the directory this module just created with `mkdtemp`. */
  removeTemporary: (path: string) => Promise<void>;
  tmpdir: string;
  freePort: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  capturedPath: string;
};

const detailOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const identity = (owner: PidLockInfo): OwnerIdentity => ({ pid: owner.pid, startedAt: owner.startedAt });
const sameOwner = (a: OwnerIdentity, b: OwnerIdentity): boolean => a.pid === b.pid && a.startedAt === b.startedAt;
const text = (value: Uint8Array | string): string => decodeConsoleText(value).trim();
/** Group Policy "Prohibit users from creating tasks" and its kin: English, Chinese, or the HRESULT. */
const DENIED = /access is denied|拒绝访问|0x80070005/i;

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

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM'; }
}

async function readSupervisor(root: string): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(join(root, SUPERVISOR_PID_FILE), 'utf8')) as { pid?: unknown };
    return typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null;
  } catch { return null; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** What the task runs (devices 7.2): the install root's launcher, which picks the version from `current.txt`. */
export function windowsProgram(installRoot: string): Program {
  return { kind: 'standalone', executable: win32.join(installRoot, 'bin', 'vonvon-server.cmd'), entry: win32.join(installRoot, 'current.txt') };
}

/** The first row of `schtasks /Query /FO CSV /NH`, its fields unquoted. */
export function parseCsvRow(output: string): string[] {
  const line = output.split(/\r?\n/).find(row => row.trim() !== '') ?? '';
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { fields.push(field); field = ''; }
    else field += c;
  }
  fields.push(field);
  return fields;
}

export function createWindowsService(options: { root: string }, overrides: Partial<WindowsServiceDependencies> = {}) {
  const base = overrides.run ?? runWindowsCommand;
  const run = withTimeout(base);
  const d: WindowsServiceDependencies = {
    run, sid: createSidReader(run), resolveRoot: resolveServiceRoot, distribution: runtimeDistribution,
    readLock: readRunningPidLock, verifyOwner: verifyPidLockOwner, stopHost: stopVerifiedOwner, readSupervisor, isAlive, isFile,
    mkdtemp: prefix => mkdtemp(prefix), writeFile: (path, data) => writeFile(path, data),
    removeTemporary: path => rm(path, { recursive: true, force: true }), tmpdir: tmpdir(), freePort,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now, capturedPath: process.env.PATH ?? '',
    ...overrides,
  };
  d.run = run;
  const T = WINDOWS_SERVICE_TIMING;

  function result(kind: ServiceTransactionOutcome['kind'], detail: string, extra: { reason?: WindowsServiceReason; fallback?: 'detached'; warning?: string; retained?: OwnerIdentity | null; leftovers?: string[] } = {}): ServiceTransactionOutcome {
    return {
      kind, detail, retained: extra.retained ?? null, leftovers: extra.leftovers ?? [],
      ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.fallback ? { fallback: extra.fallback } : {}), ...(extra.warning ? { warning: extra.warning } : {}),
    };
  }

  async function snapshot(): Promise<Snapshot> {
    const sid = await d.sid();
    let root: string;
    let exists = true;
    try { root = await d.resolveRoot(options.root); }
    catch (error) { if (!isMissing(error)) throw error; root = options.root; exists = false; }
    return { root, exists, target: serviceTarget({ platform: 'win32', sid, root }) };
  }

  /** Reads the task once; a `schtasks` that gives no answer is told apart from a task that is not ours. */
  async function observe(s: Snapshot): Promise<Observation> {
    let xml: Buffer | null;
    try { xml = await readDefinitionBytes(s.target, d.run); }
    catch (error) {
      if (error instanceof TaskQueryFailed) return { kind: 'query-failed', detail: error.message };
      return { kind: 'read', registration: { kind: 'unrecognized', location: s.target.taskName, reason: detailOf(error) }, xml: null };
    }
    if (!s.exists) {
      return { kind: 'read', xml, registration: xml === null ? { kind: 'absent' } : { kind: 'unrecognized', location: s.target.taskName, reason: `its data directory ${s.root} is missing` } };
    }
    return { kind: 'read', xml, registration: await registrationFromBytes({ target: s.target, requestedRoot: s.root }, xml) };
  }

  async function exists(s: Snapshot): Promise<boolean | null> {
    const query = await d.run('schtasks', ['/Query', '/TN', s.target.taskName, '/FO', 'CSV', '/NH']);
    return query.status === 0 ? true : query.status === 1 ? false : null;
  }

  async function waitUntil(done: () => Promise<boolean>, ms: number): Promise<boolean> {
    const deadline = d.now() + ms;
    for (;;) {
      if (await done()) return true;
      if (d.now() >= deadline) return false;
      await d.sleep(T.pollMs);
    }
  }

  /** The daemon this lock named is gone, and so is any supervisor that `supervisor.pid` names. */
  async function stopped(s: Snapshot, owner: PidLockInfo | null): Promise<boolean> {
    const lock = await d.readLock(s.root);
    if (owner && lock && sameOwner(lock, owner)) return false;
    const supervisor = await d.readSupervisor(s.root);
    return supervisor === null || !d.isAlive(supervisor);
  }

  /** A verified owner on the task's port, other than `skip`; null when none came within 30 s. */
  async function waitForOwner(s: Snapshot, port: number, skip: StaleOwner | undefined, rerun: boolean): Promise<HostEndpoint | null> {
    const started = d.now();
    let rerunDone = !rerun;
    for (;;) {
      const owner = await d.readLock(s.root);
      if (owner?.listen && !isStaleOwner(owner, skip)) {
        let verified = true;
        try { await d.verifyOwner(s.root, owner); } catch { verified = false; }
        if (verified) {
          if (owner.listen !== `127.0.0.1:${port}`) throw new Error(`Daemon PID ${owner.pid} already runs at ${owner.listen}, not the task's port ${port}.`);
          return { pid: owner.pid, startedAt: owner.startedAt, listen: owner.listen, port };
        }
      }
      if (d.now() - started >= T.readyMs) break;
      // A /Run that met the previous instance still exiting is ignored (IgnoreNew): ask once more.
      if (!rerunDone && d.now() - started >= T.rerunAfterMs) {
        rerunDone = true;
        await d.run('schtasks', ['/Run', '/TN', s.target.taskName]);
      }
      await d.sleep(T.pollMs);
    }
    if (skip) {
      // Nothing replaced the skipped owner; its earlier verification failure may have been transient.
      const owner = await d.readLock(s.root);
      if (owner?.listen === `127.0.0.1:${port}` && isStaleOwner(owner, skip)) {
        await d.verifyOwner(s.root, owner);
        return { pid: owner.pid, startedAt: owner.startedAt, listen: owner.listen, port };
      }
    }
    return null;
  }

  /** I4a §4.3 step 5: stop a detached daemon so the task takes the data root over; `taskkill` after 15 s. */
  async function handOver(s: Snapshot, owner: PidLockInfo): Promise<string | null> {
    // An owner that does not answer as ours is never killed by PID: the PID may belong to someone else now.
    try { await d.stopHost(s.root, owner); }
    catch (error) { return `daemon PID ${owner.pid} 没回应停止请求：${detailOf(error)}`; }
    if (await waitUntil(() => stopped(s, owner), T.handoverMs)) return null;
    await d.run('taskkill', ['/T', '/F', '/PID', String(owner.pid)]);
    if (await waitUntil(() => stopped(s, owner), T.killedMs)) return null;
    return `daemon PID ${owner.pid} 在 taskkill 之后还在`;
  }

  function registrationDetail(name: string, r: Exclude<Registration, { kind: 'absent' | 'ours' }>): { detail: string; reason: WindowsServiceReason } {
    return r.kind === 'other-root'
      ? { reason: 'task_other_root', detail: `Registration belongs to ${r.recordedRoot}: 计划任务 ${name} 记的是另一个数据目录。` }
      : { reason: 'task_foreign', detail: `计划任务 ${name} 已经存在，但不是 Vonvon Bot 写的（${r.reason}）。不会覆盖或删除它；确认是谁的再在任务计划程序里处理。` };
  }

  return {
    async install(input: { port?: number; keepRunning?: boolean } = {}): Promise<ServiceTransactionOutcome> {
      let s: Snapshot;
      try { s = await snapshot(); }
      catch (error) { return result('install_refused', detailOf(error), error instanceof SidUnavailable ? { reason: 'sid_unavailable' } : {}); }
      const name = s.target.taskName;
      if (!s.exists) return result('install_refused', `No data directory at ${s.root}`);
      const distribution = await d.distribution();
      if (distribution.kind !== 'standalone') return result('install_refused', 'Distribution cannot install a service: Windows 只支持 standalone 的服务（用安装脚本装的服务端）。');
      const program = windowsProgram(distribution.installRoot);
      if (!d.isFile(program.executable) || !d.isFile(program.entry)) return result('install_refused', `安装根 ${distribution.installRoot} 缺 bin\\vonvon-server.cmd 或 current.txt；重新运行安装脚本。`);
      const observed = await observe(s);
      if (observed.kind === 'query-failed') return result('install_refused', observed.detail, { reason: 'schtasks_query_failed' });
      const current = observed.registration;
      if (current.kind === 'other-root' || current.kind === 'unrecognized') {
        const { detail, reason } = registrationDetail(name, current);
        return result('install_refused', detail, { reason });
      }
      let owner: PidLockInfo | null;
      let port: number;
      let xml: Uint8Array;
      try {
        owner = await d.readLock(s.root);
        if (owner) {
          await d.verifyOwner(s.root, owner);
          const match = /^127\.0\.0\.1:(\d+)$/.exec(owner.listen ?? '');
          if (!match) throw new Error('Running owner has no published port');
          port = Number(match[1]);
        } else port = input.port ?? (current.kind === 'ours' ? current.definition.port : await d.freePort());
        const rendered = renderDefinition({ target: s.target, root: s.root as CanonicalRoot, port, distribution: program, capturedPath: d.capturedPath });
        if (rendered.platform !== 'win32') throw new Error('Invalid Windows definition');
        xml = rendered.xml;
      } catch (error) { return result('install_refused', detailOf(error)); }

      // Steps 3 and 4: the one way to create (WIN-2), from a file in a directory made for it and removed after.
      let created;
      let directory: string | undefined;
      try {
        directory = await d.mkdtemp(join(d.tmpdir, 'vonvon-task-'));
        const file = join(directory, 'task.xml');
        await d.writeFile(file, xml);
        created = await d.run('schtasks', ['/Create', '/TN', name, '/XML', file, '/F']);
      } catch (error) {
        return result('install_refused', `Cannot write the task file: ${detailOf(error)}`, { reason: 'schtasks_create_failed' });
      } finally {
        if (directory !== undefined) await d.removeTemporary(directory).catch(() => undefined);
      }
      if (!created.ok || created.status !== 0) {
        const stderr = text(created.stderr) || text(created.stdout) || `exit ${created.status}`;
        if (DENIED.test(stderr)) return result('install_refused', `schtasks /Create 被拒绝（组策略可能禁止了用户建计划任务）：${stderr}`, { reason: 'schtasks_denied', fallback: 'detached' });
        return result('install_refused', `schtasks /Create: ${stderr}`, { reason: 'schtasks_create_failed' });
      }

      if (owner) {
        if (input.keepRunning) return result('installed', `已注册计划任务 ${name}；现在的 daemon（PID ${owner.pid}）继续运行，下次登录才由任务接管。`, { retained: identity(owner) });
        const failure = await handOver(s, owner);
        if (failure) return result('install_incomplete', `计划任务 ${name} 已注册，但${failure}。运行 vonvon daemon stop，再运行 vonvon daemon start。`, { reason: 'handover_failed' });
      }

      const started = await d.run('schtasks', ['/Run', '/TN', name]);
      if (!started.ok || started.status !== 0) {
        const stderr = text(started.stderr) || `exit ${started.status}`;
        return result('install_incomplete', `已注册计划任务 ${name}，下次登录生效；现在没能启动它（schtasks /Run: ${stderr}）。现在运行 vonvon daemon start。`, { reason: 'schtasks_run_failed' });
      }
      let endpoint: HostEndpoint | null;
      try { endpoint = await waitForOwner(s, port, owner ? identity(owner) : undefined, true); }
      catch (error) { return result('install_incomplete', `已注册计划任务 ${name}；${detailOf(error)}`); }
      if (!endpoint) return result('installed', `已注册计划任务 ${name}。${NOT_RUNNING_WARNING}`, { warning: NOT_RUNNING_WARNING });
      return result('installed', `已注册计划任务 ${name}。`, { retained: { pid: endpoint.pid, startedAt: endpoint.startedAt } });
    },

    async uninstall(): Promise<ServiceTransactionOutcome> {
      let s: Snapshot;
      try { s = await snapshot(); }
      catch (error) { return result('uninstall_refused', detailOf(error), error instanceof SidUnavailable ? { reason: 'sid_unavailable' } : {}); }
      const name = s.target.taskName;
      const observed = await observe(s);
      if (observed.kind === 'query-failed') return result('uninstall_incomplete', observed.detail, { reason: 'schtasks_query_failed' });
      const current = observed.registration;
      if (current.kind === 'absent') return result('not-installed', `没有计划任务 ${name}。`, { reason: 'not_registered' });
      if (current.kind !== 'ours') {
        const { detail, reason } = registrationDetail(name, current);
        return result('uninstall_refused', detail, { reason });
      }
      // Stop first, then delete: a crash between leaves a task that the next uninstall removes, never a supervisor nobody owns.
      const owner = await d.readLock(s.root);
      const supervisor = await d.readSupervisor(s.root);
      if (owner || (supervisor !== null && d.isAlive(supervisor))) {
        let asked = false;
        if (owner?.listen) {
          try { await d.stopHost(s.root, owner); asked = true; }
          catch { /* /End and taskkill below */ }
        }
        if (!asked || !(await waitUntil(() => stopped(s, owner), T.stopMs))) {
          await d.run('schtasks', ['/End', '/TN', name]);
          // Only a daemon that answered the stop is killed by PID; one that did not may be a stale lock on a reused PID.
          const lock = asked && owner ? await d.readLock(s.root) : null;
          if (owner && lock && sameOwner(lock, owner)) await d.run('taskkill', ['/T', '/F', '/PID', String(owner.pid)]);
        }
      }
      const deleted = await d.run('schtasks', ['/Delete', '/TN', name, '/F']);
      if ((!deleted.ok || deleted.status !== 0) && (await exists(s)) !== false) {
        return result('uninstall_incomplete', `schtasks /Delete: ${text(deleted.stderr) || `exit ${deleted.status}`}`, { reason: 'schtasks_delete_failed' });
      }
      const left = owner ? await d.readLock(s.root) : null;
      if (owner && left && sameOwner(left, owner)) return result('uninstall_incomplete', `已删除计划任务 ${name}，但 daemon PID ${owner.pid} 还在运行。`, { retained: identity(owner), leftovers: [`retained pid ${owner.pid}`] });
      return result('uninstalled', `已删除计划任务 ${name}。`);
    },

    async status(): Promise<ServiceStatus> {
      const shape = (name: string, state: ServiceStatus['state'], detail: string, extra: Partial<ServiceStatus> = {}): ServiceStatus => ({
        platformName: 'Task Scheduler (Windows)', state, detail, installed: false, running: false, name, servicePath: name,
        stdoutPath: serviceStdoutPath(), stderrPath: serviceStderrPath(), ...extra,
      });
      let s: Snapshot;
      try { s = await snapshot(); }
      catch (error) { return shape('\\VonvonBot', 'unknown', `Cannot ask Task Scheduler: ${detailOf(error)}`); }
      const name = s.target.taskName;
      const observed = await observe(s);
      if (observed.kind === 'query-failed') return shape(name, 'unknown', `Cannot ask Task Scheduler: ${observed.detail}`);
      const owner = s.exists ? await d.readLock(s.root).catch(() => null) : null;
      let running = false;
      if (owner?.listen) {
        // The daemon asking about its own service need not authenticate itself over its own socket.
        try { if (owner.pid !== process.pid) await d.verifyOwner(s.root, owner); running = true; }
        catch { running = false; }
      }
      const pid = running && owner ? { pid: String(owner.pid) } : {};
      const current = observed.registration;
      if (current.kind === 'absent') {
        return shape(name, 'not-installed', running
          ? '没注册计划任务；现在在跑的 daemon 是 vonvon daemon start 起的。运行 vonvon service install 交给计划任务。'
          : '没注册计划任务。运行 vonvon service install。', { running, ...pid });
      }
      if (current.kind !== 'ours') return shape(name, 'conflict', registrationDetail(name, current).detail, { installed: true, running, ...pid });
      // The Status column is in the UI language: shown, never decided on. Disabled comes from the XML's own Settings.
      const query = await d.run('schtasks', ['/Query', '/TN', name, '/FO', 'CSV', '/V', '/NH']);
      const column = query.ok && query.status === 0 ? parseCsvRow(text(query.stdout))[3] ?? '' : '';
      const task = { name, status: column || 'unknown' };
      const enabled = observed.xml !== null && windowsTaskEnabled(observed.xml) && column !== 'Disabled';
      if (!enabled) return shape(name, 'disabled', '计划任务被禁用了。在任务计划程序里启用它，或重新运行 vonvon service install。', { installed: true, running, ...pid, task });
      if (running) return shape(name, 'running', '由计划任务运行。', { installed: true, running, ...pid, task });
      return shape(name, 'stopped', '已注册计划任务，daemon 没在运行。运行 vonvon daemon start。', { installed: true, task });
    },

    /** `vonvon daemon start` with the task registered (`startRegisteredDaemon`). */
    async start(input: { port?: number; staleOwner?: StaleOwner } = {}): Promise<HostEndpoint> {
      const s = await snapshot();
      const observed = await observe(s);
      if (observed.kind === 'query-failed') throw new Error(observed.detail);
      const current = observed.registration;
      if (current.kind !== 'ours') throw new Error(current.kind === 'absent' ? `No scheduled task ${s.target.taskName}` : registrationDetail(s.target.taskName, current).detail);
      const port = current.definition.port;
      if (input.port !== undefined && input.port !== port) throw new Error(`Service uses port ${port}, not requested port ${input.port}.`);
      const owner = await d.readLock(s.root);
      if (!owner || isStaleOwner(owner, input.staleOwner)) {
        if (observed.xml !== null && !windowsTaskEnabled(observed.xml)) throw new Error(`计划任务 ${s.target.taskName} 被禁用了：在任务计划程序里启用它，或重新运行 vonvon service install。`);
        const r = await d.run('schtasks', ['/Run', '/TN', s.target.taskName]);
        if (!r.ok || r.status !== 0) throw new Error(`计划任务 ${s.target.taskName} 没能启动（可能被禁用了）：${text(r.stderr) || `exit ${r.status}`}`);
      }
      const endpoint = await waitForOwner(s, port, input.staleOwner, !owner || isStaleOwner(owner, input.staleOwner));
      if (!endpoint) throw new Error(input.staleOwner ? `Daemon PID ${input.staleOwner.pid} could not be verified and no replacement became ready; readiness timed out.` : NOT_RUNNING_WARNING);
      return endpoint;
    },
  };
}
