import { homedir } from 'node:os';
import { AppServerClient } from './app-server-client';
import { codexVersionAsync, refreshCodexResolution } from './locate';
import { connectGated } from './client-pool';
import { codexModelCacheKey } from './models';
import { ProviderProcessCleanupError, ProviderProcessStoppedError } from '../owned-process';

export interface CodexSetup {
  installation: 'missing' | 'installed' | 'unknown';
  authentication: 'signedOut' | 'signedIn' | 'notRequired' | 'unknown';
  version: string | null;
  executable: string | null;
  message?: string;
}
export class CodexSetupConflict extends Error {}
class SetupDisplayError extends Error {}

function accountState(raw: unknown): 'signedOut' | 'signedIn' | 'notRequired' {
  if (!raw || typeof raw !== 'object' || !('requiresOpenaiAuth' in raw) || typeof raw.requiresOpenaiAuth !== 'boolean' || !('account' in raw)) throw new SetupDisplayError('Codex 账户状态响应无效');
  if (!raw.requiresOpenaiAuth) return 'notRequired';
  if (raw.account === null) return 'signedOut';
  if (typeof raw.account === 'object' && raw.account && 'type' in raw.account && (raw.account.type === 'chatgpt' || raw.account.type === 'apiKey')) return 'signedIn';
  throw new SetupDisplayError('Codex 账户状态响应无效');
}
/** Reads which Codex the daemon would run and its account state. Installing is `environment.install` and signing in is
 * Codex's own (devices-ui-2 4.9: the old install and device-code login jobs are gone). */
export class CodexSetupService {
  private readonly cleanupFailures = new Map<string, ProviderProcessCleanupError>();
  private closed = false;
  private probe: { abort: AbortController; done: Promise<CodexSetup>; refresh: boolean } | undefined;
  private queuedProbe: Promise<CodexSetup> | undefined;
  private closing: Promise<void> | undefined;
  private cached: { key: string; value: CodexSetup } | undefined;

  setup(opts?: { refresh?: boolean }): Promise<CodexSetup> {
    if (this.closed) throw new CodexSetupConflict('daemon 正在退出');
    if (this.cleanupFailures.size) throw new CodexSetupConflict('此前 Codex 子进程清理未确认，请先退出并检查');
    if (this.probe) {
      if (!opts?.refresh || this.probe.refresh) return this.probe.done;
      return this.queuedProbe ??= this.probe.done.catch(() => undefined).then(() => {
        this.queuedProbe = undefined;
        return this.setup({ refresh: true });
      });
    }
    const abort = new AbortController();
    const done = this.readSetup(abort.signal, opts?.refresh === true).catch(error => {
      // The failed probe still reports its error, but confirmed death permits a new attempt.
      if (error instanceof ProviderProcessCleanupError && !(error instanceof ProviderProcessStoppedError)) this.cleanupFailures.set('probe', error);
      throw error;
    }).finally(() => { this.probe = undefined; });
    this.probe = { abort, done, refresh: opts?.refresh === true };
    return done;
  }

  private client(bin: string): AppServerClient {
    return new AppServerClient({ bin, cwd: homedir(), clientName: 'vonvon-codex-setup', quietOutput: true, initializeTimeoutMs: 10_000 });
  }

  private async readSetup(signal: AbortSignal, refresh: boolean): Promise<CodexSetup> {
    const bin = await refreshCodexResolution(refresh ? { force: true } : undefined);
    signal.throwIfAborted();
    if (!bin) return { installation: process.env.CODEX_BIN ? 'unknown' : 'missing', authentication: 'unknown', version: null, executable: null, message: process.env.CODEX_BIN ? `CODEX_BIN 指向不可用的文件：${process.env.CODEX_BIN}` : '尚未安装 Codex' };
    // Explicit CODEX_BIN resolution has no version evidence until this call.
    let version = await codexVersionAsync(bin, process.env.CODEX_BIN && refresh ? { force: true } : undefined);
    const key = codexModelCacheKey(bin);
    if (!refresh && this.cached?.key === key) return this.cached.value;
    this.cached = undefined;
    const client = this.client(bin);
    const stop = (): void => { void client.close().catch(() => undefined); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (!version || !/^codex-cli \S+$/.test(version)) throw new SetupDisplayError('所选文件不是可识别的 Codex CLI');
      signal.throwIfAborted();
      await connectGated(client, bin);
      const authentication = accountState(await client.request('account/read', { refreshToken: false }, 10_000));
      if (key !== codexModelCacheKey(bin)) throw new SetupDisplayError('检测期间 Codex 配置已变化，请重新检测');
      const value: CodexSetup = { installation: 'installed', authentication, version, executable: bin, message: `当前 Codex：${bin}` };
      this.cached = { key, value };
      return value;
    } catch (error) {
      if (error instanceof ProviderProcessCleanupError) throw error;
      return { installation: version && /^codex-cli \S+$/.test(version) ? 'installed' : 'unknown', authentication: 'unknown', version, executable: bin, message: `无法确认当前 Codex 的账户状态：${bin}` };
    } finally {
      signal.removeEventListener('abort', stop);
      await client.close();
    }
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      this.probe?.abort.abort();
      await Promise.all([this.probe?.done, this.queuedProbe?.catch(error => { if (!(error instanceof CodexSetupConflict)) throw error; })]);
      if (this.cleanupFailures.size) throw new AggregateError([...this.cleanupFailures.values()], 'Codex 子进程清理未确认');
    })();
    return this.closing;
  }
}
