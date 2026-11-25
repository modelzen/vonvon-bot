import { selfEntry } from '../core/self-entry';
import { badArgs, CommandError, rpcErrorKind } from './command-error';
import { connectLocal, ConnectionError, RpcError, type VonvonClient } from '@vonvon/client';
import { backendLabel, conversationCopy, PROTOCOL_VERSION, requestSchema, type Agent, type Membership, type Scope, type ServerInfo } from '@vonvon/protocol';
import { paths } from '../config/paths';
import { inBotSession, SESSION_BOT_ENV, SESSION_ENV } from '../config/session-env';
import { looksLikeSessionToken, SESSION_TOKEN_INVALID } from '../host/session-tokens';
import { verifyPidLockOwner } from '../server/owner-verification';
import { PidLockError, readRunningPidLock } from '../server/pid-lock';

/** Where a command prints; `json` switches stdout to one JSON line, `{ ok: true, … }`. The entry point formats failures for --json. */
export type Io = { json: boolean; write(text: string): void };
export type Call = <T>(what: string, run: (c: VonvonClient) => Promise<T>, o?: { feishu?: boolean; provider?: boolean; unknown?: string; ms?: number }) => Promise<T>;
/** One connection for the whole command; s47 passes its own connector through `withDaemon`. `info`: the daemon's server info, when the connector has it. */
export type Daemon = <T>(fn: (call: Call, info?: ServerInfo) => Promise<T>) => Promise<T>;
export type DaemonConnection = { client: VonvonClient; serverInfo: ServerInfo };
/**
 * Feishu calls get longer than the supervisor's 60 s IPC timeout, so the daemon's own error arrives first. `provider`:
 * a call that may start a Provider (a bot's settings read, save, action or model list, or the daemon's Provider list)
 * waits past the 120 s admin/ipc.ts adminIpcTimeout gives those, for the same reason.
 */
export const TIMEOUTS = { local: 30_000, feishu: 75_000, provider: 125_000 };
type Timeouts = { local: number; feishu: number; provider?: number };
/** How long a command cut short by Ctrl-C waits for the connection's close handshake. */
const CLOSE_AFTER_INTERRUPT = 200;

const VERSION_MISMATCH = 'daemon 和命令行的版本不一致。先 vonvon daemon stop，再 vonvon daemon start。';
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
const lines = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join('\n');
const isZodError = (error: unknown): boolean => error instanceof Error && error.name === 'ZodError';
class CallTimeout extends Error {}
class BadRequest extends Error {}
/** C0, DEL and C1: a name from Feishu must not move the cursor or start an escape sequence. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
export const printable = (text: string): string => text.replace(CONTROL, '');

/** devices 15. */
const SESSION_TOKEN_MISSING = '这是 Bot 会话，但没有有效的会话令牌，不能以主人身份运行。';

/** What every command's connection carries (devices-4a 4.9): the global `--scope`, the environment it runs in, and whether the daemon took it for a private chat's session. */
const context: { scope?: Scope; env: NodeJS.ProcessEnv; dm?: boolean } = { env: process.env };
/** index.ts sets the parsed `--scope` before a command runs; tests set both. */
export function setCliContext(next: { scope?: Scope | undefined; env?: NodeJS.ProcessEnv }): void {
  if ('scope' in next) { if (next.scope) context.scope = next.scope; else delete context.scope; }
  if (next.env) context.env = next.env;
}
/** The global `--scope` this command was given, if any. */
export const cliScope = (): Scope | undefined => context.scope;
/** The environment this command runs in. */
export const cliEnv = (): NodeJS.ProcessEnv => context.env;
/** This command runs in a Bot's session: the daemon knows which Bot it is on. */
export const cliInSession = (): boolean => inBotSession(context.env);
/** Whether the latest `withDaemon` negotiation authenticated this caller as a DM bot session. */
export const cliIsDmSession = (): boolean => Boolean(context.dm);

/**
 * devices 5.3 and 8.3: an owner's `--scope` is the daemon's to apply. A read that falls back to the files with no daemon
 * cannot apply it, so with one given it wants the daemon instead of quietly ignoring it (Codex review 251-1).
 */
export const SCOPE_NEEDS_DAEMON = '给了 --scope 时要 daemon 在运行：范围由 daemon 核对，命令行不读本机文件。';
/** The connection's own words, then why the files are no way round it. */
export const scopeNeedsDaemon = (error: unknown): CommandError =>
  new CommandError('connection', `${error instanceof Error ? error.message : String(error)}\n${SCOPE_NEEDS_DAEMON}`, error instanceof CommandError ? error : {});

/**
 * In a Bot's session (devices 5.3) a command acts as the session, never as the owner: its token goes in the hello,
 * `local-credential` is not read, and without a valid token nothing connects at all.
 */
