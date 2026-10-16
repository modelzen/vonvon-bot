import { stat } from 'node:fs/promises';
import type { Server } from 'node:net';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { acquireMutex, closeMutex, DataAccessError } from '../../config/data-access';
import { paths } from '../../config/paths';
import { readRunningPidLock, type PidLockInfo } from '../../server/pid-lock';
import { classifyServiceFailure, serviceActionPath, writeServiceActionRecord, type ServiceActionRecord } from '../../service/action-report';
import type { ServiceAdapter, ServiceTransactionOutcome } from '../../service/adapter';
import { enableFailed, enableLinger, lingerLine, readLinger, userManagerHint, type Linger } from '../../service/linux-session';

const STATE_TEXT = {
  'not-installed': 'not installed', running: 'running', stopped: 'installed, stopped', disabled: 'turned off',
  detached: 'installed, daemon running outside the service', conflict: 'needs attention', unknown: 'unknown',
} as const;

export type ServiceCommandDependencies = {
  root: string;
  readOwner: (root: string) => Promise<PidLockInfo | null>;
  /** `vonvon daemon start --port N`: a detached daemon, or the registered service's job. */
  start: (port: number) => Promise<{ pid: number }>;
  now: () => number;
  /** Linux only (s20a): what follows a finished install or uninstall, and why the user manager cannot be asked. */
  linux: LinuxServiceSteps | undefined;
};
export type LingerChoice = 'ask' | 'on' | 'off';
type LinuxServiceSteps = {
  /** False when `--linger` was given and linger is still off. */
  afterInstall: (linger: LingerChoice) => Promise<boolean>;
  afterUninstall: () => Promise<string | undefined>;
  hint: () => Promise<string | undefined>;
};

const detailOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const succeeded = (kind: ServiceTransactionOutcome['kind']): boolean => kind === 'installed' || kind === 'already-installed' || kind === 'uninstalled' || kind === 'not-installed';

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

/**
 * Prints the outcome; anything but a completed install or uninstall exits 1 with the detail and leftovers.
 * With a data root, the `service` mutex serializes every caller and `service-action.json` records the run.
 * `keepRunning` starts the daemon that was running before again, on its port, when the transaction left none.
 */
export async function runServiceCommand(action: 'install' | 'uninstall', adapter?: Pick<ServiceAdapter, 'install' | 'uninstall'>, options: { port?: number; keepRunning?: boolean; linger?: LingerChoice } = {}, overrides: Partial<ServiceCommandDependencies> = {}): Promise<void> {
  const service = adapter ?? (await import('../../service/adapter')).getServiceAdapter();
  const d: ServiceCommandDependencies = {
    root: paths.appDir, readOwner: readRunningPidLock, now: Date.now, linux: process.platform === 'linux' ? linuxServiceSteps() : undefined,
    start: async port => {
      const status = await (await import('./daemon')).runStart(port);
      if (!status.running) throw new Error('Daemon did not start.');
      return { pid: status.pid };
    },
    ...overrides,
  };
  // A fresh machine has no data root yet: install creates it, and nothing else can be running there.
  let mutex: Server | null = null;
  if (await exists(d.root)) {
    try { mutex = await acquireMutex(d.root, 'service', 0); }
    catch (error) {
      if (error instanceof DataAccessError) throw new Error(`${action}_refused: Another vonvon service install or uninstall is running.`);
      throw error;
    }
  }
  let result: ServiceTransactionOutcome;
  let restart: Pick<ServiceActionRecord, 'restarted' | 'restartError'> = {};
  let port = 0;
  try {
    const run = { pid: process.pid, action, startedAt: d.now() } as const;
    if (mutex) await writeServiceActionRecord(d.root, { ...run, phase: 'running' });
    const before = await d.readOwner(d.root).catch(() => null);
    const { keepRunning, linger: _linger, ...install } = options;
    try { result = action === 'install' ? await service.install(install) : await service.uninstall(); }
    catch (error) { result = { kind: `${action}_incomplete`, detail: detailOf(error), retained: null, leftovers: [] }; }
    // The service now owns the port, or nothing changed: a daemon that still runs is left alone.
    if (keepRunning && before && !(await d.readOwner(d.root).catch(() => null))) {
      port = Number(/^127\.0\.0\.1:(\d+)$/.exec(before.listen ?? '')?.[1] ?? 0);
      // Port 0 would pick a fresh one, which the open page and the report's "the old port" would not match.
      if (!port) restart = { restartError: `Daemon PID ${before.pid} had not published its port` };
      else {
        try { restart = { restarted: { pid: (await d.start(port)).pid } }; }
        catch (error) { restart = { restartError: detailOf(error) }; }
      }
    }
    if (mutex) {
      const ok = succeeded(result.kind);
      try {
        await writeServiceActionRecord(d.root, {
          ...run, phase: 'done', ok, kind: result.kind, ...(ok ? {} : { reason: classifyServiceFailure(result.detail) }),
          detail: result.detail, leftovers: [...result.leftovers], finishedAt: d.now(), ...restart,
        });
      } catch (error) { process.stderr.write(`Could not write ${serviceActionPath(d.root)}: ${detailOf(error)}\n`); }
    }
  } finally {
    if (mutex) await closeMutex(mutex);
  }
  const lines = [`${result.kind}: ${result.detail}`];
  if (restart.restarted) lines.push(`Daemon PID ${restart.restarted.pid} was started again, detached, on port ${port}.`);
  if (restart.restartError) lines.push(`The daemon was not started again: ${restart.restartError}. Run vonvon daemon start.`);
  // A successful install reports the service's own daemon in `retained` and its plist or unit in `leftovers`; neither is left behind.
  if (result.kind === 'installed' || result.kind === 'already-installed') {
    if (result.retained !== null) lines.push(`Daemon PID ${result.retained.pid} is running under the service.`);
    process.stdout.write(`${lines.join('\n')}\n`);
    // After the mutex: asking about linger can wait on the user.
    if (d.linux && !(await d.linux.afterInstall(options.linger ?? 'ask'))) throw new Error('服务已经装好，只是 linger 没开成。');
    return;
  }
  if (result.retained !== null) lines.push(`Daemon PID ${result.retained.pid} is still running.`);
  for (const leftover of result.leftovers) lines.push(`Left behind: ${leftover}`);
  switch (result.kind) {
    case 'uninstalled':
    case 'not-installed': {
      const linger = result.kind === 'uninstalled' ? await d.linux?.afterUninstall() : undefined;
      if (linger) lines.push(linger);
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    }
    case 'install_refused':
    case 'install_rolled_back':
    case 'install_incomplete':
    case 'uninstall_refused':
    case 'uninstall_rolled_back':
    case 'uninstall_incomplete':
      if (result.detail.includes('stop_unconfirmed')) lines.push('Next step: vonvon service uninstall');
      if (result.detail.includes('User manager unavailable')) {
        const hint = await d.linux?.hint();
        if (hint) lines.push(hint);
      }
      throw new Error(lines.join('\n'));
    default: {
      const exhaustive: never = result.kind;
      throw new Error(`Unknown service result: ${String(exhaustive)}`);
    }
  }
}

