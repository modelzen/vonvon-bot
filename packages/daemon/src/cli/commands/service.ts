import { stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { acquireMutex, closeMutex, DataAccessError, type Mutex } from '../../config/data-access';
import { paths } from '../../config/paths';
import { readRunningPidLock, type PidLockInfo } from '../../server/pid-lock';
import { classifyServiceFailure, serviceActionPath, writeServiceActionRecord, type ServiceActionRecord } from '../../service/action-report';
import type { ServiceAdapter, ServiceTransactionOutcome } from '../../service/adapter';
import { describeServiceExits } from '../../service/exits';
import { enableFailed, enableLinger, lingerLine, readLinger, userManagerProblem, type Linger, type UserManagerProblem } from '../../service/linux-session';
import { inBotSession } from '../../config/session-env';
import { CommandError } from '../command-error';
import { print, withDaemon, type Daemon, type Io } from '../daemon-client';
import { rootWarning } from '../root-warning';

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
  /** 0 is root, which gets a warning (server-2 4.3); undefined on Windows. */
  getuid: () => number | undefined;
};
export type LingerChoice = 'ask' | 'on' | 'off';
/** server-2 4.4: `on` when linger was on or was just turned on; `unsupported` off Linux. */
export type LingerState = 'on' | 'off' | 'unsupported';
type LinuxServiceSteps = {
  /** Whether linger is on afterwards. With `notes` (--json) nothing is asked and the lines go there. */
  afterInstall: (linger: LingerChoice, notes?: string[]) => Promise<'on' | 'off'>;
  afterUninstall: () => Promise<string | undefined>;
  /** Why the user manager cannot be asked, given what systemctl answered, when it is one of the common causes. */
  problem: (detail: string) => Promise<UserManagerProblem | undefined>;
  /** For `sudo loginctl enable-linger <user>`. */
  user: string;
};
/** The user names a script can paste into `sudo loginctl enable-linger` as they are. */
const SAFE_USER = /^[A-Za-z0-9._-]+$/;

const detailOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const TEXT: Io = { json: false, write: text => { process.stdout.write(text); } };
const succeeded = (kind: ServiceTransactionOutcome['kind']): boolean => kind === 'installed' || kind === 'already-installed' || kind === 'uninstalled' || kind === 'not-installed';

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}

/**
 * Prints the outcome; anything but a completed install or uninstall exits 1 with the detail and leftovers.
 * With a data root, the `service` mutex serializes every caller and `service-action.json` records the run.
 * `keepRunning` starts the daemon that was running before again, on its port, when the transaction left none.
 * --json prints one line, a failure's `error.partial` holding the same fields, and asks nothing.
 */