export async function connectLocalDaemon(home = paths.appDir, cliEntry = selfEntry(), env: NodeJS.ProcessEnv = context.env): Promise<DaemonConnection> {
  const session = inBotSession(env);
  const token = env[SESSION_ENV];
  if (session && !looksLikeSessionToken(token)) throw new CommandError('refused', SESSION_TOKEN_MISSING, { reason: 'session_token_missing' });
  let lock;
  try { lock = await readRunningPidLock(home); }
  catch (error) { throw new CommandError('connection', `连不上 daemon：${firstLine(error)}`); }
  if (!lock) throw new CommandError('connection', 'daemon 没有运行。先运行 vonvon daemon start。');
  if (!lock.listen) throw new CommandError('connection', 'daemon 正在启动，稍后再试。');
  // Covers a missing or wrong local-credential too: the check is an authenticated round trip. A session connects to the
  // lock's port as it is (devices-4a 4.9): the check would read local-credential.
  if (!session) {
    try { await verifyPidLockOwner(home, lock); }
    catch (error) {
      if (error instanceof PidLockError) throw new CommandError('connection', `连不上 daemon（PID ${lock.pid}）：本机凭据对不上，或者这个 PID 已经不是 daemon。运行 vonvon daemon status 查看。`);
      throw error;
    }
  }
  if (!cliEntry) throw new CommandError('connection', 'Cannot locate the daemon CLI entry.');
  let connected: DaemonConnection;
  try { connected = await connectLocal({ home, cliEntry, ...(session && token ? { credential: token } : {}) }); }
  catch (error) {
    // The child printed {"running":false}: the daemon stopped between the lock check and discovery.
    if (isZodError(error)) throw new CommandError('connection', 'daemon 刚刚停止了。先运行 vonvon daemon start。');
    if (error instanceof ConnectionError && error.closeReason === 'invalid_session_token') throw new CommandError('refused', SESSION_TOKEN_INVALID, { reason: 'session_token_invalid' });
    const message = firstLine(error);
    if (message === 'Daemon closed during handshake') throw new CommandError('connection', 'daemon 在握手时断开了：本机凭据对不上，或者 daemon 刚好停止或重启了。稍后重试，或运行 vonvon daemon status 查看。');
    if (message === 'Daemon handshake timed out') throw new CommandError('connection', '和 daemon 握手超时。');
    throw new CommandError('connection', `连不上 daemon：${message}`);
  }
  // A daemon of another protocol answers only the maintenance kinds (devices 4.5); daemon stop and status do not come here.
  if (connected.serverInfo.protocolVersion !== PROTOCOL_VERSION) {
    await connected.client.close().catch(() => undefined);
    throw new CommandError('connection', VERSION_MISMATCH);
  }
  return connected;
}

function translate(what: string, error: unknown, ms: number, unknown?: string): Error {
  if (error instanceof BadRequest) return new CommandError('bad-args', `${what}没有发出：命令行给的参数不对（${error.message}）。`);
  if (error instanceof CallTimeout) return new CommandError(unknown ? 'outcome-unknown' : 'connection', lines(`daemon 在 ${ms / 1000} 秒内没有回应（${what}）。`, unknown, '运行 vonvon daemon logs 查看。'));
  // The bot process timed out or exited after the request reached it: the change may still land, so not "failed".
  if (error instanceof RpcError && unknown && error.code === 'operation_failed') return new CommandError('outcome-unknown', lines(`${what}没有确认：${error.message}`, unknown));
  // A settings change outside a private chat (s1b): the sentence alone, not "读取设置失败：…" from the read a write starts with.
  if (error instanceof RpcError && error.code === 'not-dm') return new CommandError(rpcErrorKind(error.code), error.message, { reason: error.code });
  if (error instanceof RpcError) return new CommandError(rpcErrorKind(error.code), lines(`${what}失败：${error.message}`, error.code === 'unsupported' ? 'daemon 可能比命令行旧。' : undefined), { reason: error.code });
  if (error instanceof ConnectionError || firstLine(error) === 'Daemon connection closed') return new CommandError(unknown ? 'outcome-unknown' : 'connection', lines('和 daemon 的连接断了，daemon 可能正在停止。', unknown));
  // checkRequests already parsed the request, so the client's own ZodError is a reply this CLI cannot read.
  if (isZodError(error)) return new CommandError(unknown ? 'outcome-unknown' : 'connection', lines(VERSION_MISMATCH, unknown));
  return new CommandError(unknown ? 'outcome-unknown' : 'failed', lines(`${what}失败：${firstLine(error)}`, unknown));
}

