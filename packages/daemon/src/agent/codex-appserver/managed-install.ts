import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import { OwnedProviderProcess } from '../owned-process';

export const privateCodexBin = (prefix: string): string => join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'codex.cmd' : 'codex');

export function managedCodexBin(codexCliDir = paths.codexCliDir): string | null {
  try {
    const data: unknown = JSON.parse(readFileSync(join(codexCliDir, 'current.json'), 'utf8'));
    if (!data || typeof data !== 'object' || !('generation' in data) || typeof data.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(data.generation)) return null;
    const bin = privateCodexBin(join(codexCliDir, 'releases', data.generation));
    return existsSync(bin) ? bin : null;
  } catch { return null; }
}

export async function runSetupChild(command: string, args: string[], options: { cwd: string; signal: AbortSignal; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string> {
  options.signal.throwIfAborted();
  const owned = new OwnedProviderProcess(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stop: () => void = () => {};
  const interrupted = new Promise<undefined>(resolve => { stop = () => resolve(undefined); });
  let timedOut = false;
  owned.child.stdout?.on('data', data => { if (output.length < 8192) output += String(data).slice(0, 8192 - output.length); });
  owned.child.stderr?.resume();
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 300_000);
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  try {
    const result = await Promise.race([owned.exited, interrupted]);
    await owned.close();
    options.signal.throwIfAborted();
    if (timedOut) throw new Error('安装工具运行超时');
    if (result?.code !== 0) throw new Error(`安装工具退出，状态码 ${result?.code}`);
    return output.trim();
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', stop);
  }
}

/** Compatibility entry point for the original setup API; all installs share one engine. */
export async function installManagedCodex(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (process.env.CODEX_BIN) throw new Error('当前使用显式 CODEX_BIN，请先移除此覆盖再安装托管 Codex');
  const [{ EnvironmentService }, { refreshCodexResolution }] = await Promise.all([
    import('../../environment/service'), import('./locate'),
  ]);
  signal.throwIfAborted();
  const service = new EnvironmentService({
    home: homedir(), getDataRoot: () => paths.appDir, nodePath: process.execPath,
    resolveCodex: () => refreshCodexResolution({ force: true }), installSignal: signal, requireTrustedNpm: true,
  });
  try {
    const reply = await service.run({ type: 'install', tool: 'codex' });
    if (reply.kind !== 'applied') {
      signal.throwIfAborted();
      throw new Error(reply.kind === 'refused' ? reply.message : 'Codex 安装未完成');
    }
  } finally {
    await service.close();
  }
}
