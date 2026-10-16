import { describe, expect, it } from 'vitest';
import { describeServiceExits, parseLaunchdExits, parseSystemdExits, type ServiceExits } from '../src/service/exits';

// The top-level lines Mac task 14 (PR #347) grepped from `launchctl print`, inside the nested blocks a real print has.
const job = 'gui/501/com.vonvon.bot.daemon.e98fa41ea52b';
const print = (...top: string[]): string => [
  `${job} = {`, '\tactive count = 1', '\ttype = LaunchAgent', ...top,
  '\tresource coalition = {', '\t\tstate = active', '\t}', '\tjetsam coalition = {', '\t\tstate = active', '\t}', '}', '',
].join('\n');
const LAUNCHD = {
  firstLoad: print('\tstate = running', '\truns = 1', '\tpid = 71791', '\tlast exit code = (never exited)'),
  killed: print('\tstate = running', '\truns = 4', '\tpid = 72218', '\tlast terminating signal = Killed: 9'),
  restarted: print('\tstate = running', '\truns = 5', '\tpid = 73760', '\tlast exit code = 75: EX_TEMPFAIL'),
  stopped: print('\tstate = not running', '\truns = 5', '\tlast exit code = 0'),
};

// `systemctl --user show -p LoadState -p Result -p ExecMainCode -p ExecMainStatus -p ExecMainExitTimestamp -p NRestarts`
// as systemd 255 printed it on JP-VPS (design s17b §0), in the order systemctl prints the properties.
const show = (result: string, code: number, status: number, at: string, restarts: number, loadState = 'loaded'): string =>
  `Result=${result}\nNRestarts=${restarts}\nExecMainExitTimestamp=${at}\nExecMainCode=${code}\nExecMainStatus=${status}\nLoadState=${loadState}\n`;
const AT = 'Fri 2026-10-16 14:19:07 UTC';
const SYSTEMD = {
  running: show('success', 0, 0, '', 0),
  killedWaiting: show('signal', 2, 9, AT, 0),
  restartedRunning: show('success', 0, 0, '', 1),
  exitedZero: show('success', 1, 0, AT, 1),
  sigterm: show('success', 2, 15, AT, 1),
  startLimit: show('exit-code', 1, 70, AT, 5),
  notFound: show('success', 0, 0, '', 0, 'not-found'),
};

describe('parseLaunchdExits', () => {
  it('reads the four states Mac task 14 recorded', () => {
    expect(parseLaunchdExits(LAUNCHD.firstLoad)).toEqual({ manager: 'launchd', runs: 1, lastExitCode: null, lastExitText: '(never exited)', lastSignal: null });
    expect(parseLaunchdExits(LAUNCHD.killed)).toEqual({ manager: 'launchd', runs: 4, lastExitCode: null, lastExitText: null, lastSignal: 'Killed: 9' });
    expect(parseLaunchdExits(LAUNCHD.restarted)).toEqual({ manager: 'launchd', runs: 5, lastExitCode: 75, lastExitText: '75: EX_TEMPFAIL', lastSignal: null });
    expect(parseLaunchdExits(LAUNCHD.stopped)).toEqual({ manager: 'launchd', runs: 5, lastExitCode: 0, lastExitText: '0', lastSignal: null });
  });
  it('ignores nested lines, nulls a repeated or unreadable key, and is undefined without any of the three', () => {
    expect(parseLaunchdExits(print('\tstate = running', '\truns = 2', '\tnested = {', '\t\tlast exit code = 3', '\t\truns = 9', '\t}'))).toEqual({ manager: 'launchd', runs: 2, lastExitCode: null, lastExitText: null, lastSignal: null });
    expect(parseLaunchdExits(print('\truns = 2', '\truns = 3', '\tlast exit code = 1', '\tlast exit code = 1'))).toMatchObject({ runs: null, lastExitCode: null, lastExitText: null });
    expect(parseLaunchdExits(print('\tstate = running', '\tpid = 4'))).toBeUndefined();
    expect(parseLaunchdExits(print('\truns = abc', '\tlast exit code = weird'))).toEqual({ manager: 'launchd', runs: null, lastExitCode: null, lastExitText: 'weird', lastSignal: null });
    expect(parseLaunchdExits(print(`\tlast terminating signal = ${'x'.repeat(200)}`))).toMatchObject({ lastSignal: 'x'.repeat(60) });
  });
});

