import { managedCodexBin, runSetupChild } from './managed-install';
import { managedToolSelection } from './managed-tools';
import { CODEX_MIN_VERSION, compareCodexVersions, parseCodexVersion } from './version';
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join, relative, sep } from 'node:path';
import { paths } from '../../config/paths';
import { spawnProcessSync } from '../../platform/spawn';
import { binChildEnv, toolDirectories } from '../../platform/tool-path';
import { ProviderProcessCleanupError, ProviderProcessStoppedError } from '../owned-process';
import {committedBridgeCodex} from '../../import/bridge/markers';

const IS_WIN = process.platform === 'win32';

// Version probes are asynchronous. The hot resolver only reads filesystem metadata.
const resolutionCache = new Map<string, { signature: string; bin: string | null }>();
const resolutionInFlight = new Map<string, Promise<string | null>>();
const versionCache = new Map<string, string>();
const versionInFlight = new Map<string, Promise<string | null>>();
const failedVersionProbes = new Set<string>();
const versionFingerprints = new Map<string, string | null>();
function fingerprint(bin: string): string | null {
  try { const info = statSync(bin); return `${info.mtimeMs}:${info.ctimeMs}:${info.size}`; } catch { return null; }
}

export type CodexResolutionOptions = {
  force?: boolean;
  home?: string;
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
};

function candidates(opts: CodexResolutionOptions): string[] {
  const env = opts.env ?? process.env;
  const root = opts.dataRoot ?? paths.appDir;
  const home = opts.home ?? homedir();
  const selected = managedToolSelection(root, 'codex');
  const found: string[] = [];
  if (selected.kind === 'active') found.push(selected.executable);
  if (selected.kind === 'absent') {
    found.push(...execCandidates(join(root, 'managed-tools', 'bin'), 'codex', env));
    const managed = managedCodexBin(join(root, 'codex-cli'));
    if (managed) found.push(managed);
  }
  // Enumerate PATH directly: no synchronous `which` child on event-loop hot paths.
  const path = env.PATH ?? env.Path ?? env.path ?? '';
  for (const directory of path.split(delimiter).filter(Boolean)) {
    found.push(...execCandidates(directory.replace(/^"|"$/g, ''), 'codex', env)
      .filter(candidate => {
        if (selected.kind !== 'absent' && inLegacyManagedRoot(candidate, root)) return false;
        try { accessSync(candidate, IS_WIN ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
      }));
  }
  const directories = selected.kind === 'absent' ? [join(root, 'codex-cli', 'node_modules', '.bin')] : [];
  if (process.platform === 'darwin') {
    for (const base of ['/Applications', join(home, 'Applications')]) {
      directories.push(join(base, 'Codex.app/Contents/Resources'), join(base, 'Codex.app/Contents/Resources/codex-cli/bin'));
    }
  }
  try {
    const nvm = join(home, '.nvm', 'versions', 'node');
    const versions = readdirSync(nvm).filter(version => /^v\d+\.\d+\.\d+$/.test(version)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    directories.push(...versions.map(version => join(nvm, version, 'bin')));
  } catch {}
  if (IS_WIN) {
    directories.push(join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'),
      join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), join(home, 'scoop', 'shims'),
      join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin'));
    if (env.NVM_SYMLINK) directories.push(env.NVM_SYMLINK);
    if (env.VOLTA_HOME) directories.push(join(env.VOLTA_HOME, 'bin'));
  }
  if (process.platform === 'darwin') {
    directories.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin', join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin'));
  }
  directories.push(...toolDirectories(home));
  for (const directory of directories) found.push(...execCandidates(directory, 'codex', env));
  const imported = committedBridgeCodex(home, root);
  if (imported) found.push(imported);
  return [...new Set(found.filter(candidate => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  }))];
}

function resolutionKey(opts: CodexResolutionOptions): string {
  const env = opts.env ?? process.env;
  return JSON.stringify([opts.home ?? homedir(), opts.dataRoot ?? paths.appDir, env.PATH ?? env.Path ?? env.path, env.PATHEXT, env.APPDATA, env.LOCALAPPDATA, env.NVM_SYMLINK, env.VOLTA_HOME]);
}

function candidateSignature(bins: string[]): string {
  return JSON.stringify(bins.map(bin => [bin, fingerprint(bin)]));
}

export function resolveCodexBin(opts: CodexResolutionOptions = {}): string | null {
  const env = opts.env ?? process.env;
  if (env.CODEX_BIN) return existsSync(env.CODEX_BIN) ? env.CODEX_BIN : null;
  const bins = candidates(opts);
  const cached = resolutionCache.get(resolutionKey(opts));
  if (cached?.signature === candidateSignature(bins)) return cached.bin;
  return bins[0] ?? null;
}

/** Refresh at doctor/setup boundaries; never synchronously probe versions in resolve. */
export async function refreshCodexResolution(opts: CodexResolutionOptions = {}): Promise<string | null> {
  const env = opts.env ?? process.env;
  if (env.CODEX_BIN) return existsSync(env.CODEX_BIN) ? env.CODEX_BIN : null;
  const bins = candidates(opts);
  const signature = candidateSignature(bins);
  const key = resolutionKey(opts);
  const cached = resolutionCache.get(key);
  const pendingKey = JSON.stringify([key, signature]);
  const inFlight = resolutionInFlight.get(pendingKey);
  if (inFlight) return inFlight;
  if (!opts.force && cached?.signature === signature) return cached.bin;
  const pending = probeCandidates(opts, bins, signature).finally(() => {
    resolutionInFlight.delete(pendingKey);
  });
  resolutionInFlight.set(pendingKey, pending);
  return pending;
}

