import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { ConnectionError, type VonvonClient } from '@vonvon/client';
import type {
  BackendAccount, BackendEntry, BackendInstallEventPayload, BackendInstallItem, EnvironmentOperation, EnvironmentReply, EnvironmentRequest,
  EnvironmentTool, EnvironmentToolState, ToolInstallOperation,
} from '@vonvon/protocol';
import { readStdin } from '../../core/stdin';
import { InputCancelled, readHidden } from '../../core/terminal-input';
import { badArgs, CommandError } from '../command-error';
import { print, printable, withDaemon, type Call, type Daemon, type Io } from '../daemon-client';

/**
 * `vonvon env …` (cli-7-environment): the web page's 本机环境 in a terminal. Codex, Claude and lark-cli are scanned,
 * installed, updated and uninstalled; lark-cli also signs in and keeps its app profiles; the Provider components install
 * and are checked. The long tasks are followed to their end by `follow()` and `followBackend()`; Ctrl-C cancels them.
 */
const TOOLS: readonly EnvironmentTool[] = ['codex', 'claude', 'lark-cli'];
const LABEL: Record<EnvironmentTool, string> = { codex: 'Codex', claude: 'Claude', 'lark-cli': 'lark-cli' };
const SOURCE: Record<string, string> = { npm: 'npm', homebrew: 'Homebrew', app: 'App 自带', standalone: '独立安装', explicit: 'CODEX_BIN 指定' };
/** Reads that start a tool or probe a Provider can outlast the local wait; the daemon's own timeouts end them. */
const LONG = { feishu: true } as const;
/** The tool install's request is answered only when the install ends, which can take minutes: setTimeout's longest wait. */
const UNTIL_DONE = 2 ** 31 - 1;
const POLL_MS = 1_000;
const CANCEL_WAIT = 5_000;
const INSTALL_UNKNOWN = '安装可能还在进行，运行 vonvon env scan 看。';
const LOGIN_UNKNOWN = '登录可能还在进行，运行 vonvon env scan 看。';
const PROFILE_UNKNOWN = '应用配置可能还在进行，运行 vonvon env profile init --status 看。';
const BACKEND_UNKNOWN = '安装可能还在进行，运行 vonvon env backend list 看。';

export type EnvDependencies = {
  /** stdout is a terminal: a sign-in link gets a QR next to it */
  tty: boolean;
  qr: (url: string) => Promise<string>;
  /** Installs a Ctrl-C handler and returns its removal. */
  onInterrupt: (handler: () => void) => () => void;
  /** The pause between two status reads; tests pass a short one. */
  wait: (ms: number) => Promise<void>;
  /** The App Secret: asked for without echo on a terminal, else all of stdin. */
  readSecret: (prompt: string) => Promise<string>;
  /** A new id for each long task's starting request, which tells this command's operation from another caller's. */
  requestId: () => string;
};
const envDefaults = (): EnvDependencies => ({
  tty: Boolean(process.stdout.isTTY),
  qr: url => QRCode.toString(url, { type: 'terminal', small: true }),
  onInterrupt: handler => { process.on('SIGINT', handler); return () => { process.off('SIGINT', handler); }; },
  // unref: a wait still pending when the command ends does not hold the process
  wait: ms => new Promise(done => { setTimeout(done, ms).unref(); }),
  readSecret: prompt => process.stdin.isTTY ? readHidden(prompt, process.stdin, process.stderr) : readStdin(),
  requestId: () => randomUUID(),
});

type Reply<K extends EnvironmentReply['kind']> = Extract<EnvironmentReply, { kind: K }>;
/** The daemon's refusal in its own words, exit 4 with its code as `reason`. */
function refusal(reply: { code: string; message: string }): CommandError {
  return new CommandError('refused', `${reply.message}${reply.code === 'tool-missing' ? '运行 vonvon env install lark-cli 装上。' : ''}`, { reason: reply.code });
}
function answer<K extends EnvironmentReply['kind']>(what: string, reply: EnvironmentReply, kind: K): Reply<K> {
  if (reply.kind === kind) return reply as Reply<K>;
  if (reply.kind === 'refused') throw refusal(reply);
  throw new CommandError('failed', `${what}没有完成：daemon 回了意外的结果（${reply.kind}）。`);
}
const environment = (call: Call, what: string, request: EnvironmentRequest, o?: Parameters<Call>[2]): Promise<EnvironmentReply> => call(what, c => c.environment(request), o);
/**
 * A long task's starting request, with this command's own request id (审查 202). A daemon from before the id refuses the
 * field as an invalid request (its schema is strict) and starts nothing; the request goes again without it, unless the
 * command is already over (Ctrl-C). That daemon's states carry no id, so none of them is ever taken for this command's.
 */
async function startOwn(call: Call, what: string, request: EnvironmentRequest & { requestId: string }, over: () => boolean, o?: Parameters<Call>[2]): Promise<EnvironmentReply> {
  try { return await environment(call, what, request, o); }
  catch (error) {
    if (!(error instanceof CommandError && error.reason === 'invalid_request') || over()) throw error;
    const { requestId: _sent, ...plain } = request;
    return environment(call, what, plain as EnvironmentRequest, o);
  }
}
const emit = (io: Io, event: object): void => io.write(`${JSON.stringify(event)}\n`);

