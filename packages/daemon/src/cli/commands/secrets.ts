import { RpcError } from '@vonvon/client';
import type { AdminReply, SecretService, SecretUse } from '@vonvon/protocol';
import { describeKeystoreError, keyProblem, secretsAction, type SecretsRequest, type SecretsView } from '../../admin/secrets';
import { getSecret, removeSecret, setSecret } from '../../config/keystore';
import { paths } from '../../config/paths';
import { inBotSession } from '../../config/session-env';
import { readStdin } from '../../core/stdin';
import { InputCancelled, readHidden } from '../../core/terminal-input';
import { decisionProviders, type DecisionProvider } from '../../judge/decision';
import { readRunningPidLock } from '../../server/pid-lock';
import { badArgs, CommandError } from '../command-error';
import { print, printable, want, withDaemon, type Daemon, type Io } from '../daemon-client';

const SESSION_REFUSED = '这组命令不能在 Bot 的会话里用。在网页的密钥页填或删，或者在自己的终端里运行。';
const ARGS_REFUSED = 'key 不写在命令参数里（会进 shell 的历史）。直接运行 vonvon secrets set <名字>，按提示粘贴；脚本里从标准输入传进来。';
const REMOVE_ARGS_REFUSED = '只写一个名字，后面多写了东西，没有删。';
/** A save may wait out the keystore's 30 s lock across processes. */
const SAVE_MS = 45_000;

export interface SecretsContext {
  io: Io;
  /** stderr: a note that the files were written here */
  warn(text: string): void;
  env: NodeJS.ProcessEnv;
  /** the key: asked for without echo on a terminal, else all of stdin */
  readKey(prompt: string): Promise<string>;
  /** a daemon holds the data root: requests then go to it, so it logs them and is the one writer */
  daemonRunning(): Promise<boolean>;
  daemon: Daemon;
  /** without a daemon: this process, on the files */
  direct(request: SecretsRequest): Promise<AdminReply>;
}

export function terminalContext(io: Io): SecretsContext {
  return {
    io, env: process.env,
    warn: text => { process.stderr.write(text); },
    readKey: prompt => process.stdin.isTTY ? readHidden(prompt, process.stdin, process.stderr) : readStdin(),
    // a lock that cannot be read counts as a daemon: connecting says why, and nothing is written behind its back
    daemonRunning: () => readRunningPidLock(paths.appDir).then(Boolean, () => true),
    daemon: withDaemon,
    direct: request => secretsAction(request),
  };
}

type Send = (what: string, request: SecretsRequest, ms?: number) => Promise<AdminReply>;
/** Who answered: the running daemon, or this process on the files (devices 8.3). */
type Source = 'daemon' | 'files';
/** Connects before asking for the key. A daemon from before s23g refuses these requests as invalid; the files are
 * then written here, which the keystore's lock across processes allows. */
async function route<T>(ctx: SecretsContext, run: (send: Send, view: SecretsView, source: Source) => Promise<T>): Promise<T> {
  const direct: Send = (_what, request) => ctx.direct(request);
  const local = async (): Promise<T> => run(direct, want('读密钥库', await direct('读密钥库', { type: 'secrets' }), 'secrets'), 'files');
  if (!await ctx.daemonRunning()) return local();
  const done = await ctx.daemon(async call => {
    const first = await call('读密钥库', c => c.admin({ type: 'secrets' }).catch((error: unknown) => {
      if (error instanceof RpcError && error.code === 'invalid_request') return undefined;
      throw error;
    }));
    if (!first) return undefined;
    const send: Send = (what, request, ms) => call(what, c => c.admin(request), ms ? { ms } : {});
    return { value: await run(send, want('读密钥库', first, 'secrets'), 'daemon') };
  });
  if (done) return done.value;
  ctx.warn('daemon 比命令行旧，不认这组请求，这次直接改本机的文件。之后运行 vonvon daemon restart。\n');
  return local();
}

function refuseInSession(ctx: SecretsContext): void {
  if (inBotSession(ctx.env)) throw new CommandError('refused', SESSION_REFUSED, { reason: 'not_in_session' });
}
/** Never echoes the name it was given: a key typed in its place would land on the screen. */
function service(name: string): DecisionProvider {
  const found = decisionProviders().find(p => p.keyId === name);
  if (!found) throw badArgs(`不认识这个名字。能用的名字：${decisionProviders().map(p => `${p.keyId}（${p.displayName}）`).join('、')}`);
  return found;
}

const useText = (u: SecretUse): string => u.groupId === undefined ? `${u.agentName}（Bot 默认）`
  : `${u.groupName || '未命名飞书群'}（${[u.agentName, u.inherited && '跟着 Bot 默认', u.notSmart && '现在不是智能群'].filter(Boolean).join('，')}）`;
