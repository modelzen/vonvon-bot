import {createHash} from 'node:crypto';
import {chmod, lstat, mkdir, readFile} from 'node:fs/promises';
import {delimiter, dirname, isAbsolute, join, win32} from 'node:path';
import {z} from 'zod';
import {OwnedProviderProcess, ProviderProcessExitError} from '../agent/owned-process.js';
import {acquireMutex, closeMutex} from '../config/data-access.js';
import {writeFileAtomic} from '../server/atomic-file.js';
import {feedbackActorSchema, FeedbackNotDispatchedError, type FeedbackActor, type FeedbackUserIdentity} from './types.js';

export interface FeedbackCliPort {
  run(actor: FeedbackActor, args: readonly string[], cwd?: string, beforeWrite?: () => Promise<void>): Promise<unknown>;
}

export interface FeedbackBotCredential {
  appId: string;
  appSecret: string;
  registrationKey: string;
}

interface CliContext {
  home: string;
  profile: string;
  environment: NodeJS.ProcessEnv;
}

export const FEEDBACK_SCOPES = ['base:form:read', 'base:form:update', 'base:record:read', 'base:field:read', 'docs:document.media:upload'];
const statusSchema = z.object({
  appId: z.string(), verified: z.literal(true),
  identities: z.object({user: z.object({status: z.enum(['ready', 'needs_refresh']), verified: z.literal(true), available: z.literal(true),
    scope: z.string(), userName: z.string(), openId: z.string()})}),
});
const envelope = z.object({ok: z.boolean(), data: z.unknown().optional()});
const authorizationSchema = z.object({
  device_code: z.string().min(1),
  verification_url: z.string().optional(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number().positive().optional(),
});
const authorizationStateSchema = z.discriminatedUnion('state', [
  z.object({state: z.literal('pending'), deviceCode: z.string().min(1), expiresAt: z.number()}).strict(),
  z.object({state: z.literal('completed'), openId: z.string(), completedAt: z.number()}).strict(),
]);

function dataOf(value: unknown): unknown {
  const parsed = envelope.safeParse(value);
  return parsed.success && parsed.data.ok ? parsed.data.data : value;
}

export function feedbackCliIdentity(value: unknown, actor: FeedbackActor): FeedbackUserIdentity {
  const parsed = statusSchema.safeParse(dataOf(value));
  if (!parsed.success) throw new Error('请先由提交反馈的本人完成飞书授权。');
  const identity = {appId: parsed.data.appId, openId: parsed.data.identities.user.openId, name: parsed.data.identities.user.userName};
  if (identity.appId !== actor.appId || identity.openId !== actor.openId) {
    throw new Error('授权账号与发起反馈的人不一致，请使用本人账号重新授权。');
  }
  const scopes = new Set(parsed.data.identities.user.scope.split(/\s+/));
  if (FEEDBACK_SCOPES.some(scope => !scopes.has(scope))) throw new Error('反馈授权范围不完整，请由本人重新授权所需权限。');
  return identity;
}

export function feedbackCliEnvironment(home: string, executable: string): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const environment: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    LARKSUITE_CLI_CONFIG_DIR: join(home, 'configuration'),
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1', LANG: 'en_US.UTF-8',
    PATH: [dirname(process.execPath), dirname(executable), '/usr/bin', '/bin', ...(process.platform === 'win32' ? [win32.join(systemRoot, 'System32'), systemRoot] : [])].join(delimiter),
    ...(process.platform === 'win32' ? {SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: win32.join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: process.env.TEMP, TMP: process.env.TMP} : {}),
  };
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

export class IsolatedFeedbackCli implements FeedbackCliPort {
  private readonly children = new Set<OwnedProviderProcess>();
  private readonly lifetime = new AbortController();

