import { execFile } from 'node:child_process';
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

/** Never a shell; a failure is described without the command line, and a timeout kills the child. */
export function runCommand(file: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) { resolve({ ok: true, stdout }); return; }
      const code = (error as NodeJS.ErrnoException).code;
      const reason = error.killed ? `${file} 在 ${timeoutMs / 1000} 秒内没有回应`
        : code === 'ENOENT' ? `找不到 ${file}`
        : firstLine(stderr) || (typeof code === 'number' ? `${file} 退出码 ${code}` : `${file} 没有运行成功`);
      resolve({ ok: false, stdout, reason });
    });
  });
}

export const sessionDefaults = (): SessionDependencies => ({
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
export const lingerOffHint = (user: string): string => `要开就运行 loginctl enable-linger（不行再用 ${sudoLinger(user)}）。`;
export const enableFailed = (detail: string, user: string): string => `没开成：${detail}。用管理员权限运行：${sudoLinger(user)}`;

/** The linger line of `service status` and of an install that leaves it alone. */
export function lingerLine(linger: Linger, user: string): string {
  if (linger.state === 'on') return 'linger 已开：开机就启动，退出 SSH 以后 bot 也还在跑。';
  if (linger.state === 'off') return `没开 linger：退出最后一个登录会话后 bot 会停，开机也不启动。${lingerOffHint(user)}`;
  return `查不到 linger 的状态：${linger.detail ?? '原因不明'}。${lingerOffHint(user)}`;
}

/** Why `systemctl --user` cannot be asked, when it is one of the three common cases; undefined otherwise. */
export async function userManagerHint(d: SessionDependencies = sessionDefaults()): Promise<string | undefined> {
  if (!(await d.exists('/run/systemd/system'))) return '这台机器不是用 systemd 启动的（容器里常见），装不了 systemd 用户服务。用 vonvon daemon start 起一个分离的 daemon；它崩溃后不会自动重启。';
  const runtime = `/run/user/${d.uid}`;
  if (d.xdgRuntimeDir !== runtime && await d.exists(`${runtime}/bus`)) {
    return `当前终端没有 XDG_RUNTIME_DIR（用 sudo -u 或 su 切到这个账号时常见），连不上这个账号的 systemd。运行 export XDG_RUNTIME_DIR=${runtime} 再试，或者直接用这个账号 SSH 登录。`;
  }
  if (!(await d.exists(runtime))) return `这个账号的 systemd 用户实例没在运行：没有登录会话，也没开 linger。用这个账号 SSH 登录后再试；或者先开 linger：loginctl enable-linger（不行就 ${sudoLinger(d.user)}）。`;
  return undefined;
}