describe('parseSystemdExits', () => {
  it('reads the JP-VPS samples; a unit systemd does not know has no record', () => {
    expect(parseSystemdExits(SYSTEMD.running)).toEqual({ manager: 'systemd', result: 'success', execMainCode: 0, execMainStatus: 0, nRestarts: 0, exitedAt: null });
    expect(parseSystemdExits(SYSTEMD.killedWaiting)).toEqual({ manager: 'systemd', result: 'signal', execMainCode: 2, execMainStatus: 9, nRestarts: 0, exitedAt: AT });
    expect(parseSystemdExits(SYSTEMD.exitedZero)).toMatchObject({ result: 'success', execMainCode: 1, execMainStatus: 0, nRestarts: 1, exitedAt: AT });
    expect(parseSystemdExits(SYSTEMD.sigterm)).toMatchObject({ execMainCode: 2, execMainStatus: 15 });
    expect(parseSystemdExits(SYSTEMD.startLimit)).toMatchObject({ result: 'exit-code', execMainCode: 1, execMainStatus: 70, nRestarts: 5 });
    expect(parseSystemdExits(SYSTEMD.notFound)).toBeUndefined();
    expect(parseSystemdExits('Result=success\nExecMainCode=1\n')).toBeUndefined();
  });
  it('nulls what an older or odd systemd prints instead of failing', () => {
    expect(parseSystemdExits('LoadState=loaded\nResult=success\nExecMainCode=1\nExecMainStatus=0\nExecMainExitTimestamp=\n')).toMatchObject({ nRestarts: null, exitedAt: null });
    expect(parseSystemdExits('LoadState=loaded\nResult=Bad Value\nExecMainCode=x\nExecMainStatus=-1\nNRestarts=1\nNRestarts=2\n')).toEqual({ manager: 'systemd', result: null, execMainCode: null, execMainStatus: null, nRestarts: null, exitedAt: null });
    expect(parseSystemdExits('LoadState=loaded\n')).toBeUndefined();
  });
});