  constructor(private readonly options: {
    root: string;
    executable: string;
    credential: (actor: FeedbackActor) => Promise<FeedbackBotCredential>;
    timeoutMs?: number;
  }) {
    if (!isAbsolute(options.root) || !isAbsolute(options.executable)) throw new Error('反馈授权需要宿主提供本地私有目录与已安装工具。');
    if (process.platform === 'win32') throw new Error('当前反馈授权暂不支持 Windows 的多人凭据隔离。');
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    const results = await Promise.allSettled([...this.children].map(child => child.close()));
    const errors = results.flatMap(result => result.status === 'rejected' && !(result.reason instanceof ProviderProcessExitError) ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, '反馈工具尚未完成退出。');
  }

  private async context(actorInput: FeedbackActor): Promise<CliContext> {
    const actor = feedbackActorSchema.parse(actorInput);
    this.lifetime.signal.throwIfAborted();
    const credential = await this.options.credential(actor);
    if (credential.appId !== actor.appId || !credential.appSecret || !credential.registrationKey) throw new Error('当前 Bot 的授权配置已变化，请重新核对。');
    const generation = createHash('sha256').update(credential.appSecret).digest('hex');
    const key = createHash('sha256').update(JSON.stringify([actor.botId, actor.appId, credential.registrationKey, generation, actor.tenantKey, actor.openId])).digest('hex');
    const home = join(this.options.root, key);
    await mkdir(home, {recursive: true, mode: 0o700});
    const directory = await lstat(home);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('反馈授权的本地目录不可用。');
    await chmod(home, 0o700);
    const context = {home, profile: actor.appId, environment: feedbackCliEnvironment(home, this.options.executable)};
    const mutex = await acquireMutex(home, 'creation', 45000);
    try {
      const marker = join(home, 'configured.json');
      let configured = false;
      try {
        const value: unknown = JSON.parse(await readFile(marker, 'utf8'));
        configured = z.object({appId: z.literal(actor.appId)}).safeParse(value).success;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (!configured) {
        await this.execute(context, ['config', 'init', '--app-id', actor.appId, '--app-secret-stdin', '--name', 'feedback'], home, credential.appSecret + '\n');
        await writeFileAtomic(marker, JSON.stringify({appId: actor.appId}), {durable: true});
      }
    } finally {await closeMutex(mutex);}
    return context;
  }

  async run(actor: FeedbackActor, args: readonly string[], cwd?: string, beforeWrite?: () => Promise<void>): Promise<unknown> {
    let started = false;
    try {
      const context = await this.context(actor);
      const mutex = await acquireMutex(context.home, 'creation', 45000);
      try {
        if (args[0] !== 'auth') feedbackCliIdentity(await this.execute(context, ['auth', 'status', '--json', '--verify', '--profile', context.profile], context.home), actor);
        await beforeWrite?.();
        return await this.execute(context, [...args, '--profile', context.profile], cwd ?? context.home, undefined, false, () => {started = true;});
      } finally {await closeMutex(mutex);}
    } catch (error) {
      if (args[0] === 'base' && args[1] === '+form-submit' && !started) throw new FeedbackNotDispatchedError();
      throw error;
    }
  }

  async beginAuthorization(actor: FeedbackActor): Promise<{verificationUrl: string; qrPath: string; expiresAt: number}> {
    const context = await this.context(actor);
    const mutex = await acquireMutex(context.home, 'creation', 45000);
    try {
      const value = await this.execute(context, ['auth', 'login', '--scope', FEEDBACK_SCOPES.join(' '), '--no-wait', '--json', '--profile', context.profile], context.home);
      const authorization = authorizationSchema.parse(dataOf(value));
      const verificationUrl = authorization.verification_uri_complete ?? authorization.verification_url;
      if (!verificationUrl) throw new Error('飞书尚未返回可用的授权入口。');
      const url = new URL(verificationUrl);
      if (url.protocol !== 'https:' || !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname)) throw new Error('飞书授权入口无效。');
      const expiresAt = Date.now() + Math.min(authorization.expires_in ?? 600, 1800) * 1000;
      await writeFileAtomic(join(context.home, 'authorization.json'), JSON.stringify({state: 'pending', deviceCode: authorization.device_code, expiresAt}), {durable: true});
      await this.execute(context, ['auth', 'qrcode', verificationUrl, '--output', 'authorization.png'], context.home, undefined, true);
      return {verificationUrl, qrPath: join(context.home, 'authorization.png'), expiresAt};
    } finally {await closeMutex(mutex);}
  }

