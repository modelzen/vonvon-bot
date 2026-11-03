import { execFile, type ExecFileException } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { userInfo } from 'node:os';

/** Linux only (s20a): linger keeps this account's user services running without a login session and starts them at boot. */
export type Linger = { state: 'on' | 'off' | 'unknown'; detail?: string };
export type CommandResult = { ok: boolean; stdout: string; reason?: string };
export type SessionDependencies = {
  run: (file: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
  exists: (path: string) => Promise<boolean>;
  uid: number;
  user: string;
  xdgRuntimeDir: string | undefined;
};

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? '';

/** A failure without the command line: the timeout, a missing file, the first stderr line or the exit code. */
function failureReason(file: string, timeoutMs: number, error: ExecFileException, stderr: string): string {
  if (error.killed) return `${file} 在 ${timeoutMs / 1000} 秒内没有回应`;
  if (error.code === 'ENOENT') return `找不到 ${file}`;
  const line = firstLine(stderr);
  if (line) return line;
  return typeof error.code === 'number' ? `${file} 退出码 ${error.code}` : `${file} 没有运行成功`;
}

/** Never a shell; a timeout kills the child. */
export function runCommand(file: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, stdout, reason: failureReason(file, timeoutMs, error, stderr) });
      else resolve({ ok: true, stdout });
    });
  });
}

const sessionDefaults = (): SessionDependencies => ({
  run: runCommand,
  exists: path => stat(path).then(() => true, () => false),
  uid: process.getuid?.() ?? -1,
  user: userInfo().username,
  xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
});

/**
 * loginctl answers over the system bus, so it works without XDG_RUNTIME_DIR. It refuses an account that has neither
 * a session nor linger; then the linger file decides, and without `/run/systemd/system` nothing can.
 */
export async function readLinger(d: SessionDependencies = sessionDefaults()): Promise<Linger> {
  const result = await d.run('loginctl', ['show-user', String(d.uid), '--property=Linger', '--value'], 10_000);
  const value = result.stdout.trim();
  if (result.ok && (value === 'yes' || value === 'no')) return { state: value === 'yes' ? 'on' : 'off' };
  if (await d.exists(`/var/lib/systemd/linger/${d.user}`)) return { state: 'on' };
  if (await d.exists('/run/systemd/system')) return { state: 'off' };
  return { state: 'unknown', detail: result.reason ?? `loginctl 回了 ${JSON.stringify(value.slice(0, 40))}` };
}

/** `set-self-linger` without a user name; `--no-ask-password` fails instead of waiting for a password in the terminal. */
export async function enableLinger(d: SessionDependencies = sessionDefaults()): Promise<{ ok: true } | { ok: false; detail: string }> {
  const result = await d.run('loginctl', ['--no-ask-password', 'enable-linger'], 30_000);
  if ((await readLinger(d)).state === 'on') return { ok: true };
  return { ok: false, detail: result.reason ?? 'loginctl 没报错，linger 还是没开' };
}

const sudoLinger = (user: string): string => `sudo loginctl enable-linger ${user}`;
/** The optional line (owner 2026-11-02): the command first, sudo only when the account may not do it itself. */
const lingerOffHint = (user: string): string => `需要的话运行一次 loginctl enable-linger（不行再用 ${sudoLinger(user)}）。`;
export const enableFailed = (detail: string, user: string): string => `开机自动启动没开成（${detail}），退出登录后它会停。需要的话用管理员权限运行一次：${sudoLinger(user)}`;

/** The boot-start line of `service status`, and the optional one of an install that leaves linger off. */
export function lingerLine(linger: Linger, user: string): string {
  if (linger.state === 'on') return '开机自动启动，退出登录后也继续运行。';
  if (linger.state === 'off') return `没开开机自动启动：退出登录后它会停。${lingerOffHint(user)}`;
  return `查不到能不能开机自动启动：${linger.detail ?? '原因不明'}。${lingerOffHint(user)}`;
}

/** server-2 4.4: the three causes `service install --json` names in `reason`, for the install script's fallback. */
export type UserManagerProblem = { reason: 'no_systemd' | 'user_instance_down' | 'no_runtime_dir'; hint: string };
/** What systemctl says without systemd as PID 1, or when it is not installed at all. */
const NO_SYSTEMD = /has not been booted with systemd|spawn systemctl ENOENT/;
/** What systemctl says when it cannot connect to the user manager: systemd 255 "Failed to connect to bus: …", 256 and later "Failed to connect to user scope bus …". */
const NO_CONNECTION = /Failed to connect to (?:user scope )?bus/;

/**
 * Why `systemctl --user` cannot be asked, when it is one of the three common cases; undefined otherwise. `detail` is
 * what systemctl answered, if it was asked.
 */
export async function userManagerProblem(detail = '', d: SessionDependencies = sessionDefaults()): Promise<UserManagerProblem | undefined> {
  if (NO_SYSTEMD.test(detail) || !(await d.exists('/run/systemd/system'))) {
    return { reason: 'no_systemd', hint: '这台机器不是用 systemd 启动的（容器里常见），装不了 systemd 用户服务。用 vonvon daemon start 起一个分离的 daemon；它崩溃后不会自动重启。' };
  }
  const runtime = `/run/user/${d.uid}`;
  // The user manager's own socket; the D-Bus one is there only with dbus-user-session.
  const socket = await d.exists(`${runtime}/systemd/private`) || await d.exists(`${runtime}/bus`);
  if (d.xdgRuntimeDir !== runtime && socket) {
    return { reason: 'no_runtime_dir', hint: `当前终端没有 XDG_RUNTIME_DIR（用 sudo -u 或 su 切到这个账号时常见），连不上这个账号的 systemd。运行 export XDG_RUNTIME_DIR=${runtime} 再试，或者直接用这个账号 SSH 登录。` };
  }
  if (!(await d.exists(runtime))) return { reason: 'user_instance_down', hint: `这个账号的 systemd 用户实例没在运行：没有登录会话，也没开 linger。用这个账号 SSH 登录后再试；或者先开 linger：loginctl enable-linger（不行就 ${sudoLinger(d.user)}）。` };
  // The directory outlives a user manager that failed to start or has exited: no socket in it, or one nobody answers.
  if (!socket || NO_CONNECTION.test(detail)) {
    return { reason: 'user_instance_down', hint: `这个账号的 systemd 用户实例没在运行：${runtime} 还在，但里面的用户实例连不上（没起来，或者已经退出）。用这个账号重新 SSH 登录后再试；还不行，用管理员权限看 systemctl status user@${d.uid}。` };
  }
  return undefined;
}

export async function userManagerHint(d: SessionDependencies = sessionDefaults()): Promise<string | undefined> {
  return (await userManagerProblem('', d))?.hint;
}