const statusText = (s: SecretService): string => s.status === 'set' ? `已填${s.last4 ? ` ••••${s.last4}` : ''}`
  : s.status === 'missing' ? '还没填'
  : s.status === 'invalid' ? '存着的 key 不能用（有空格或看不见的字符），重新填一次'
  : `读不了：${s.problem}（${s.code}）。vonvon daemon logs 里的 secrets.unreadable 有原话`;

/** Whose choices are missing from `inUse`, and where the logs say why. */
const unreadNotes = (view: SecretsView): string[] => [
  ...view.botsUnreadable ? ['Bot 清单（bots.json）读不了，谁选了它没算进来；vonvon daemon logs 里的 secrets.bots-unreadable 有原因。'] : [],
  ...view.unreadBots ? [`有 ${view.unreadBots} 个 Bot 的设置读不了，没算进来；vonvon daemon logs 里的 secrets.bot-unreadable 有原因。`] : [],
];

/** Exits 1 when a key cannot be read, after listing everything; --json then has the list in `error.partial`. */
export async function runSecretsList(ctx: SecretsContext): Promise<void> {
  refuseInSession(ctx);
  const { view, source } = await route(ctx, async (_send, first, source) => ({ view: first, source }));
  const human = view.services.flatMap(s => [
    `${s.displayName}（${s.keyId}）  ${statusText(s)}`,
    `  ${s.inUse.length ? `在用：${s.inUse.map(useText).join('、')}` : '现在没有 Bot 或飞书群选它'}`,
  ]);
  human.push(...unreadNotes(view));
  const json = { source, services: view.services, unreadBots: view.unreadBots, ...(view.botsUnreadable ? { botsUnreadable: true } : {}) };
  const unreadable = view.services.filter(s => s.status === 'unreadable');
  if (!unreadable.length) { print(ctx.io, human, json); return; }
  if (!ctx.io.json) print(ctx.io, human, json);
  throw new CommandError('failed', `读不了 ${unreadable.map(s => s.displayName).join('、')} 的 key，原因见上面。`, { reason: unreadable[0]?.code ?? 'unreadable', partial: json });
}

function testText(reply: AdminReply, keyId: string): string {
  if (reply.kind !== 'secretTested') return `没试成：${reply.kind === 'refused' ? reply.message : reply.kind}`;
  if (reply.outcome === 'ok' || reply.outcome === 'busy') return `试了一次：${reply.message}`;
  const next = reply.outcome === 'auth' ? '换一个 key' : 'key 已经存下，要再试一次';
  return `试了一次：${reply.message}。${next}：重新运行 vonvon secrets set ${keyId}`;
}

/** `secrets set <名字>`: the key from a hidden prompt or stdin, never an argument; saved, then tried once. */
export async function runSecretsSet(name: string, extra: string[], options: { raw?: boolean }, ctx: SecretsContext): Promise<void> {
  refuseInSession(ctx);
  if (extra.length) throw badArgs(ARGS_REFUSED);
  try {
    if (options.raw) { await rawSet(name, ctx); return; }
    const provider = service(name);
    await route(ctx, async (send, first, source) => {
      // a keystore that cannot be read refuses the save too: say so before the key crosses the terminal
      const current = first.services.find(s => s.keyId === provider.keyId);
      if (current?.status === 'unreadable') throw new CommandError('failed', `没有存：${provider.displayName} 的 key ${statusText(current)}`, { reason: current.code ?? 'unreadable' });
      const value = (await ctx.readKey(`粘贴 ${provider.displayName} 的 key（不回显），回车结束：`)).trim();
      const problem = keyProblem(value);
      if (problem) throw badArgs(`没有存：${problem}。`);
      const view = want('存 key', await send('存 key', { type: 'setSecret', keyId: provider.keyId, value }, SAVE_MS), 'secrets');
      const last4 = view.services.find(s => s.keyId === provider.keyId)?.last4;
      const saved = `✓ 已存 ${provider.displayName} 的 key${last4 ? `（末四位 ${last4}）` : ''}`;
      // the try can take a while: a terminal sees the save first
      if (!ctx.io.json) ctx.io.write(`${saved}\n`);
      const tested = await send('试 key', { type: 'testSecret', keyId: provider.keyId });
      const test = tested.kind === 'secretTested' ? { outcome: tested.outcome, message: tested.message } : { message: testText(tested, provider.keyId) };
      print(ctx.io, [testText(tested, provider.keyId)], { source, keyId: provider.keyId, ...(last4 ? { last4 } : {}), test });
    });
  } catch (error) {
    if (error instanceof InputCancelled) throw new CommandError('interrupted', '已取消，没有存。');
    throw error;
  }
}

