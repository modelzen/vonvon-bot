import { expect, it, vi } from 'vitest';
import { enableLinger, lingerLine, readLinger, runCommand, userManagerHint, type CommandResult, type SessionDependencies } from '../src/service/linux-session';

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
  expect(lingerLine({ state: 'off' }, 'ops')).toBe('没开 linger：退出最后一个登录会话后 bot 会停，开机也不启动。要开就运行 loginctl enable-linger（不行再用 sudo loginctl enable-linger ops）。');
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
