import { expect, it, vi } from 'vitest';
import { enableLinger, lingerLine, readLinger, runCommand, userManagerHint, userManagerProblem, type CommandResult, type SessionDependencies } from '../src/service/linux-session';

/** A fake loginctl that answers `show-user` from the list, one answer per call (the last repeats), and a fake file system. */
function session(answers: CommandResult[], files: string[] = ['/run/systemd/system'], fields: Partial<SessionDependencies> = {}) {
  const queue = [...answers];
  const run = vi.fn(async (_file: string, args: string[]): Promise<CommandResult> => args[0] === 'show-user' ? (queue.length > 1 ? queue.shift() : queue[0]) ?? { ok: false, stdout: '' } : { ok: false, stdout: '', reason: 'Access denied' });
  const d: SessionDependencies = { run, exists: async path => files.includes(path), uid: 1000, user: 'ops', xdgRuntimeDir: '/run/user/1000', ...fields };
  return { run, d };
}
const yes = { ok: true, stdout: 'yes\n' };
const no = { ok: true, stdout: 'no\n' };

it('reads linger from loginctl, then from the linger file, and says when neither answers', async () => {
  const on = session([yes]);
  expect(await readLinger(on.d)).toEqual({ state: 'on' });
  expect(on.run).toHaveBeenCalledWith('loginctl', ['show-user', '1000', '--property=Linger', '--value'], 10_000);
  expect(await readLinger(session([no]).d)).toEqual({ state: 'off' });
  const refused = { ok: false, stdout: '', reason: 'User 1000 is not logged in or lingering.' };
  expect(await readLinger(session([refused], ['/var/lib/systemd/linger/ops']).d)).toEqual({ state: 'on' });
  expect(await readLinger(session([refused]).d)).toEqual({ state: 'off' });
  expect(await readLinger(session([refused], []).d)).toEqual({ state: 'unknown', detail: 'User 1000 is not logged in or lingering.' });
  expect(await readLinger(session([{ ok: true, stdout: 'maybe' }], []).d)).toEqual({ state: 'unknown', detail: 'loginctl 回了 "maybe"' });
});

it('turns linger on for this account without a password prompt, and gives the sudo command when it stays off', async () => {
  const done = session([yes]);
  expect(await enableLinger(done.d)).toEqual({ ok: true });
  expect(done.run).toHaveBeenCalledWith('loginctl', ['--no-ask-password', 'enable-linger'], 30_000);
  const denied = session([no]);
  expect(await enableLinger(denied.d)).toEqual({ ok: false, detail: 'Access denied' });
  expect(lingerLine({ state: 'off' }, 'ops')).toBe('没开 linger：退出最后一个登录会话后 Bot 会停，开机也不启动。要开就运行 loginctl enable-linger（不行再用 sudo loginctl enable-linger ops）。');
  expect(lingerLine({ state: 'unknown', detail: '找不到 loginctl' }, 'ops')).toMatch(/^查不到 linger 的状态：找不到 loginctl。要开就运行/);
});

it('describes a command that times out, is missing or fails without its command line', async () => {
  expect(await runCommand('sleep', ['5'], 50)).toEqual({ ok: false, stdout: '', reason: 'sleep 在 0.05 秒内没有回应' });
  expect(await runCommand('vonvon-no-such-command', [], 1_000)).toMatchObject({ ok: false, reason: '找不到 vonvon-no-such-command' });
  expect(await runCommand(process.execPath, ['-e', 'process.stderr.write("first\\nsecond"); process.exit(4)'], 5_000)).toMatchObject({ ok: false, reason: 'first' });
  expect(await runCommand(process.execPath, ['-e', 'process.exit(4)'], 5_000)).toMatchObject({ ok: false, reason: `${process.execPath} 退出码 4` });
});