/** Not printable(): a log keeps its line breaks and tabs; npm's progress `\r` becomes a line break. */
// eslint-disable-next-line no-control-regex
const LOG_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const logText = (chunk: string): string => chunk.replace(/\r\n?/g, '\n').replace(LOG_CONTROL, '');

export function envTool(value: string): EnvironmentTool {
  const tool = TOOLS.find(each => each === value);
  if (!tool) throw badArgs(`工具写 codex、claude 或 lark-cli，不认识「${value}」。`);
  return tool;
}

// ---- env scan ----

type Auth = { state: 'signedIn' | 'signedOut' | 'unknown'; message: string };
type ScannedTool = EnvironmentToolState & { auth?: Auth };

/** lark-cli really signs in to Feishu; Codex and Claude only need to be set up, an account or a custom API (devices-ui-2 4.2).
 * A managed copy is on no PATH: its `command` is what starts it (0.9.0 Linux acceptance). */
export function authText(tool: Pick<ScannedTool, 'tool' | 'auth' | 'command'>): string {
  if (tool.tool === 'lark-cli') {
    if (!tool.auth) return '登录状态查不到';
    if (tool.auth.state === 'signedIn') return '已登录';
    if (tool.auth.state === 'unknown') return `登录状态不确定：${tool.auth.message}`;
    return '没登录：运行 vonvon env login lark-cli';
  }
  if (!tool.auth) return '配置状态查不到';
  if (tool.auth.state === 'signedIn') return '可用';
  if (tool.auth.state === 'unknown') return `确认不了：${tool.auth.message}`;
  // vonvon does not set up Codex or Claude for the user (docs/product.md 3.1, 2026-10-28)
  return `没配置好：在终端里运行 ${tool.command ?? tool.tool} 配置（账号或自定义 API 都行）`;
}

function toolLines(tool: ScannedTool): string[] {
  const name = LABEL[tool.tool];
  if (tool.installation === 'missing') return [`${name}  没装`];
  const source = tool.source ? SOURCE[tool.source] : undefined;
  const where = tool.installation === 'managed' ? '托管' : `系统里的${source ? `，${source}` : ''}`;
  const update = tool.updateAvailable && tool.latestVersion ? `，有新版本 ${tool.latestVersion}` : '';
  const lines = [`${name}  ${tool.version ?? '版本没读到'}（${where}${update}）  ${authText(tool)}`];
  if (tool.runtimeStatus === 'failed') lines.push('    装了，但运行不起来（--version 失败）。');
  if (tool.compatibility?.status === 'tooOld') lines.push(`    版本太旧：最低要 ${tool.compatibility.minimum}。`);
  if (tool.compatibility?.status === 'newer') lines.push(`    比验证过的 ${tool.compatibility.verified} 新，可能有不兼容的地方。`);
  if (tool.installation === 'external' && tool.updateInstructions) lines.push(...tool.updateInstructions.split('\n').map(line => `    ${line}`));
  return lines;
}

/** `vonvon env scan`: each tool, and the sign-in of each installed one; one sign-in read failing leaves the rest, as on the web page. */
export async function runEnvScan(io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const tools = await daemon(async call => {
    const { tools } = answer('读取本机环境', await environment(call, '读取本机环境', { type: 'scan' }), 'tools');
    const auths = await Promise.allSettled(tools.map(tool => tool.installation === 'missing' ? Promise.resolve(undefined)
      : environment(call, `检查 ${LABEL[tool.tool]} 的${tool.tool === 'lark-cli' ? '登录' : '配置'}`, { type: 'authStatus', tool: tool.tool })));
    return tools.map((tool, index): ScannedTool => {
      const read = auths[index];
      const auth = read?.status === 'fulfilled' && read.value?.kind === 'auth' ? { state: read.value.state, message: read.value.message } : undefined;
      return auth ? { ...tool, auth } : tool;
    });
  });
  print(io, tools.flatMap(toolLines), { tools });
}

// ---- following a long task ----

type Ending = { kind: 'succeeded'; message: string } | { kind: 'failed' | 'cancelled' | 'timedOut'; message: string }
  | { kind: 'refused'; code: string; message: string }
  /** Ctrl-C; `cancelled`: a cancel went out for this command's own operation */
  | { kind: 'interrupted'; cancelled: boolean }
  /** the connection dropped: after the task started (an id is known) the outcome is unknown */
  | { kind: 'lost'; started: boolean }
  /** another operation replaced this one's state before its end was read */
  | { kind: 'unseen' };