/** Client method → RPC method; snapshot() always sends the same payload. */
const METHODS = {
  run: 'command', settings: 'settings', collaboration: 'collaboration', environment: 'environment', machine: 'machine', admin: 'admin', directory: 'directory',
  library: 'library', memory: 'memory', contextPreview: 'contextPreview', device: 'device',
} as const;

/**
 * The client zod-parses a request before sending it and the reply after, and both throw a ZodError. Parsing the
 * request here first, with the same schema, tells a bad request (nothing sent) from a reply this CLI cannot read.
 */
function checkRequests(client: VonvonClient): VonvonClient {
  const checked: Record<string, unknown> = { ...client };
  for (const [name, method] of Object.entries(METHODS)) {
    const send = (client as unknown as Record<string, ((payload: unknown) => Promise<unknown>) | undefined>)[name];
    if (!send) continue;
    checked[name] = (payload: unknown) => {
      const parsed = requestSchema.safeParse({ type: 'request', id: 'cli', method, payload });
      if (parsed.success) return send.call(client, payload);
      const issue = parsed.error.issues[0];
      return Promise.reject(new BadRequest(issue ? `${issue.path.slice(1).join('.') || method}：${issue.message}` : parsed.error.message));
    };
  }
  return checked as unknown as VonvonClient;
}

/** Errors keep their line breaks; daemon or Feishu text inside them loses its control characters. */
function printableError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message.split('\n').map(printable).join('\n');
  return message === error.message ? error : error instanceof CommandError ? new CommandError(error.kind, message, error) : new Error(message);
}

/**
 * `connect` may give a bare client (the tests' fakes) or a connection with the server info. In a Bot's session, or
 * with `--scope`, the first request is admin.negotiate (devices 5.3): a scope the daemon refuses ends the command
 * with the daemon's words.
 */
export async function withDaemon<T>(fn: (call: Call, info?: ServerInfo) => Promise<T>, connect: () => Promise<VonvonClient | DaemonConnection> = () => connectLocalDaemon(), timeouts: Timeouts = TIMEOUTS): Promise<T> {
  const connected = await connect();
  const { client, serverInfo } = 'serverInfo' in connected ? connected : { client: connected, serverInfo: undefined };
  const checked = checkRequests(client);
  const call: Call = async (what, run, o = {}) => {
    const ms = o.ms ?? (o.provider ? timeouts.provider ?? TIMEOUTS.provider : o.feishu ? timeouts.feishu : timeouts.local);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CallTimeout()), ms); });
    // race keeps a handler on the losing call, so its late "connection closed" from close() is handled.
    try { return await Promise.race([run(checked), timeout]); }
    catch (error) { throw translate(what, error, ms, o.unknown); }
    finally { clearTimeout(timer); }
  };
  // Ordinary commands exit when the event loop drains, so an open socket would hang the CLI.
  let interrupted = false;
  try {
    context.dm = false;
    if (inBotSession(context.env) || context.scope) {
      const scope = context.scope;
      // A private chat's session has no `--scope` (dm-agent 6.1): it negotiates without one.
      const refusal = await call('核对范围', c => c.admin({ type: 'negotiate', capabilities: ['cli'], ...(scope ? { scope } : {}) })
        .then(reply => { context.dm = reply?.kind === 'negotiated' && reply.principal === 'bot-session:dm'; }, (error: unknown) => { if (error instanceof RpcError) return error; throw error; }));
      if (refusal) throw new CommandError(rpcErrorKind(refusal.code), refusal.message, { reason: refusal.code });
    }
    return await fn(call, serverInfo);
  }
  catch (error) { interrupted = error instanceof CommandError && error.kind === 'interrupted'; throw printableError(error); }
  finally {
    const closed = client.close().catch(() => undefined);
    // Ctrl-C: the daemon may be the one not answering (a cancel never answered, cli-7-environment), and the process exits
    // on a failure anyway (index.ts): its close handshake does not hold the command up
    let timer: NodeJS.Timeout | undefined;
    if (interrupted) await Promise.race([closed, new Promise<void>(done => { timer = setTimeout(done, CLOSE_AFTER_INTERRUPT); })]);
    else await closed;
    clearTimeout(timer);
  }
}

/** `--fresh` (devices 8.1): the daemon probes the tools and rebuilds its snapshot, which it otherwise does every 5 s,
 * before the command reads. A write needs none: the daemon rebuilds before it answers one. */
export const freshDaemon: Daemon = fn => withDaemon(async (call, info) => {
  await call('刷新状态', c => c.run({ type: 'refresh', tools: true }));
  return fn(call, info);
});