it('names the three common reasons the user manager cannot be asked, and nothing otherwise', async () => {
  const hint = (files: string[], xdgRuntimeDir?: string) => userManagerHint(session([yes], files, { xdgRuntimeDir }).d);
  expect(await hint([])).toMatch(/^这台机器不是用 systemd 启动的/);
  expect(await hint(['/run/systemd/system', '/run/user/1000', '/run/user/1000/bus'])).toContain('export XDG_RUNTIME_DIR=/run/user/1000');
  expect(await hint(['/run/systemd/system', '/run/user/1000', '/run/user/1000/bus'], '/tmp/elsewhere')).toContain('export XDG_RUNTIME_DIR=/run/user/1000');
  expect(await hint(['/run/systemd/system'], '/run/user/1000')).toContain('sudo loginctl enable-linger ops');
  expect(await hint(['/run/systemd/system', '/run/user/1000', '/run/user/1000/bus'], '/run/user/1000')).toBeUndefined();
});

// main 必败: the causes had no stable names the install script could act on (server-2 4.4)
it('names each common cause with a stable reason, and takes systemctl at its word when it has no systemd', async () => {
  const problem = (files: string[], xdgRuntimeDir?: string, detail = '') => userManagerProblem(detail, session([yes], files, { xdgRuntimeDir }).d);
  expect(await problem([])).toMatchObject({ reason: 'no_systemd', hint: expect.stringMatching(/^这台机器不是用 systemd 启动的/) });
  expect(await problem(['/run/systemd/system', '/run/user/1000', '/run/user/1000/bus'])).toMatchObject({ reason: 'no_runtime_dir' });
  expect(await problem(['/run/systemd/system'], '/run/user/1000')).toMatchObject({ reason: 'user_instance_down' });
  const up = ['/run/systemd/system', '/run/user/1000', '/run/user/1000/bus'];
  expect(await problem(up, '/run/user/1000')).toBeUndefined();
  // a container that still has the directory, or a machine without systemctl
  expect(await problem(up, '/run/user/1000', "User manager unavailable: System has not been booted with systemd as init system (PID 1). Can't operate.")).toMatchObject({ reason: 'no_systemd' });
  expect(await problem(up, '/run/user/1000', 'User manager unavailable: spawn systemctl ENOENT')).toMatchObject({ reason: 'no_systemd' });
});

// review 216/218: /run/user/<uid> outlives a user manager that failed or exited. systemctl then cannot connect, and
// with no reason named the install script stopped instead of starting the daemon directly.
it('a runtime directory whose user manager cannot be reached is user_instance_down', async () => {
  const problem = (files: string[], xdgRuntimeDir?: string, detail = '') => userManagerProblem(detail, session([yes], files, { xdgRuntimeDir }).d);
  const directory = ['/run/systemd/system', '/run/user/1000'];
  const missing = 'User manager unavailable: Failed to connect to bus: No such file or directory';
  for (const xdgRuntimeDir of [undefined, '/run/user/1000']) {
    expect(await problem(directory, xdgRuntimeDir, missing)).toMatchObject({ reason: 'user_instance_down', hint: expect.stringContaining('/run/user/1000 还在') });
  }
  // systemd 256 and later name the scope
  expect(await problem(directory, '/run/user/1000', 'User manager unavailable: Failed to connect to user scope bus via local transport: No such file or directory')).toMatchObject({ reason: 'user_instance_down' });
  // sockets left behind by a manager that exited
  const left = [...directory, '/run/user/1000/bus', '/run/user/1000/systemd/private'];
  expect(await problem(left, '/run/user/1000', 'User manager unavailable: Failed to connect to bus: Connection refused')).toMatchObject({ reason: 'user_instance_down' });
  // service status asks without an answer from systemctl: no socket at all says it
  expect(await userManagerHint(session([yes], directory, { xdgRuntimeDir: '/run/user/1000' }).d)).toBe('这个账号的 systemd 用户实例没在运行：/run/user/1000 还在，但里面的用户实例连不上（没起来，或者已经退出）。用这个账号重新 SSH 登录后再试；还不行，用管理员权限看 systemctl status user@1000。');
  // the manager's own socket without dbus-user-session's bus: what is missing is XDG_RUNTIME_DIR
  expect(await problem([...directory, '/run/user/1000/systemd/private'], undefined, 'User manager unavailable: Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined')).toMatchObject({ reason: 'no_runtime_dir' });
  // a manager that answers is not a cause the script can work around
  expect(await problem(left, '/run/user/1000', 'User manager unavailable: stopping')).toBeUndefined();
});
