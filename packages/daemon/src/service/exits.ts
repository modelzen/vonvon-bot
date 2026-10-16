import { constants } from 'node:os';
import { CRASH_EXIT_CODE } from '../host/crash-store';

/**
 * s17b: what launchd or systemd remembers about the daemon's exits, as `launchctl print` and `systemctl show` print
 * it. A field that is missing, repeated or unreadable is null.
 */
export type ServiceExits =
  | { manager: 'launchd'; runs: number | null; lastExitCode: number | null; lastExitText: string | null; lastSignal: string | null }
  | { manager: 'systemd'; result: string | null; execMainCode: number | null; execMainStatus: number | null; nRestarts: number | null; exitedAt: string | null };

/** The exit codes the daemon itself uses. 75 is `process.exitCode = 75` in `host/lifecycle.ts`. */
const DAEMON_EXIT_TEXT: Record<number, string> = {
  0: '正常退出',
  1: '出错退出，看 service.err.log',
  [CRASH_EXIT_CODE]: '程序崩溃，看 vonvon daemon status',
  75: '重启：daemon restart、网页的重启或更新',
};
const RESULT_TEXT: Record<string, string> = {
  'oom-kill': '内存不够，被系统结束',
  'start-limit-hit': '启动太频繁，systemd 不再拉起',
};
const LAUNCHD_KEYS = ['runs', 'last exit code', 'last terminating signal'] as const;
const SYSTEMD_KEYS = ['Result', 'ExecMainCode', 'ExecMainStatus', 'ExecMainExitTimestamp', 'NRestarts'] as const;

const count = (text: string | null | undefined): number | null => {
  if (text == null || !/^\d{1,9}$/.test(text)) return null;
  return Number(text);
};
const clip = (text: string | null | undefined, max: number): string | null => text ? text.slice(0, max) : null;

/** Reads one `KEY<sep>VALUE` per line; a key seen twice is null. */
function fields(lines: Iterable<[string, string]>): Map<string, string | null> {
  const found = new Map<string, string | null>();
  for (const [key, value] of lines) found.set(key, found.has(key) ? null : value);
  return found;
}

/** From the `launchctl print gui/<uid>/<label>` that `observeJob()` already read: only the job's own top-level lines. */
export function parseLaunchdExits(raw: string): ServiceExits | undefined {
  try {
    const lines = function* (): Generator<[string, string]> {
      for (const line of raw.split('\n')) {
        const match = /^\t(?!\t)(runs|last exit code|last terminating signal) = (.*)$/.exec(line);
        if (match?.[1] && match[2] !== undefined) yield [match[1], match[2]];
      }
    };
    const found = fields(lines());
    if (!LAUNCHD_KEYS.some(key => found.has(key))) return undefined;
    const exitText = clip(found.get('last exit code'), 60);
    const code = exitText ? /^(\d{1,9})(?:: .+)?$/.exec(exitText)?.[1] : undefined;
    return {
      manager: 'launchd', runs: count(found.get('runs')),
      lastExitCode: code === undefined ? null : Number(code), lastExitText: exitText, lastSignal: clip(found.get('last terminating signal'), 60),
    };
  } catch { return undefined; }
}

/** From `systemctl --user show -p LoadState -p Result -p ExecMainCode -p ExecMainStatus -p ExecMainExitTimestamp -p NRestarts`. */
export function parseSystemdExits(stdout: string): ServiceExits | undefined {
  try {
    const lines = function* (): Generator<[string, string]> {
      for (const line of stdout.split('\n')) {
        const match = /^([A-Za-z]+)=(.*)$/.exec(line);
        if (match?.[1] && match[2] !== undefined) yield [match[1], match[2]];
      }
    };
    const found = fields(lines());
    // A unit systemd does not know still prints every property, with default values.
    const loadState = found.get('LoadState');
    if (!loadState || loadState === 'not-found' || !SYSTEMD_KEYS.some(key => found.has(key))) return undefined;
    const result = found.get('Result');
    return {
      manager: 'systemd', result: result && /^[a-z-]{1,40}$/.test(result) ? result : null,
      execMainCode: count(found.get('ExecMainCode')), execMainStatus: count(found.get('ExecMainStatus')),
      nRestarts: count(found.get('NRestarts')), exitedAt: clip(found.get('ExecMainExitTimestamp'), 64),
    };
  } catch { return undefined; }
}

function exitCodeText(code: number): string {
  const note = DAEMON_EXIT_TEXT[code];
  return note ? `退出码 ${code}（${note}）` : `退出码 ${code}`;
}

function signalText(signal: number, core: boolean): string {
  if (signal === constants.signals.SIGTERM && !core) return '被正常停止（SIGTERM）';
  const name = Object.entries(constants.signals).find(([, value]) => value === signal)?.[0];
  const text = `被信号 ${name ? `${name}（${signal}）` : `${signal} `}结束`;
  if (core) return `${text}，留下了 core dump`;
  return signal === constants.signals.SIGKILL ? `${text}（kill -9 或内存不够）` : text;
}

/** launchd prints the signal as `Killed: 9` or `Terminated: 15`. */
function launchdSignalText(raw: string): string {
  const signal = Number(/: (\d{1,3})$/.exec(raw)?.[1]);
  if (signal === constants.signals.SIGTERM) return `被正常停止（${raw}）`;
  return signal === constants.signals.SIGKILL ? `被信号结束（${raw}，kill -9 或内存不够）` : `被信号结束（${raw}）`;
}

/**
 * The 上次退出 and restart-count lines of `vonvon service status`, and `lastExit` (also the 上次退出 row of the web page):
 * how the previous daemon process ended, when the manager still knows it.
 */
export function describeServiceExits(exits: ServiceExits | undefined): { lastExit?: string; lines: string[] } {
  if (!exits) return { lines: [] };
  if (exits.manager === 'launchd') {
    const lastExit = exits.lastSignal ? launchdSignalText(exits.lastSignal)
      : exits.lastExitCode !== null ? exitCodeText(exits.lastExitCode)
        : exits.lastExitText === '(never exited)' ? '还没有退出过'
          : exits.lastExitText ? `launchd：${exits.lastExitText}` : undefined;
    return {
      ...(lastExit ? { lastExit } : {}),
      lines: [
        ...(lastExit ? [`上次退出：${lastExit}`] : []),
        ...(exits.runs !== null ? [`启动次数：${exits.runs}（launchd 从这次登录或安装服务算起）`] : []),
      ],
    };
  }
  const restarts = exits.nRestarts !== null ? [`自动重启：${exits.nRestarts} 次（systemd 从上次启动服务算起，崩溃后拉起和 vonvon daemon restart 都算）`] : [];
  const code = exits.execMainCode;
  const status = exits.execMainStatus;
  if ((code === 1 || code === 2 || code === 3) && status !== null) {
    const how = code === 1 ? exitCodeText(status) : signalText(status, code === 3);
    const result = exits.result ? `Result=${exits.result}${RESULT_TEXT[exits.result] ? `（${RESULT_TEXT[exits.result]}）` : ''}` : null;
    const record = [result, exits.exitedAt].filter(Boolean).join('，');
    const lastExit = record ? `${how}。systemd：${record}` : how;
    return { lastExit, lines: [`上次退出：${lastExit}`, ...restarts] };
  }
  // A new process clears the record: while the service runs, only the restart count is left.
  const kept = code === 0 && exits.nRestarts !== null && exits.nRestarts > 0 ? ['上次退出：服务在运行时 systemd 不保留，崩溃记录看 vonvon daemon status'] : [];
  return { lines: [...kept, ...restarts] };
}
