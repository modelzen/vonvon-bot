import { expect, it, vi } from 'vitest';
import { browserCommand, buildOpenUrl, openGuide, runOpen, type GuideInput } from '../src/cli/commands/open';

const credential = 'ab'.repeat(32);
const input = (fields: Partial<GuideInput> = {}): GuideInput => ({
  listen: '127.0.0.1:41234', credential, tty: true, sshConnection: '198.51.100.7 52100 203.0.113.5 22', user: 'ops', host: 'vps1', credentialPath: '~/.vonvon-bot/local-credential', ...fields,
});
const HEX64 = /[0-9a-f]{64}/i;

it('keeps the loopback and credential checks of the URL', () => {
  expect(buildOpenUrl('127.0.0.1:41234', credential)).toBe(`http://127.0.0.1:41234/#credential=${credential}`);
  expect(() => buildOpenUrl('0.0.0.0:41234', credential)).toThrow('Daemon is not listening on loopback.');
  expect(() => buildOpenUrl('127.0.0.1:41234', 'short')).toThrow('Invalid local daemon credential.');
});

it('prints the address, the forward to the same port and how to replace a leaked link', () => {
  expect(openGuide(input())).toEqual([
    '网页地址（带着这台主机的本机凭据，别贴给别人，也别贴进聊天、工单和截图）：',
    `  http://127.0.0.1:41234/#credential=${credential}`,
    'daemon 只听 127.0.0.1:41234。在你自己的电脑上开一条 SSH 转发：',
    '  ssh -N -L 41234:127.0.0.1:41234 ops@203.0.113.5',
    '再在那台电脑的浏览器里打开上面的地址。把 ops@203.0.113.5 换成你平时 ssh 到这台主机的写法；你电脑上的 41234 被占了，就把转发前一个 41234 和地址里的端口一起换掉。',
    '链接泄露了：vonvon daemon stop，删掉 ~/.vonvon-bot/local-credential，再 vonvon daemon start，凭据就换了。',
  ]);
});

it('adds -p for another SSH port and falls back to a placeholder and the host name without SSH_CONNECTION', () => {
  expect(openGuide(input({ sshConnection: '198.51.100.7 52100 2001:db8::5 2222' }))[3]).toBe('  ssh -N -L 41234:127.0.0.1:41234 -p 2222 ops@2001:db8::5');
  const local = openGuide(input({ sshConnection: undefined }));
  expect(local[3]).toBe('  ssh -N -L 41234:127.0.0.1:41234 ops@<这台主机的地址>（这台主机叫 vps1）');
  expect(local[4]).toContain('把 ops@<这台主机的地址> 换成');
});

it('leaves the credential out when stdout is not a terminal', () => {
  const lines = openGuide(input({ tty: false }));
  expect(lines.join('\n')).not.toMatch(HEX64);
  expect(lines.slice(0, 3)).toEqual(['网页地址：', '  http://127.0.0.1:41234/', '带凭据的链接没打印：输出不是终端，可能会进日志。在终端里直接运行 vonvon open --print。']);
  expect(lines).toContain('  ssh -N -L 41234:127.0.0.1:41234 ops@203.0.113.5');
});

function opener(fields: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; tty?: boolean; launch?: (file: string, args: string[]) => Promise<unknown> } = {}) {
  let out = '';
  const launch = vi.fn(fields.launch ?? (async () => undefined));
  const open = (print = false) => runOpen(print, {
    listen: async () => '127.0.0.1:41234', credential: async () => credential, launch,
    platform: fields.platform ?? 'linux', env: fields.env ?? { DISPLAY: ':0' }, tty: fields.tty ?? false, write: text => { out += text; },
  });
  return { open, launch, out: () => out };
}

it('prints instead of starting a browser with --print or on a Linux without a display', async () => {
  for (const [print, env] of [[true, { DISPLAY: ':0' }], [false, {}]] as const) {
    const o = opener({ env });
    await o.open(print);
    expect(o.launch).not.toHaveBeenCalled();
    expect(o.out()).toContain('ssh -N -L 41234:127.0.0.1:41234');
    expect(o.out()).not.toMatch(HEX64);
  }
  const wayland = opener({ env: { WAYLAND_DISPLAY: 'wayland-0' } });
  await wayland.open();
  expect(wayland.launch).toHaveBeenCalledWith('xdg-open', [`http://127.0.0.1:41234/#credential=${credential}`]);
  const tty = opener({ env: {}, tty: true });
  await tty.open();
  expect(tty.out()).toContain(`#credential=${credential}`);
});

it('reports a failed browser launch without the command line that holds the credential', async () => {
  const failure = Object.assign(new Error(`Command failed: xdg-open http://127.0.0.1:41234/#credential=${credential}`), { code: 3 });
  const linux = opener({ launch: async () => { throw failure; } });
  const error = await linux.open().catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('没能打开浏览器：xdg-open 退出码 3。运行 vonvon open --print 手动打开。');
  const mac = opener({ platform: 'darwin', env: {}, launch: async () => { throw Object.assign(new Error(`spawn open ENOENT ${credential}`), { code: 'ENOENT' }); } });
  await expect(mac.open()).rejects.toThrow(/^没能打开浏览器：open：ENOENT。/);
  expect(mac.launch).toHaveBeenCalledWith('open', expect.any(Array));
});

it('I4a: opens the browser on Windows with rundll32 url.dll,FileProtocolHandler, never through cmd.exe', async () => {
  const windows = opener({ platform: 'win32', env: {} });
  await windows.open();
  expect(windows.launch).toHaveBeenCalledExactlyOnceWith('rundll32.exe', ['url.dll,FileProtocolHandler', `http://127.0.0.1:41234/#credential=${credential}`]);
  const printed = opener({ platform: 'win32', env: {} });
  await printed.open(true);
  expect(printed.launch).not.toHaveBeenCalled();
});

it('I4a: a Windows URL with whitespace or a cmd.exe metacharacter is refused before anything starts', () => {
  for (const url of ['http://127.0.0.1:41234/#a&b', 'http://127.0.0.1:41234/a b', 'http://127.0.0.1:41234/"x', 'http://127.0.0.1:41234/a|b', 'http://127.0.0.1:41234/a^b', 'http://127.0.0.1:41234/<x>', 'http://example.com/', 'http://127.0.0.1:41234/\nx']) {
    expect(() => browserCommand('win32', url), url).toThrow('不合法');
  }
  expect(browserCommand('win32', `http://127.0.0.1:41234/#credential=${credential}`).file).toBe('rundll32.exe');
  expect(browserCommand('darwin', 'http://127.0.0.1:1/')).toEqual({ file: 'open', args: ['http://127.0.0.1:1/'] });
  expect(browserCommand('linux', 'http://127.0.0.1:1/')).toEqual({ file: 'xdg-open', args: ['http://127.0.0.1:1/'] });
});