type Seen = { id: string; kind: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timedOut'; message?: string; url?: string; requestId?: string };
function seenOf(operation: ToolInstallOperation | EnvironmentOperation | null): Seen | null {
  if (!operation) return null;
  if (operation.kind !== 'running') return { id: operation.id, kind: operation.kind, message: operation.message };
  return { id: operation.id, kind: 'running', ...('url' in operation && operation.url ? { url: operation.url } : {}), ...('requestId' in operation && operation.requestId ? { requestId: operation.requestId } : {}) };
}
type Follow = { call: Call; client: VonvonClient; io: Io; d: EnvDependencies };

/**
 * What both followers share: the end comes once; a dropped connection ends it; Ctrl-C sends the task's cancel and ends
 * it as interrupted once the cancel is answered or after 5 s, a second Ctrl-C at once (4.2 第 4 条). From the first
 * Ctrl-C on, nothing else ends it, not a dropped connection, a failed read or the task's own end, and nothing more is
 * read or shown (`over`). `claim` names the task once its id is known, and sends the cancel if Ctrl-C came first.
 *
 * The cancel only ever goes to an operation this command's request is proven to have started (`own`, 审查 202): the
 * start's reply named it, or its state carries this request's id. `find` looks for one with the same rule; with none,
 * Ctrl-C sends nothing and ends it at once, and the operation, if there is one, runs on.
 */
function track(f: Follow, resolve: (ending: Ending) => void, reject: (error: unknown) => void, task: { cancel: (id: string) => EnvironmentRequest; find?: () => Promise<string | undefined> }) {
  const stops: Array<() => void> = [];
  let cancelling: Promise<unknown> | undefined;
  const t = {
    /** the task's operation once known: its states and events are the ones shown */
    id: undefined as string | undefined,
    /** this command's request started it: Ctrl-C cancels it (an install this one attached to is followed, not cancelled) */
    own: false,
    interrupted: false,
    settled: false,
    stops,
    /** ended, or cancelling after Ctrl-C */
    get over(): boolean { return t.settled || t.interrupted; },
    finish(ending: Ending): void {
      if (t.settled || (t.interrupted && ending.kind !== 'interrupted')) return;
      t.settled = true; for (const stop of stops.splice(0)) stop(); resolve(ending);
    },
    fail(error: unknown): void { if (t.over) return; t.settled = true; for (const stop of stops.splice(0)) stop(); reject(error); },
    claim(id: string, own = true): void {
      if (t.id !== undefined || t.settled) return;
      t.id = id;
      t.own = own;
      // Ctrl-C came before the id: cancel now, while the interrupt still waits
      if (t.interrupted) void t.cancel();
    },
    /** The cancel, sent once and only for this command's own operation. */
    cancel(): Promise<unknown> | undefined {
      if (t.id !== undefined && t.own) cancelling ??= f.client.environment(task.cancel(t.id)).catch(() => undefined);
      return cancelling;
    },
    interruption: (): Ending => ({ kind: 'interrupted', cancelled: cancelling !== undefined }),
  };
  // while cancelling, the cancel's request fails with the connection and ends it as interrupted
  stops.push(f.client.onError(error => { if (error instanceof ConnectionError) t.finish({ kind: 'lost', started: t.id !== undefined }); }));
  stops.push(f.d.onInterrupt(() => {
    if (t.interrupted) { t.finish(t.interruption()); return; }
    t.interrupted = true;
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>(done => { timer = setTimeout(done, CANCEL_WAIT); });
    stops.push(() => { clearTimeout(timer); });
    const cancel = (async () => {
      if (t.id === undefined) { const found = await task.find?.(); if (found !== undefined) t.claim(found); }
      await t.cancel();
    })().catch(() => undefined);
    void Promise.race([cancel, cap]).then(() => { t.finish(t.interruption()); });
  }));
  return t;
}

type Polled = {
  /** Known from the start reply (sign-in, app profile); a tool install learns it from the first state `claim` accepts. */
  id?: string;
  first?: Seen | null;
  /** A tool install: the state is this command's own, by the request id it carries. */
  claim?: (seen: Seen) => boolean;
  read: (started: boolean) => Promise<Seen | null>;
  cancel: (id: string) => EnvironmentRequest;
  find?: () => Promise<string | undefined>;
  /**
   * A tool install's request, sent once Ctrl-C is caught and answered when the install ends: its answer is the end,
   * and the states only show progress. `own`: this command's install was seen running, so it had started.
   */
  started?: { reply: (over: () => boolean) => Promise<EnvironmentReply>; ended: (reply: EnvironmentReply, own: boolean) => Ending };
};

/**
 * Reads the task's state every second until its own end (cli-7-environment 4.2): a state with another id is not this
 * task's. JSON Lines: `progress` when its state changes, `url` when its link changes. No overall timeout.
 */
function follow(f: Follow, task: Polled): Promise<Ending> {
  return new Promise((resolve, reject) => {
    const t = track(f, resolve, reject, task);
    let state: string | undefined;
    let url: string | undefined;
    let queue = Promise.resolve();
    const show = async (seen: Seen): Promise<void> => {
      if (t.over) return;
      if (seen.kind !== 'running') { if (!task.started) t.finish({ kind: seen.kind, message: seen.message ?? '' }); return; }
      if (state !== seen.kind) { state = seen.kind; if (f.io.json) emit(f.io, { event: 'progress', state, operationId: seen.id }); }
      if (!seen.url || seen.url === url) return;
      url = seen.url;
      if (f.io.json) { emit(f.io, { event: 'url', url }); return; }
      const art = f.d.tty ? `或者用手机扫：\n${(await f.d.qr(url)).replace(/\n?$/, '\n')}` : '';
      f.io.write(`在浏览器里打开：${printable(url)}\n${art}`);
    };
    const observe = (seen: Seen | null): void => {
      if (!seen || t.over) return;
      if (t.id === undefined && task.claim?.(seen)) t.claim(seen.id);
      if (t.id === undefined) return;
      // sign-in and app profile share one state: another id there means this one ended unseen
      if (seen.id !== t.id) { if (task.id !== undefined) t.finish({ kind: 'unseen' }); return; }
      queue = queue.then(() => show(seen)).catch(error => t.fail(error));
    };
    if (task.id !== undefined) t.claim(task.id);
    if (task.first) observe(task.first);
    const started = task.started;
    started?.reply(() => t.over).then(async reply => {
      if (t.over) return;
      const ending = started.ended(reply, t.own);
      // the progress already read goes out first
      await queue;
      t.finish(ending);
    }).catch(error => t.fail(error));
    void (async () => {
      while (!t.over) {
        observe(await task.read(t.id !== undefined));
        if (!t.over) await f.d.wait(POLL_MS);
      }
    })().catch(error => t.fail(error));
  });
}

/** `kept`: Ctrl-C sent no cancel, as no operation was proven this command's own */
type Words = { cancelled: string; kept: string; reason: string; unknown: string };
/** A follow's end other than success as the command's failure (cli-7-environment 4.1). */
function mustSucceed(ending: Ending, w: Words): asserts ending is Extract<Ending, { kind: 'succeeded' }> {
  switch (ending.kind) {
    case 'succeeded': return;
    case 'interrupted': throw new CommandError('interrupted', ending.cancelled ? w.cancelled : w.kept);
    case 'refused': throw refusal(ending);
    case 'failed': throw new CommandError('failed', ending.message || '没有完成。', { reason: w.reason });
    case 'cancelled': throw new CommandError('failed', `在别处取消了：${ending.message}`, { reason: 'cancelled' });
    case 'timedOut': throw new CommandError('failed', ending.message || '超时了。', { reason: 'timed_out' });
    case 'lost': throw ending.started ? new CommandError('outcome-unknown', `和 daemon 的连接断了。${w.unknown}`) : new CommandError('connection', '和 daemon 的连接断了，daemon 可能正在停止。');
    case 'unseen': throw new CommandError('outcome-unknown', `没等到结果：又开始了别的操作。${w.unknown}`);
  }
}

const deps = (overrides: Partial<EnvDependencies>): EnvDependencies => ({ ...envDefaults(), ...overrides });
/** The client behind `call`, for what outlives one request: the events, the start of a tool install, the cancel on Ctrl-C. */
const clientOf = (call: Call): Promise<VonvonClient> => call('连接 daemon', async c => c);

// ---- env install / update / uninstall ----

/** The refusals a tool install gives once it started (D/environment/service.ts performInstall): its own end, exit 1. */
const INSTALL_ENDED = new Set(['install-failed', 'install-incomplete', 'install-not-selected', 'npm-missing', 'explicit-codex']);

/**
 * `vonvon env install|update <tool>`: the web page's 托管安装. The daemon answers the request when the install ends, and
 * that answer is its end. Meanwhile the state is read for the progress and for the id Ctrl-C cancels; the install there
 * is this command's only when it carries this request's id (审查 202): a state of another caller's install, or from a
 * daemon that does not echo the id, is neither shown nor cancelled.
 */
export async function runEnvInstall(wanted: string, update: boolean, io: Io, daemon: Daemon = withDaemon, overrides: Partial<EnvDependencies> = {}): Promise<void> {
  const tool = envTool(wanted);
  const d = deps(overrides);
  const verb = update ? '更新' : '安装';
  const requestId = d.requestId();
  const mine = (seen: Seen | null): seen is Seen => seen?.kind === 'running' && seen.requestId === requestId;
  await daemon(async call => {
    const client = await clientOf(call);
    const read = async (started: boolean) => seenOf(answer(`读取${verb}进度`, await environment(call, `读取${verb}进度`, { type: 'toolInstallStatus' }, started ? { unknown: INSTALL_UNKNOWN } : {}), 'toolInstall').operation);
    if (!io.json) io.write(`正在${verb} ${LABEL[tool]}…（Ctrl-C 取消）\n`);
    const ending = await follow({ call, client, io, d }, {
      claim: mine,
      read,
      cancel: operationId => ({ type: 'cancelInstall', operationId }),
      find: async () => {
        const reply = await client.environment({ type: 'toolInstallStatus' });
        const seen = reply.kind === 'toolInstall' ? seenOf(reply.operation) : null;
        return mine(seen) ? seen.id : undefined;
      },
      started: {
        reply: over => startOwn(call, `${verb} ${LABEL[tool]}`, { type: update ? 'update' : 'install', tool, requestId }, over, { ms: UNTIL_DONE }),
        ended: (reply, own) => {
          if (reply.kind === 'applied') return { kind: 'succeeded', message: reply.message };
          if (reply.kind !== 'refused') throw new CommandError('failed', `${verb}没有完成：daemon 回了意外的结果（${reply.kind}）。`);
          if (reply.code === 'install-cancelled') return { kind: 'cancelled', message: reply.message };
          // its own install was seen running, so any refusal is how it ended (environment-closed …)
          if (own || INSTALL_ENDED.has(reply.code)) return { kind: 'failed', message: reply.message };
          // refused before it started (busy …): what the state shows meanwhile is another caller's
          return { kind: 'refused', code: reply.code, message: reply.message };
        },
      },
    });
    mustSucceed(ending, {
      cancelled: `已取消${verb}。`, reason: 'install_failed', unknown: INSTALL_UNKNOWN,
      kept: `已退出，没有取消：确认不了哪个${verb}是这次开始的（daemon 比命令行旧，或者还没开始）。如果已经开始，它会继续进行；运行 vonvon env scan 看，vonvon env cancel install 取消。`,
    });
    let version: string | undefined;
    try { version = answer('读取本机环境', await environment(call, '读取本机环境', { type: 'scan' }), 'tools').tools.find(each => each.tool === tool)?.version ?? undefined; }
    catch { /* the result goes without the version */ }
    print(io, [`✓ ${ending.message}`], { event: 'result', tool, ...(version ? { version } : {}), message: ending.message });
  });
}

/** `vonvon env uninstall <tool>`: only a managed copy; the daemon refuses another (4). No --yes: it can be installed again. */
export async function runEnvUninstall(wanted: string, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const tool = envTool(wanted);
  const { message } = await daemon(async call => answer('卸载', await environment(call, `卸载 ${LABEL[tool]}`, { type: 'uninstall', tool }, { unknown: '可能已经卸载了，运行 vonvon env scan 看。' }), 'applied'));
  print(io, [`✓ ${message}`], { message });
}

// ---- env login lark-cli ----

/** `vonvon env login lark-cli`: lark-cli's own sign-in, followed until it ends, then its sign-in read again. */
export async function runEnvLogin(wanted: string, io: Io, daemon: Daemon = withDaemon, overrides: Partial<EnvDependencies> = {}): Promise<void> {
  if (wanted !== 'lark-cli') throw badArgs('vonvon 只管 lark-cli 的登录；Codex、Claude 在它们自己的命令行里登录。');
  const d = deps(overrides);
  await daemon(async call => {
    const client = await clientOf(call);
    const start = seenOf(answer('开始登录', await environment(call, '开始登录 lark-cli', { type: 'startLogin', tool: 'lark-cli' }), 'operation').operation);
    if (!start) throw new CommandError('failed', '开始登录没有完成：daemon 没说开始了哪个操作。');
    if (!io.json) io.write('正在登录 lark-cli…（Ctrl-C 取消）\n');
    const ending = await follow({ call, client, io, d }, {
      id: start.id, first: start,
      read: async started => seenOf(answer('读取登录进度', await environment(call, '读取登录进度', { type: 'loginStatus' }, started ? { unknown: LOGIN_UNKNOWN } : {}), 'operation').operation),
      cancel: operationId => ({ type: 'cancelLogin', operationId }),
    });
    mustSucceed(ending, { cancelled: '已取消登录。', kept: `已退出，没有取消。${LOGIN_UNKNOWN}`, reason: 'login_failed', unknown: LOGIN_UNKNOWN });
    let auth: Auth | undefined;
    try {
      const reply = await environment(call, '检查 lark-cli 的登录', { type: 'authStatus', tool: 'lark-cli' });
      if (reply.kind === 'auth') auth = { state: reply.state, message: reply.message };
    } catch { /* the result says it could not be read */ }
    const human = auth?.state === 'signedIn' ? '✓ lark-cli 已登录。' : auth ? `登录流程结束了，lark-cli 的登录状态：${auth.message}` : '登录流程结束了，登录状态没查到：运行 vonvon env scan 看。';
    print(io, [human], { event: 'result', ...(auth ? { auth } : {}) });
  });
}

// ---- env profile ----

function profileLines(profiles: Reply<'profiles'>['profiles']): string[] {
  if (!profiles.length) return ['还没有应用配置。运行 vonvon env profile add 或 vonvon env profile init 加一个。'];
  return profiles.map(p => `${p.active ? '* ' : '  '}${p.name}  ${p.appId}  ${p.brand === 'lark' ? 'Lark' : '飞书'}${p.user ? `  ${p.user}` : ''}${p.tokenStatus ? `  ${p.tokenStatus}` : ''}`);
}

/** `vonvon env profile list`: lark-cli's app profiles; `*` marks the one in use. */
export async function runEnvProfileList(io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { profiles } = await daemon(async call => answer('读取应用配置', await environment(call, '读取应用配置', { type: 'profileList' }), 'profiles'));
  print(io, profileLines(profiles), { profiles });
}

/** `vonvon env profile use <name>`: lark-cli uses this profile from now on. */
export async function runEnvProfileUse(name: string, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { profiles } = await daemon(async call => answer('切换应用配置', await environment(call, '切换应用配置', { type: 'profileUse', name }, { unknown: '可能已经换了，运行 vonvon env profile list 看。' }), 'profiles'));
  const message = `现在用「${name}」。`;
  print(io, [`✓ ${message}`], { message, profiles });
}

/**
 * `vonvon env profile add <name> --app-id <id>`: the App Secret never is an argument (shell history, the process list):
 * a hidden prompt on a terminal, else all of stdin. It is in no output and no error.
 */
export async function runEnvProfileAdd(name: string, options: { appId: string; brand?: string | undefined; use?: boolean | undefined }, io: Io, daemon: Daemon = withDaemon, overrides: Partial<EnvDependencies> = {}): Promise<void> {
  const brand = options.brand ?? 'feishu';
  if (brand !== 'feishu' && brand !== 'lark') throw badArgs('--brand 写 feishu 或 lark。');
  const d = deps(overrides);
  const use = Boolean(options.use);
  const { profiles } = await daemon(async call => {
    let secret: string;
    try { secret = (await d.readSecret('粘贴 App Secret（不回显），回车结束：')).trim(); }
    catch (error) {
      if (error instanceof InputCancelled) throw new CommandError('interrupted', '已取消，没有添加。');
      throw error;
    }
    if (!secret) throw badArgs('没读到 App Secret：终端里按提示粘贴；脚本里从标准输入传，比如 printf %s "$SECRET" | vonvon env profile add …');
    const request: EnvironmentRequest = { type: 'profileAdd', name, appId: options.appId.trim(), appSecret: secret, brand, use };
    return answer('添加应用配置', await environment(call, '添加应用配置', request, { unknown: '可能已经加上了，运行 vonvon env profile list 看。' }), 'profiles');
  });
  const message = `已添加应用配置「${name}」${use ? '，现在用它' : ''}。`;
  print(io, [`✓ ${message}`], { message, profiles });
}

/** `vonvon env profile init <name>`: lark-cli makes a new app through its link, followed until it ends. */
export async function runEnvProfileInit(name: string, io: Io, daemon: Daemon = withDaemon, overrides: Partial<EnvDependencies> = {}): Promise<void> {
  const d = deps(overrides);
  await daemon(async call => {
    const client = await clientOf(call);
    const start = seenOf(answer('开始应用配置', await environment(call, '开始应用配置', { type: 'profileInit', name }), 'operation').operation);
    if (!start) throw new CommandError('failed', '开始应用配置没有完成：daemon 没说开始了哪个操作。');
    if (!io.json) io.write(`正在建应用配置「${name}」…（Ctrl-C 取消）\n`);
    const ending = await follow({ call, client, io, d }, {
      id: start.id, first: start,
      read: async started => seenOf(answer('读取应用配置进度', await environment(call, '读取应用配置进度', { type: 'profileInitStatus' }, started ? { unknown: PROFILE_UNKNOWN } : {}), 'operation').operation),
      cancel: operationId => ({ type: 'profileInitCancel', operationId }),
    });
    mustSucceed(ending, { cancelled: '已取消应用配置。', kept: `已退出，没有取消。${PROFILE_UNKNOWN}`, reason: 'profile_init_failed', unknown: PROFILE_UNKNOWN });
    print(io, [`✓ 应用配置「${name}」建好了。运行 vonvon env profile list 查看。`], { event: 'result', message: ending.message });
  });
}

const ENDED: Record<string, string> = { succeeded: '完成了', failed: '失败了', cancelled: '取消了', timedOut: '超时了' };
/** `vonvon env profile init --status` and `--cancel`; sign-in and app profile share one state, so `--cancel` checks whose it is. */
export async function runEnvProfileInitState(action: 'status' | 'cancel', io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const result = await daemon(async call => {
    const { operation } = answer('读取应用配置进度', await environment(call, '读取应用配置进度', { type: 'profileInitStatus' }), 'operation');
    if (action === 'status') return { operation };
    if (operation?.kind !== 'running' || operation.purpose.kind !== 'profileInit') return { cancelled: false };
    const reply = await environment(call, '取消应用配置', { type: 'profileInitCancel', operationId: operation.id }, { ...LONG, unknown: '可能已经取消了，运行 vonvon env profile init --status 看。' });
    if (reply.kind === 'refused' && reply.code === 'not-running') return { cancelled: false };
    answer('取消应用配置', reply, 'operation');
    return { cancelled: true };
  });
  if ('cancelled' in result) { print(io, [result.cancelled ? '已取消正在进行的应用配置。' : '没有在进行的应用配置。'], { cancelled: result.cancelled }); return; }
  const { operation } = result;
  const human = !operation ? ['没有在进行的应用配置。']
    : operation.kind === 'running' ? operation.purpose.kind === 'profileInit'
      ? ['正在建应用配置。', ...operation.url ? [`在浏览器里打开：${operation.url}`] : []]
      : ['没有在进行的应用配置（在进行的是 lark-cli 登录）。']
    : [`上一次 lark-cli 的操作（登录或应用配置）${ENDED[operation.kind] ?? operation.kind}：${operation.message}`];
  print(io, human, { operation });
}

// ---- env backend ----

function backendLines(entry: BackendEntry): string[] {
  const version = entry.installedVersion ?? entry.version;
  const state = entry.depState === 'installed' ? `已装${version ? ` ${version}` : ''}` : '没装';
  return [`${entry.id}  ${entry.displayName}  ${state}${entry.installable ? '  可以装' : ''}`, ...entry.hint ? entry.hint.split('\n').map(line => `    ${line}`) : []];
}

/** `vonvon env backend list`: the Provider components, installed or not. */
export async function runEnvBackendList(io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { entries } = await daemon(async call => answer('读取组件', await environment(call, '读取组件', { type: 'backendCatalog' }, LONG), 'backends'));
  print(io, entries.length ? entries.flatMap(backendLines) : ['没有可用的组件。'], { entries });
}

/** `vonvon env backend version <id>`: installed and latest. */
export async function runEnvBackendVersion(id: string, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const reply = await daemon(async call => answer('读取组件版本', await environment(call, '读取组件版本', { type: 'backendVersion', id }, LONG), 'backendVersion'));
  const human = [`${reply.id}  ${reply.installed ? `已装 ${reply.installed}` : '没装'}  最新 ${reply.latest ?? '查不到'}`];
  if (reply.hasUpdate) human.push(`有新版本：运行 vonvon env backend install ${reply.id} --update`);
  print(io, human, { id: reply.id, installed: reply.installed, latest: reply.latest, hasUpdate: reply.hasUpdate });
}

/** `vonvon env backend uninstall <id>`. */
export async function runEnvBackendUninstall(id: string, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { message } = await daemon(async call => answer('卸载组件', await environment(call, '卸载组件', { type: 'backendUninstall', id }, { ...LONG, unknown: '可能已经卸载了，运行 vonvon env backend list 看。' }), 'applied'));
  print(io, [`✓ ${message}`], { message });
}

export const LOGIN_STATE: Record<Reply<'backendLogin'>['state'], string> = { signedIn: '可用', signedOut: '没配置好', notRequired: '可用', unknown: '确认不了' };
function accountText(account: BackendAccount): string {
  if (account.kind === 'subscription') return `订阅${account.planType ? ` ${account.planType}` : ''}`;
  if (account.kind === 'api') return `API${account.apiProvider ? `（${account.apiProvider}）` : ''}`;
  return account.kind === 'free' ? '免费' : '';
}
/** `vonvon env backend check <id> [--refresh]`: the web page's 检查配置; --refresh is 重新检测, else the daemon's last check. */
export async function runEnvBackendCheck(id: string, refresh: boolean, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const reply = await daemon(async call => answer('检查配置', await environment(call, '检查配置', { type: 'backendLogin', id, refresh }, LONG), 'backendLogin'));
  const account = reply.account ? accountText(reply.account) : '';
  const human = [`${reply.id}  ${LOGIN_STATE[reply.state]}${account ? ` · ${account}` : ''}`, ...reply.message ? [`    ${reply.message}`] : []];
  print(io, human, { id: reply.id, state: reply.state, message: reply.message, ...(reply.account ? { account: reply.account } : {}) });
}

/**
 * Follows one component install by its events (cli-7-environment 4.2 第 3 条): the listener is on before the request,
 * the reply's replay comes first, then each event of its operation; the daemon sends them to this connection only, so
 * nothing is polled. `attached`: the same install was already running, started elsewhere: this follows it, and Ctrl-C
 * leaves it running (审查 202). Ctrl-C before the reply cancels only the install whose state carries this request's id.
 */
function followBackend(f: Follow, id: string, update: boolean, requestId: string): Promise<Ending> {
  return new Promise((resolve, reject) => {
    const t = track(f, resolve, reject, {
      cancel: operationId => ({ type: 'cancelBackendInstall', operationId }),
      find: async () => {
        const reply = await f.client.environment({ type: 'backendInstallStatus', id });
        return reply.kind === 'backendInstallStatus' && reply.operation?.state === 'running' && reply.operation.requestId === requestId ? reply.operation.operationId : undefined;
      },
    });
    const early: BackendInstallEventPayload[] = [];
    /** the output so far ends mid-line: the result starts on a line of its own */
    let open = false;
    const take = (item: BackendInstallItem): void => {
      if (t.over) return;
      if (item.type === 'log') {
        if (f.io.json) { emit(f.io, { event: 'log', chunk: item.chunk }); return; }
        const text = logText(item.chunk);
        if (text) { f.io.write(text); open = !text.endsWith('\n'); }
        return;
      }
      if (open) f.io.write('\n');
      if (item.type === 'done') t.finish({ kind: 'succeeded', message: '' });
      else t.finish({ kind: item.code === 'aborted' ? 'cancelled' : 'failed', message: item.message });
    };
    t.stops.push(f.client.onBackendInstall(payload => {
      if (t.id === undefined) early.push(payload);
      else if (payload.operationId === t.id) take(payload.item);
    }));
    startOwn(f.call, '安装组件', { type: 'backendInstall', id, update, requestId }, () => t.over).then(reply => {
      if (t.settled) return;
      if (reply.kind === 'refused') { t.finish({ kind: 'refused', code: reply.code, message: reply.message }); return; }
      if (reply.kind !== 'backendInstall') { t.fail(new CommandError('failed', `安装组件没有完成：daemon 回了意外的结果（${reply.kind}）。`)); return; }
      t.claim(reply.operationId, !reply.attached);
      if (t.interrupted) return;
      if (f.io.json) emit(f.io, { event: 'progress', state: 'running', operationId: reply.operationId, attached: reply.attached, ...(reply.omittedBytes ? { omittedBytes: reply.omittedBytes } : {}) });
      else {
        if (reply.attached) f.io.write(`${id} 已经在${update ? '更新' : '安装'}了（别处开始的），接着看它的输出；Ctrl-C 只退出，不取消它：\n`);
        if (reply.omittedBytes) f.io.write(`（前面还有 ${reply.omittedBytes} 字节的输出没显示）\n`);
      }
      for (const item of reply.replay) take(item);
      for (const payload of early.splice(0)) if (payload.operationId === t.id) take(payload.item);
    }, error => t.fail(error));
  });
}

/** `vonvon env backend install <id> [--update]`: the install's output as it comes, then its result; a lost connection is not followed again. */
export async function runEnvBackendInstall(id: string, update: boolean, io: Io, daemon: Daemon = withDaemon, overrides: Partial<EnvDependencies> = {}): Promise<void> {
  const d = deps(overrides);
  const verb = update ? '更新' : '安装';
  await daemon(async call => {
    const client = await clientOf(call);
    if (!io.json) io.write(`正在${verb}组件 ${id}…（Ctrl-C 取消）\n`);
    const ending = await followBackend({ call, client, io, d }, id, update, d.requestId());
    mustSucceed(ending, {
      cancelled: `已取消组件${verb}。`, reason: 'install_failed', unknown: BACKEND_UNKNOWN,
      kept: `已退出，没有取消：这个${verb}是别处开始的，或者确认不了是这次开始的。如果在进行，它会继续；运行 vonvon env backend list 看，vonvon env cancel backend ${id} 取消。`,
    });
    let version: string | undefined;
    try {
      const entry = answer('读取组件', await environment(call, '读取组件', { type: 'backendCatalog' }, LONG), 'backends').entries.find(each => each.id === id);
      version = entry?.installedVersion ?? entry?.version ?? undefined;
    } catch { /* the result goes without the version */ }
    print(io, [`✓ 已${verb}组件 ${id}${version ? ` ${version}` : ''}。`], { event: 'result', id, ...(version ? { version } : {}) });
  });
}

// ---- env cancel ----

const NOT_RUNNING = new Set(['not-running', 'unknown_operation']);
/** A cancel's reply: true when cancelled, false when it had ended meanwhile; another refusal fails (4). */
function cancelledBy(reply: EnvironmentReply, kind: EnvironmentReply['kind']): boolean {
  if (reply.kind === 'refused' && NOT_RUNNING.has(reply.code)) return false;
  answer('取消', reply, kind);
  return true;
}

/**
 * `vonvon env cancel install|login|backend <id>`: reads the state for the operation's id, then cancels it; nothing
 * running exits 0 with `cancelled: false`. The app profile's is `env profile init --cancel` (4.7).
 */
export async function runEnvCancel(what: string, id: string | undefined, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  if (what !== 'install' && what !== 'login' && what !== 'backend') throw badArgs('写 install、login 或 backend <组件 id>；应用配置用 vonvon env profile init --cancel。');
  if (what === 'backend' && !id) throw badArgs('env cancel backend 要写组件 id（vonvon env backend list 列出）。');
  if (what !== 'backend' && id !== undefined) throw badArgs(`env cancel ${what} 后面不写别的。`);
  const unknown = { ...LONG, unknown: '可能已经取消了，运行 vonvon env scan 看。' };
  const { cancelled, other } = await daemon(async call => {
    if (what === 'install') {
      const { operation } = answer('读取安装进度', await environment(call, '读取安装进度', { type: 'toolInstallStatus' }), 'toolInstall');
      if (operation?.kind !== 'running') return { cancelled: false };
      return { cancelled: cancelledBy(await environment(call, '取消安装', { type: 'cancelInstall', operationId: operation.id }, unknown), 'toolInstall') };
    }
    if (what === 'login') {
      const { operation } = answer('读取登录进度', await environment(call, '读取登录进度', { type: 'loginStatus' }), 'operation');
      if (operation?.kind !== 'running') return { cancelled: false };
      if (operation.purpose.kind !== 'login') return { cancelled: false, other: true };
      return { cancelled: cancelledBy(await environment(call, '取消登录', { type: 'cancelLogin', operationId: operation.id }, unknown), 'operation') };
    }
    const { operation } = answer('读取组件安装进度', await environment(call, '读取组件安装进度', { type: 'backendInstallStatus', id: id ?? '' }), 'backendInstallStatus');
    if (operation?.state !== 'running') return { cancelled: false };
    return { cancelled: cancelledBy(await environment(call, '取消组件安装', { type: 'cancelBackendInstall', operationId: operation.operationId }, { ...unknown, unknown: '可能已经取消了，运行 vonvon env backend list 看。' }), 'applied') };
  });
  const human = what === 'install' ? cancelled ? '已取消正在进行的安装。' : '没有在进行的安装。'
    : what === 'login' ? cancelled ? '已取消正在进行的 lark-cli 登录。' : other ? '没有在进行的登录（在进行的是应用配置：用 vonvon env profile init --cancel）。' : '没有在进行的登录。'
    : cancelled ? `已取消组件 ${id} 的安装。` : `组件 ${id} 没有在安装。`;
  print(io, [human], { cancelled });
}