async function probeCandidates(opts: CodexResolutionOptions, bins: string[], signature: string): Promise<string | null> {
  let cursor = 0;
  const versions = new Map<string, string>();
  await Promise.all(Array.from({ length: Math.min(4, bins.length) }, async () => {
    while (cursor < bins.length) {
      const bin = bins[cursor++]!;
      const output = await codexVersionAsync(bin, opts);
      const version = output && /^codex-cli\s/.test(output) ? parseCodexVersion(output) : null;
      if (version) versions.set(bin, version);
    }
  }));
  // A failed candidate never displaces a version-probed working installation.
  const ranked = bins.filter(bin => versions.has(bin)).sort((a, b) => {
    const av = versions.get(a)!;
    const bv = versions.get(b)!;
    const compatible = Number(compareCodexVersions(bv, CODEX_MIN_VERSION) >= 0) - Number(compareCodexVersions(av, CODEX_MIN_VERSION) >= 0);
    if (compatible) return compatible;
    // App-bundled CLIs can carry an alpha suffix even in a released desktop app.
    // Semver prefers stable within the same core version, without letting a much
    // older managed stable hide a newer installed App runtime.
    return compareCodexVersions(bv, av);
  });
  const previous = resolutionCache.get(resolutionKey(opts));
  const chosen = ranked[0] ?? (previous?.signature === signature ? previous.bin : null) ?? null;
  if (signature === candidateSignature(candidates(opts))) {
    if (chosen) resolutionCache.set(resolutionKey(opts), { signature, bin: chosen });
    else resolutionCache.delete(resolutionKey(opts));
    return chosen;
  }
  return resolveCodexBin(opts);
}

function inLegacyManagedRoot(candidate: string, root: string): boolean {
  try {
    const target = realpathSync.native(candidate);
    return [join(root, 'managed-tools'), join(root, 'codex-cli')].some(managed => {
      if (!existsSync(managed)) return false;
      const path = relative(realpathSync.native(managed), target);
      return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
    });
  } catch {
    return true;
  }
}

function execCandidates(dir: string, base: string, env: NodeJS.ProcessEnv): string[] {
  const exact = join(dir, base);
  if (!IS_WIN || extname(base)) return [exact];
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim()).filter(Boolean);
  return [exact, ...exts.map(e => join(dir, base + e.toLowerCase()))];
}

/** Read the existing probe result without starting a child process. */
export function cachedCodexVersion(bin: string): string | null | undefined {
  if (versionFingerprints.has(bin) && versionFingerprints.get(bin) !== fingerprint(bin)) return undefined;
  return versionCache.get(bin) ?? (failedVersionProbes.has(bin) ? null : undefined);
}

/** Best-effort version string of the resolved codex binary（同步，CLI 场景用；
 * 卡片回调等事件循环上下文请用 {@link codexVersionAsync}）。 */
export function codexVersion(bin: string, opts?: { force?: boolean }): string | null {
  if (!opts?.force) {
    const hit = cachedCodexVersion(bin);
    if (typeof hit === 'string') return hit;
  }
  const before = fingerprint(bin);
  let out: string | null;
  try {
    // cross-spawn so a Windows `.cmd` shim runs (avoids execFile EINVAL).
    const res = spawnProcessSync(bin, ['--version'], { encoding: 'utf8', env: binChildEnv(bin) });
    out = res.status === 0 && typeof res.stdout === 'string' ? res.stdout.trim() : null;
  } catch {
    out = null;
  }
  if (before !== fingerprint(bin)) return null;
  versionFingerprints.set(bin, before);
  if (out !== null) {
    versionCache.set(bin, out);
    failedVersionProbes.delete(bin);
  } else {
    versionCache.delete(bin);
    failedVersionProbes.add(bin);
  }
  return out;
}

/** Async counterpart of {@link codexVersion}（共享同一缓存）。卡片回调里
 * **绝不能** spawnSync——同步 `codex --version`（~320ms）会冻结整条 event
 * loop，所有话题的流式 pump、WS 心跳、⏹ 回调一起停摆。 */
export async function codexVersionAsync(bin: string, opts?: { force?: boolean }): Promise<string | null> {
  const before = fingerprint(bin);
  const key = JSON.stringify([bin, before]);
  const inFlight = versionInFlight.get(key);
  if (inFlight) return inFlight;
  if (!opts?.force) {
    const hit = cachedCodexVersion(bin);
    if (typeof hit === 'string') return hit;
  }
  const pending = probeCodexVersion(bin, before).finally(() => versionInFlight.delete(key));
  versionInFlight.set(key, pending);
  return pending;
}

async function probeCodexVersion(bin: string, before: string | null): Promise<string | null> {
  let out: string | null;
  try {
    out = await runSetupChild(bin, ['--version'], {
      // Windows starts the Job Object supervisor (PowerShell + C#) before the CLI.
      cwd: homedir(), env: binChildEnv(bin), signal: new AbortController().signal, timeoutMs: IS_WIN ? 20_000 : 3_000,
    });
  } catch (error) {
    // Unknown process death must not permit a replacement probe to start.
    if (error instanceof ProviderProcessCleanupError && !(error instanceof ProviderProcessStoppedError)) throw error;
    out = null;
  }
  if (before !== fingerprint(bin)) return null;
  versionFingerprints.set(bin, before);
  if (out !== null) {
    versionCache.set(bin, out);
    failedVersionProbes.delete(bin);
  } else {
    versionCache.delete(bin);
    failedVersionProbes.add(bin);
  }
  return out;
}