  async finishAuthorization(actor: FeedbackActor): Promise<FeedbackUserIdentity> {
    const context = await this.context(actor);
    const mutex = await acquireMutex(context.home, 'creation', 45000);
    try {
      const pending = authorizationStateSchema.parse(JSON.parse(await readFile(join(context.home, 'authorization.json'), 'utf8')));
      if (pending.state === 'completed') {
        if (pending.openId !== actor.openId) throw new Error('本次授权与当前提交人不一致。');
        return feedbackCliIdentity(await this.execute(context, ['auth', 'status', '--json', '--verify', '--profile', context.profile], context.home), actor);
      }
      if (pending.expiresAt <= Date.now()) throw new Error('授权已过期，请重新开始。');
      try {
        await this.execute(context, ['auth', 'login', '--device-code', pending.deviceCode, '--json', '--profile', context.profile], context.home);
        const identity = feedbackCliIdentity(await this.execute(context, ['auth', 'status', '--json', '--verify', '--profile', context.profile], context.home), actor);
        await writeFileAtomic(join(context.home, 'authorization.json'), JSON.stringify({state: 'completed', openId: identity.openId, completedAt: Date.now()}), {durable: true});
        return identity;
      }
      catch (error) {
        await this.execute(context, ['auth', 'logout', '--json', '--profile', context.profile], context.home);
        throw error;
      }
    } finally {await closeMutex(mutex);}
  }

  private async execute(context: CliContext, args: string[], cwd: string, secret?: string, textOutput = false, beforeStart?: () => void): Promise<unknown> {
    this.lifetime.signal.throwIfAborted();
    beforeStart?.();
    const owner = new OwnedProviderProcess(this.options.executable, args, {
      cwd, env: context.environment, stdio: [secret === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    }, 'Feedback lark-cli');
    this.children.add(owner);
    let stdout = '', stderr = '', outputBytes = 0;
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      void owner.close().catch(() => undefined);
    };
    const collect = (text: string, target: 'out' | 'err') => {
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > 256000) return stop('反馈工具返回内容过大。');
      if (target === 'out') stdout += text; else stderr += text;
    };
    owner.child.stdout?.setEncoding('utf8').on('data', (text: string) => collect(text, 'out'));
    owner.child.stderr?.setEncoding('utf8').on('data', (text: string) => collect(text, 'err'));
    owner.child.stdin?.on('error', () => undefined);
    if (secret !== undefined) owner.child.stdin?.end(secret);
    const onAbort = () => stop('反馈操作已取消。');
    this.lifetime.signal.addEventListener('abort', onAbort, {once: true});
    const timer = setTimeout(() => stop('反馈工具请求超时；请先查询本次操作结果，不要重复提交。'), this.options.timeoutMs ?? 35000);
    try {
      const exit = await owner.exited;
      try {await owner.close();} catch (error) {if (!(error instanceof ProviderProcessExitError)) throw error;}
      if (failure) throw failure;
      if (exit.code !== 0) throw new Error('飞书请求未完成，请检查本人的授权及所需权限。');
      if (textOutput) return undefined;
      const value: unknown = JSON.parse(stdout);
      const parsed = envelope.safeParse(value);
      if (parsed.success && !parsed.data.ok) throw new Error('飞书拒绝了本次操作，请核对授权及目标配置。');
      return value;
    } finally {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener('abort', onAbort);
      try {await owner.close();}
      catch (error) {if (!(error instanceof ProviderProcessExitError)) throw error;}
      finally {
        // Stopped errors also confirm that the complete tree is gone.
        if (owner.unconfirmedPid === undefined) this.children.delete(owner);
        stderr = '';
      }
    }
  }
}