/** `--raw <id>`: an entry by its id, for internal use and repairs; no shape check, no daemon. */
async function rawSet(id: string, ctx: SecretsContext): Promise<void> {
  const value = (await ctx.readKey(`粘贴 ${printable(id)} 的值（不回显），回车结束：`)).trim();
  if (!value) throw badArgs('没有读到值：从标准输入传进来，或者在终端里按提示粘贴。');
  await setSecret(id, value);
  print(ctx.io, [`✓ 已存储密钥: ${id}`], { source: 'files', id, stored: true });
}

/** `secrets remove <名字>`; anything after the name is refused unechoed, as for `set`. */
export async function runSecretsRemove(name: string, extra: string[], options: { raw?: boolean }, ctx: SecretsContext): Promise<void> {
  refuseInSession(ctx);
  if (extra.length) throw badArgs(REMOVE_ARGS_REFUSED);
  if (options.raw) {
    const removed = await removeSecret(name);
    print(ctx.io, [removed ? `✓ 已删除: ${name}` : `未找到: ${name}`], { source: 'files', id: name, removed });
    return;
  }
  const provider = service(name);
  await route(ctx, async (send, _first, source) => {
    const view = want('删 key', await send('删 key', { type: 'removeSecret', keyId: provider.keyId }, SAVE_MS), 'secrets');
    const uses = view.services.find(s => s.keyId === provider.keyId)?.inUse ?? [];
    print(ctx.io, !view.removed ? [`${provider.displayName} 的 key 本来就没填。`] : [
      `✓ 已删 ${provider.displayName} 的 key。`,
      ...uses.length ? [`还选着它的：${uses.map(useText).join('、')}；它们要判断的消息按出错处理（没 @ Bot 的不回，@ 的回在主区），重新填就恢复。`] : [],
      ...unreadNotes(view),
    ], { source, keyId: provider.keyId, removed: Boolean(view.removed), inUse: uses });
  });
}

/** lark-cli's exec provider (1.0.98, the same protocol as OpenClaw's). */
export const EXEC_PROTOCOL_VERSION = 1;
export interface ExecReply {
  protocolVersion: typeof EXEC_PROTOCOL_VERSION;
  values: Record<string, string>;
  errors: Record<string, { message: string }>;
}
export type ExecRequest = { ids: string[] } | { ids: string[]; problem: string };

export function parseExecRequest(input: string): ExecRequest {
  let request: unknown;
  try { request = JSON.parse(input); }
  catch { return { ids: [], problem: 'invalid request JSON' }; }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return { ids: [], problem: 'invalid request JSON' };
  let ids: string[] = [];
  if ('ids' in request) {
    if (!Array.isArray(request.ids) || !request.ids.every((id: unknown) => typeof id === 'string')) {
      return { ids: [], problem: 'invalid request: ids must be an array of strings' };
    }
    ids = [...new Set<string>(request.ids)];
  }
  if ('protocolVersion' in request && request.protocolVersion !== EXEC_PROTOCOL_VERSION) {
    return { ids, problem: 'unsupported protocolVersion: only 1' };
  }
  return { ids };
}

/** Decision provider keys stay inside the daemon; bot sessions may only resolve App Secrets. */
export async function secretValues(ids: string[], read: typeof getSecret = getSecret): Promise<ExecReply> {
  const kept = new Set(decisionProviders().map(p => p.keyId));
  const values: [string, string][] = [];
  const errors: [string, { message: string }][] = [];
  for (const id of ids) {
    if (kept.has(id)) { errors.push([id, { message: 'not handed out: only the daemon reads this key' }]); continue; }
    try {
      const value = await read(id);
      if (value !== undefined) values.push([id, value]);
      else errors.push([id, { message: 'not found' }]);
    } catch (error) {
      const { problem, code } = describeKeystoreError(error);
      errors.push([id, { message: `${problem}（${code}）` }]);
    }
  }
  return { protocolVersion: EXEC_PROTOCOL_VERSION, values: Object.fromEntries(values), errors: Object.fromEntries(errors) };
}

function failAll(ids: string[], message: string): ExecReply {
  return { protocolVersion: EXEC_PROTOCOL_VERSION, values: {}, errors: Object.fromEntries((ids.length ? ids : ['_']).map(id => [id, { message }])) };
}

/** Writes one v1 reply so lark-cli receives errors without exposing filesystem paths. */
export async function secretsGet(io = { input: readStdin, write: (text: string): void => { process.stdout.write(text); } }): Promise<void> {
  let ids: string[] = [];
  let reply: ExecReply;
  try {
    const request = parseExecRequest(await io.input());
    ids = request.ids;
    reply = 'problem' in request ? failAll(ids, request.problem) : await secretValues(ids);
  } catch (error) {
    const { code } = describeKeystoreError(error);
    reply = failAll(ids, `secrets get 出错了（${code}）`);
  }
  io.write(`${JSON.stringify(reply)}\n`);
}