export async function runServiceCommand(action: 'install' | 'uninstall', adapter?: Pick<ServiceAdapter, 'install' | 'uninstall'>, options: { port?: number; keepRunning?: boolean; linger?: LingerChoice } = {}, overrides: Partial<ServiceCommandDependencies> = {}, io: Io = TEXT): Promise<void> {
  const service = adapter ?? (await import('../../service/adapter')).getServiceAdapter();
  const d: ServiceCommandDependencies = {
    root: paths.appDir, readOwner: readRunningPidLock, now: Date.now, linux: process.platform === 'linux' ? linuxServiceSteps() : undefined, getuid: () => process.getuid?.(),
    start: async port => {
      const status = await (await import('./daemon')).runStart(port);
      if (!status.running) throw new Error('Daemon did not start.');
      return { pid: status.pid };
    },
    ...overrides,
  };
  const warning = action === 'install' ? rootWarning(d.getuid) : undefined;
  if (warning && !io.json) process.stderr.write(`${warning}\n`);
  // A fresh machine has no data root yet: install creates it, and nothing else can be running there.
  let mutex: Mutex | null = null;
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
  // A successful install reports the service's own daemon in `retained` and its plist or unit in `leftovers`; neither is
  // left behind, so only the other outcomes name the leftovers.
  const outcome = {
    action, result: result.kind, detail: result.detail, retained: result.retained,
    ...restart.restarted ? { restarted: { ...restart.restarted, port } } : {}, ...restart.restartError ? { restartError: restart.restartError } : {},
  };
  if (result.kind === 'installed' || result.kind === 'already-installed') {
    if (result.retained !== null) lines.push(`Daemon PID ${result.retained.pid} is running under the service.`);
    if (!io.json) io.write(`${lines.join('\n')}\n`);
    // After the mutex: asking about linger can wait on the user.
    const notes: string[] = warning ? [warning] : [];
    let linger: LingerState = 'unsupported';
    // A linger that did not take is not a failed install (LINGER-1): the line printed says what to run with sudo.
    if (d.linux) linger = await (io.json ? d.linux.afterInstall(options.linger ?? 'ask', notes) : d.linux.afterInstall(options.linger ?? 'ask'));
    const lingerUser = linger === 'off' && d.linux && SAFE_USER.test(d.linux.user) ? d.linux.user : undefined;
    if (io.json) io.write(`${JSON.stringify({ ok: true, ...outcome, linger, ...lingerUser ? { lingerUser } : {}, notes })}\n`);
    return;
  }
  if (result.retained !== null) lines.push(`Daemon PID ${result.retained.pid} is still running.`);
  for (const leftover of result.leftovers) lines.push(`Left behind: ${leftover}`);
  switch (result.kind) {
    case 'uninstalled':
    case 'not-installed': {
      const linger = result.kind === 'uninstalled' ? await d.linux?.afterUninstall() : undefined;
      if (linger) lines.push(linger);
      io.write(io.json ? `${JSON.stringify({ ok: true, ...outcome, leftovers: result.leftovers, notes: linger ? [linger] : [] })}\n` : `${lines.join('\n')}\n`);
      return;
    }
    case 'install_refused':
    case 'install_rolled_back':
    case 'install_incomplete':
    case 'uninstall_refused':
    case 'uninstall_rolled_back':
    case 'uninstall_incomplete': {
      if (result.detail.includes('stop_unconfirmed')) lines.push('Next step: vonvon service uninstall');
      const partial = { ...outcome, leftovers: result.leftovers, ...warning ? { notes: [warning] } : {} };
      if (result.detail.includes('User manager unavailable')) {
        const problem = await d.linux?.problem(result.detail);
        if (problem) lines.push(problem.hint);
        // This machine or this login cannot run a user service: the Linux install script starts the daemon detached instead.
        if (problem && result.kind === 'install_refused') throw new CommandError('refused', lines.join('\n'), { reason: problem.reason, fallback: 'detached', hint: problem.hint, partial });
      }
      throw new CommandError('failed', lines.join('\n'), { reason: result.kind, partial });
    }
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

export const LINGER_QUESTION = 'linger 没开：退出最后一个登录会话后，systemd 会停掉 Bot，开机也不会启动。要开吗？[Y/n] ';

/**
 * After a Linux install (3.10): linger, then how to open the web page. Enter or y agrees; n, EOF, Ctrl-C and a
 * non-terminal do not. Without an answer nothing is turned on. Returns whether linger is on now; a state that cannot
 * be read counts as off.
 */
export async function afterLinuxInstall(choice: LingerChoice, d: AfterInstallDependencies): Promise<'on' | 'off'> {
  const linger = await d.readLinger();
  const enable = linger.state !== 'on'
    && (choice === 'on' || (choice === 'ask' && linger.state === 'off' && d.interactive && await d.ask(LINGER_QUESTION)));
  let state: 'on' | 'off' = linger.state === 'on' ? 'on' : 'off';
  if (enable) {
    const enabled = await d.enableLinger();
    d.write(`${enabled.ok ? '已开 linger。' : enableFailed(enabled.detail, d.user)}\n`);
    if (enabled.ok) state = 'on';
  } else d.write(`${lingerLine(linger, d.user)}\n`);
  d.write(`${(await d.guide()).join('\n')}\n`);
  return state;
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
    afterInstall: async (choice, notes) => {
      const { serviceOpenGuide } = await import('./open');
      // --json is not a terminal either: no question, and no link with the credential
      const tty = !notes && Boolean(process.stdout.isTTY);
      return afterLinuxInstall(choice, {
        readLinger, enableLinger, ask, interactive: tty && Boolean(process.stdin.isTTY), user,
        guide: () => serviceOpenGuide(tty), write: text => { if (notes) notes.push(...text.replace(/\n$/, '').split('\n')); else process.stdout.write(text); },
      });
    },
    // linger belongs to the account and other user services may need it, so uninstall leaves it on.
    afterUninstall: async () => (await readLinger()).state === 'on' ? 'linger 没关：这个账号上别的用户服务可能也要它。不需要的话运行 loginctl disable-linger。' : undefined,
    problem: detail => userManagerProblem(detail),
    user,
  };
}

/** In a Bot's session the daemon in the lock counts as running unasked: asking it who it is sends `local-credential` (devices-4a 4.9). */
export async function runServiceStatus(json: boolean, adapter?: Pick<ServiceAdapter, 'status'>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const status = await (adapter ?? (await import('../../service/adapter')).getServiceAdapter({ trustLock: inBotSession(env) })).status();
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...status })}\n`);
    return;
  }
  process.stdout.write([
    `${status.platformName} ${status.name}: ${STATE_TEXT[status.state]}${status.running && status.pid ? ` (PID ${status.pid})` : ''}`,
    status.detail,
    ...describeServiceExits(status.exits).lines,
    ...(status.hint ? [status.hint] : []),
    ...(status.linger ? [lingerLine(status.linger, userInfo().username)] : []),
    `Definition: ${status.servicePath}`,
    `Logs: ${status.stdoutPath}, ${status.stderrPath}`,
  ].join('\n') + '\n');
}

const SKIP_UNKNOWN = '可能已经改了，运行 vonvon bot status 查看。';
/** `vonvon service skip` (cli-8-machine): the checklist's 跳过登录时启动, `--undo` its 取消跳过; the daemon keeps the choice. */
export async function runServiceSkip(skipped: boolean, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const what = skipped ? '跳过登录时启动' : '取消跳过';
  const reply = await daemon(call => call(what, c => c.machine({ type: 'setServiceSkipped', skipped }), { unknown: SKIP_UNKNOWN }));
  if (reply.type !== 'done') throw new CommandError('failed', `${what}没有完成：daemon 回了意外的结果（${reply.type}）。`);
  print(io, [reply.message], { skipped, message: reply.message });
}
