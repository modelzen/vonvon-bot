import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { paths } from '../../config/paths';
import { readRunningPidLock } from '../../server/pid-lock';
import { daemonStatus, runStart } from './daemon';

const run = promisify(execFile);

export function buildOpenUrl(listen: string, credential: string): string {
  if (!/^127\.0\.0\.1:\d{1,5}$/.test(listen)) throw new Error('Daemon is not listening on loopback.');
  if (!/^[a-f0-9]{64}$/i.test(credential)) throw new Error('Invalid local daemon credential.');
  return `http://${listen}/#credential=${encodeURIComponent(credential)}`;
}

export type GuideInput = { listen: string; credential: string; tty: boolean; sshConnection: string | undefined; user: string; host: string; credentialPath: string };

/**
 * How to open the web page from another computer through `ssh -L` (3.10). The credential is printed only to a
 * terminal: a pipe, a redirect or a service manager may keep it in a log. It sits in the URL fragment, which the
 * browser never sends, and the page drops it from the address bar.
 */
export function openGuide(o: GuideInput): string[] {
  const url = buildOpenUrl(o.listen, o.credential);
  const port = o.listen.slice(o.listen.lastIndexOf(':') + 1);
  // SSH_CONNECTION is "client-ip client-port server-ip server-port"; ssh takes user@ipv6 without brackets.
  const [, , server, serverPort] = o.sshConnection?.trim().split(/\s+/) ?? [];
  const known = server !== undefined && /^[0-9a-f.:]+$/i.test(server);
  const target = `${o.user}@${known ? server : '<这台主机的地址>'}`;
  const sshPort = known && serverPort && /^\d+$/.test(serverPort) && serverPort !== '22' ? ` -p ${serverPort}` : '';
  return [
    o.tty ? '网页地址（带着这台主机的本机凭据，别贴给别人，也别贴进聊天、工单和截图）：' : '网页地址：',
    `  ${o.tty ? url : `http://${o.listen}/`}`,
    ...(o.tty ? [] : ['带凭据的链接没打印：输出不是终端，可能会进日志。在终端里直接运行 vonvon open --print。']),
    `daemon 只听 ${o.listen}。在你自己的电脑上开一条 SSH 转发：`,
    `  ssh -N -L ${port}:127.0.0.1:${port}${sshPort} ${target}${known ? '' : `（这台主机叫 ${o.host}）`}`,
    `再在那台电脑的浏览器里打开上面的地址。把 ${target} 换成你平时 ssh 到这台主机的写法；你电脑上的 ${port} 被占了，就把转发前一个 ${port} 和地址里的端口一起换掉。`,
    `链接泄露了：vonvon daemon stop，删掉 ${o.credentialPath}，再 vonvon daemon start，凭据就换了。`,
  ];
}

const credentialFile = (): string => join(paths.appDir, 'local-credential');
const readCredential = async (): Promise<string> => (await readFile(credentialFile(), 'utf8')).trim();
const shownPath = (path: string, home = homedir()): string => path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
const guideFor = (listen: string, credential: string, tty: boolean, env: NodeJS.ProcessEnv): string[] =>
  openGuide({ listen, credential, tty, sshConnection: env.SSH_CONNECTION, user: userInfo().username, host: hostname(), credentialPath: shownPath(credentialFile()) });

/** The last part of a Linux `service install`: the guide for the daemon the service just started. */
export async function serviceOpenGuide(tty: boolean): Promise<string[]> {
  try {
    const lock = await readRunningPidLock(paths.appDir);
    if (lock?.listen) return guideFor(lock.listen, await readCredential(), tty, process.env);
  } catch { /* the hint below */ }
  return ['运行 vonvon open --print 看怎么打开网页。'];
}

export type OpenDependencies = {
  /** The running daemon's address; a stopped one is started first (the service's, when it is installed). */
  listen: () => Promise<string>;
  credential: () => Promise<string>;
  launch: (file: string, args: string[]) => Promise<unknown>;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  tty: boolean;
  /** --json: one line with the address. Never the credential: unlike a pairing link, it does not expire. */
  json: boolean;
  write: (text: string) => void;
};

const defaults = (): OpenDependencies => ({
  listen: async () => {
    const current = await daemonStatus();
    if (current.running) return current.listen;
    // On a new host `vonvon open --print` comes first, and the service lookup in runStart needs the data root.
    await mkdir(paths.appDir, { recursive: true, mode: 0o700 });
    const status = await runStart();
    if (!status.running) throw new Error('Daemon did not start.');
    return status.listen;
  },
  credential: readCredential,
  launch: (file, args) => run(file, args),
  platform: process.platform, env: process.env, tty: Boolean(process.stdout.isTTY), json: false,
  write: text => { process.stdout.write(text); },
});

/** execFile's own error text holds the command line, and so the credential. */
function launchFailure(file: string, error: unknown): string {
  const { code, signal } = (error ?? {}) as { code?: unknown; signal?: unknown };
  if (typeof code === 'number') return `${file} 退出码 ${code}`;
  if (typeof code === 'string') return `${file}：${code}`;
  if (typeof signal === 'string') return `${file} 被 ${signal} 结束`;
  return `${file} 没有运行成功`;
}

/** What a Windows browser launch may carry: a loopback URL without whitespace or `cmd.exe`'s metacharacters (I4a §4.5). */
const WINDOWS_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~!$'()*+,;=:@/?%#-]*$/;

/** How the browser is started: `open`, `xdg-open`, or on Windows `rundll32 url.dll,FileProtocolHandler`, which takes the
 * URL as an argument without a shell (`start` would go through `cmd.exe`). */
export function browserCommand(platform: NodeJS.Platform, url: string): { file: string; args: string[] } {
  if (platform === 'win32') {
    if (!WINDOWS_URL.test(url)) throw new Error('网页地址不合法，没有打开浏览器。运行 vonvon open --print 手动打开。');
    return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { file: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] };
}

/** `--print`, and `open` on a Linux without DISPLAY or WAYLAND_DISPLAY, print the guide instead of starting a browser. */
export async function runOpen(print = false, overrides: Partial<OpenDependencies> = {}): Promise<void> {
  const d: OpenDependencies = { ...defaults(), ...overrides };
  const listen = await d.listen();
  const credential = await d.credential();
  const result = (opened: boolean): string => `${JSON.stringify({ ok: true, listen, url: `http://${listen}/`, opened })}\n`;
  if (print || (d.platform === 'linux' && !d.env.DISPLAY && !d.env.WAYLAND_DISPLAY)) {
    d.write(d.json ? result(false) : `${guideFor(listen, credential, d.tty, d.env).join('\n')}\n`);
    return;
  }
  const url = buildOpenUrl(listen, credential);
  const { file, args } = browserCommand(d.platform, url);
  try { await d.launch(file, args); }
  catch (error) { throw new Error(`没能打开浏览器：${launchFailure(file, error)}。运行 vonvon open --print 手动打开。`); }
  if (d.json) d.write(result(true));
}