export type AfterInstallDependencies = {
  readLinger: () => Promise<Linger>;
  enableLinger: () => Promise<{ ok: true } | { ok: false; detail: string }>;
  /** The y/N question; only asked when stdin and stdout are both terminals. */
  ask: (question: string) => Promise<boolean>;
  interactive: boolean;
  user: string;
  /** How to open the web page (open.ts `openGuide`). */
  guide: () => Promise<string[]>;
  write: (text: string) => void;
};

export const LINGER_QUESTION = 'linger 没开：退出最后一个登录会话后，systemd 会停掉 bot，开机也不会启动。要开吗？[Y/n] ';

/**
 * After a Linux install (3.10): linger, then how to open the web page. Enter or y agrees; n, EOF, Ctrl-C and a
 * non-terminal do not. Without an answer nothing is turned on. Returns false only for `--linger` that did not take.
 */
export async function afterLinuxInstall(choice: LingerChoice, d: AfterInstallDependencies): Promise<boolean> {
  const linger = await d.readLinger();
  const enable = linger.state !== 'on'
    && (choice === 'on' || (choice === 'ask' && linger.state === 'off' && d.interactive && await d.ask(LINGER_QUESTION)));
  let ok = true;
  if (enable) {
    const enabled = await d.enableLinger();
    d.write(`${enabled.ok ? '已开 linger。' : enableFailed(enabled.detail, d.user)}\n`);
    ok = enabled.ok || choice !== 'on';
  } else d.write(`${lingerLine(linger, d.user)}\n`);
  d.write(`${(await d.guide()).join('\n')}\n`);
  return ok;
}

/** Enter or y; n, EOF and Ctrl-C answer no. */
function ask(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    prompt.on('SIGINT', () => prompt.close());
    prompt.on('close', () => { if (!answered) { process.stdout.write('\n'); resolve(false); } });
    prompt.question(question, answer => { answered = true; prompt.close(); resolve(/^\s*(y|yes)?\s*$/i.test(answer)); });
  });
}

function linuxServiceSteps(): LinuxServiceSteps {
  const user = userInfo().username;
  return {
    afterInstall: async choice => {
      const { serviceOpenGuide } = await import('./open');
      const tty = Boolean(process.stdout.isTTY);
      return afterLinuxInstall(choice, {
        readLinger, enableLinger, ask, interactive: tty && Boolean(process.stdin.isTTY), user,
        guide: () => serviceOpenGuide(tty), write: text => { process.stdout.write(text); },
      });
    },
    // linger belongs to the account and other user services may need it, so uninstall leaves it on.
    afterUninstall: async () => (await readLinger()).state === 'on' ? 'linger 没关：这个账号上别的用户服务可能也要它。不需要的话运行 loginctl disable-linger。' : undefined,
    hint: userManagerHint,
  };
}

export async function runServiceStatus(json: boolean, adapter?: Pick<ServiceAdapter, 'status'>): Promise<void> {
  const status = await (adapter ?? (await import('../../service/adapter')).getServiceAdapter()).status();
  if (json) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  process.stdout.write([
    `${status.platformName} ${status.name}: ${STATE_TEXT[status.state]}${status.running && status.pid ? ` (PID ${status.pid})` : ''}`,
    status.detail,
    ...(status.hint ? [status.hint] : []),
    ...(status.linger ? [lingerLine(status.linger, userInfo().username)] : []),
    `Definition: ${status.servicePath}`,
    `Logs: ${status.stdoutPath}, ${status.stderrPath}`,
  ].join('\n') + '\n');
}