describe('describeServiceExits', () => {
  const launchd = (raw: string) => describeServiceExits(parseLaunchdExits(raw));
  const systemd = (raw: string) => describeServiceExits(parseSystemdExits(raw));
  it('says what launchd remembers, word for word', () => {
    expect(launchd(LAUNCHD.firstLoad)).toEqual({ lastExit: '还没有退出过', lines: ['上次退出：还没有退出过', '启动次数：1（launchd 从这次登录或安装服务算起）'] });
    expect(launchd(LAUNCHD.killed)).toEqual({ lastExit: '被信号结束（Killed: 9，kill -9 或内存不够）', lines: ['上次退出：被信号结束（Killed: 9，kill -9 或内存不够）', '启动次数：4（launchd 从这次登录或安装服务算起）'] });
    expect(launchd(LAUNCHD.restarted).lastExit).toBe('退出码 75（重启：daemon restart、网页的重启或更新）');
    expect(launchd(LAUNCHD.stopped).lastExit).toBe('退出码 0（正常退出）');
    expect(launchd(print('\tlast terminating signal = Terminated: 15')).lastExit).toBe('被正常停止（Terminated: 15）');
    expect(launchd(print('\tlast exit code = weird'))).toEqual({ lastExit: 'launchd：weird', lines: ['上次退出：launchd：weird'] });
    expect(describeServiceExits(undefined)).toEqual({ lines: [] });
  });
  const RESTARTS = (n: number) => `自动重启：${n} 次（systemd 从上次启动服务算起，崩溃后拉起和 vonvon daemon restart 都算）`;
  it('says what systemd remembers, word for word', () => {
    expect(systemd(SYSTEMD.exitedZero)).toEqual({ lastExit: `退出码 0（正常退出）。systemd：Result=success，${AT}`, lines: [`上次退出：退出码 0（正常退出）。systemd：Result=success，${AT}`, RESTARTS(1)] });
    expect(systemd(SYSTEMD.startLimit).lastExit).toBe(`退出码 70（程序崩溃，看 vonvon daemon status）。systemd：Result=exit-code，${AT}`);
    expect(systemd(show('exit-code', 1, 75, AT, 0)).lastExit).toBe(`退出码 75（重启：daemon restart、网页的重启或更新）。systemd：Result=exit-code，${AT}`);
    expect(systemd(show('exit-code', 1, 1, AT, 0)).lastExit).toBe(`退出码 1（出错退出，看 service.err.log）。systemd：Result=exit-code，${AT}`);
    expect(systemd(show('exit-code', 1, 3, AT, 0)).lastExit).toBe(`退出码 3。systemd：Result=exit-code，${AT}`);
    expect(systemd(SYSTEMD.killedWaiting).lastExit).toBe(`被信号 SIGKILL（9）结束（kill -9 或内存不够）。systemd：Result=signal，${AT}`);
    expect(systemd(SYSTEMD.sigterm).lastExit).toBe(`被正常停止（SIGTERM）。systemd：Result=success，${AT}`);
    expect(systemd(show('core-dump', 3, 11, AT, 0)).lastExit).toBe(`被信号 SIGSEGV（11）结束，留下了 core dump。systemd：Result=core-dump，${AT}`);
    expect(systemd(show('oom-kill', 2, 9, AT, 0)).lastExit).toBe(`被信号 SIGKILL（9）结束（kill -9 或内存不够）。systemd：Result=oom-kill（内存不够，被系统结束），${AT}`);
    expect(systemd(show('start-limit-hit', 1, 70, '', 5)).lastExit).toBe('退出码 70（程序崩溃，看 vonvon daemon status）。systemd：Result=start-limit-hit（启动太频繁，systemd 不再拉起）');
  });
  it('has no last exit while the service runs: says why after a restart, only the count before one', () => {
    // The web page's 上次退出 says the same as the command, not 无记录.
    const kept = '服务在运行时 systemd 不保留，崩溃记录看 vonvon daemon status';
    expect(systemd(show('success', 0, 0, '', 2))).toEqual({ lastExit: kept, lines: [`上次退出：${kept}`, RESTARTS(2)] });
    expect(systemd(SYSTEMD.restartedRunning).lastExit).toBe(kept);
    expect(systemd(SYSTEMD.running)).toEqual({ lines: [RESTARTS(0)] });
    // A unit that only fails, on JP-VPS after the s17b review: when the restarts run out (a refused manual start
    // changes nothing) the record stays; reset-failed clears it and the count together, so a stopped unit never
    // gets the 运行时 line.
    expect(systemd(show('exit-code', 1, 1, AT, 3))).toEqual({ lastExit: `退出码 1（出错退出，看 service.err.log）。systemd：Result=exit-code，${AT}`, lines: [`上次退出：退出码 1（出错退出，看 service.err.log）。systemd：Result=exit-code，${AT}`, RESTARTS(3)] });
    expect(systemd(show('success', 0, 0, '', 0))).toEqual({ lines: [RESTARTS(0)] });
    const unknownSignal: ServiceExits = { manager: 'systemd', result: null, execMainCode: 2, execMainStatus: 99, nRestarts: null, exitedAt: null };
    expect(describeServiceExits(unknownSignal)).toEqual({ lastExit: '被信号 99 结束', lines: ['上次退出：被信号 99 结束'] });
  });
});