/** Throws the reply's own message unless it is the expected kind. */
export function want<R extends { kind: string }, K extends R['kind']>(what: string, reply: R, kind: K, unknown?: string): Extract<R, { kind: K }> {
  if (reply.kind === kind) return reply as Extract<R, { kind: K }>;
  const message = 'message' in reply && typeof reply.message === 'string' ? reply.message : undefined;
  if (message !== undefined && (reply.kind === 'refused' || reply.kind === 'outcomeUnknown' || reply.kind === 'activationPending')) {
    throw new CommandError(reply.kind === 'outcomeUnknown' ? 'outcome-unknown' : 'refused', lines(`${what}没有完成：${message}`, reply.kind === 'outcomeUnknown' ? unknown : undefined));
  }
  throw new CommandError('failed', `${what}没有完成：daemon 回了意外的结果（${reply.kind}）。`);
}

export const NO_BOT = '还没有 Bot。运行 vonvon bot add 在终端里扫码注册，或者在网页里注册（vonvon open）。';

/** No "current bot": without --bot, only a single bot is picked, or a private chat's own. By id first, then by name (`memory --bot` gets the files' bots too). */
export function pickBot<A extends { id: string; name: string }>(agents: readonly A[], wanted?: string): A {
  const [only] = agents;
  if (!only) throw badArgs(NO_BOT);
  // Error lines keep their own breaks (printableError), so a name loses a line break of its own here.
  const list = agents.map(agent => `${printable(agent.name)}（${agent.id}）`).join('、');
  if (wanted === undefined) {
    if (agents.length === 1) return only;
    const own = inBotSession(context.env) ? agents.find(agent => agent.id === context.env[SESSION_BOT_ENV]) : undefined;
    if (own) return own;
    throw badArgs(`有 ${agents.length} 个 Bot，用 --bot 指定：${list}`);
  }
  const byId = agents.find(agent => agent.id === wanted);
  if (byId) return byId;
  const named = agents.filter(agent => agent.name === wanted);
  if (named.length > 1) throw badArgs(`有 ${named.length} 个 Bot 都叫「${wanted}」，用 id 指定：${named.map(agent => agent.id).join('、')}`);
  if (named[0]) return named[0];
  throw badArgs(`没有找到 Bot「${wanted}」。现有的 Bot：${list}`);
}

/** A bot that answers now: collaboration requests go to its process, which a stopped or paused bot does not have. */
export function runningBot(agents: readonly Agent[], wanted?: string): Agent {
  const agent = pickBot(agents, wanted);
  if (!agent.running) throw new CommandError('refused', `Bot「${printable(agent.name)}」没在运行。运行 vonvon bot enable ${agent.id}，或者 vonvon bot status ${agent.id} 看原因。`, { reason: 'bot_not_running' });
  return agent;
}

/**
 * s1b: a group's (or a comment's) Bot session reads a snapshot with no bindings in it, so it cannot name a group. True
 * there; a command then lets the daemon say why not (群里不能改设置), or refuses as the daemon would, never "没有绑定".
 * A private chat reads them all: a Bot with none has none (dm-agent 6.1).
 */
export const bindingsHidden = (memberships: readonly Membership[], bot: Agent): boolean =>
  inBotSession(context.env) && !context.dm && !memberships.some(membership => membership.agentId === bot.id);
/** The daemon's words for what a Bot session may not do (server/authz.ts SESSION_DENIED). */
const SESSION_DENIED = '这个操作不能从 Bot 会话里做。';

/** Group id or project name; both are unique per bot because bind refuses a duplicate project name. */
export function pickGroup(memberships: readonly Membership[], bot: Agent, wanted: string): Membership {
  if (bindingsHidden(memberships, bot)) throw new CommandError('refused', SESSION_DENIED, { reason: 'permission_denied' });
  const own = memberships.filter(membership => membership.agentId === bot.id);
  const found = own.find(membership => membership.groupId === wanted) ?? own.find(membership => membership.name === wanted);
  if (!found) throw badArgs(`Bot「${printable(bot.name)}」没有绑定「${wanted}」。用 vonvon group list 查看。`);
  return found;
}

/** Each human line is printed without control characters; --json keeps the daemon's text as it is, after `ok: true`. */
export function print<T extends object>(io: Io, human: string[], json: T & { ok?: never }): void {
  if (io.json) io.write(`${JSON.stringify({ ok: true, ...json })}\n`);
  else if (human.length) io.write(`${human.map(printable).join('\n')}\n`);
}

export const withoutAvatar = <T extends { avatarDataUrl?: string }>({ avatarDataUrl: _avatar, ...rest }: T): Omit<T, 'avatarDataUrl'> => rest;
export const toolLabel = backendLabel;
export const conversationLabel = (conversation: string): string => conversation === 'threads' || conversation === 'shared' || conversation === 'smart' ? `${conversationCopy[conversation].name}（${conversationCopy[conversation].title}）` : conversation;
const pad = (value: number): string => String(value).padStart(2, '0');
export function localTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
