import { isAbsolute, join, normalize, relative, sep, dirname, parse, resolve, basename } from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { paths } from '../../config/paths';
import { log } from '../../core/logger';
import { z } from 'zod';
import type { SessionProfile } from '../session-profile';
import type { PermissionMode } from '../types';

export const CODEX_PROTECTED_PATHS = [
  '.mcp.json', '.claude/settings.json', '.claude/settings.local.json',
  '.claude/skills', '.claude/commands', '.claude/agents', '.codex', '.agents/skills',
] as const;

type Root = SessionProfile['additionalRoots'][number];

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** Filesystem admission/realpath happens in config/directories; reject ambiguous wire paths. */
export function codexWorkspaceRoots(opts: { cwd: string; mode?: PermissionMode; profile?: SessionProfile }): Root[] {
  const roots: Root[] = [{ path: opts.cwd, access: opts.mode === 'qa' ? 'read' : 'write' }];
  for (const root of opts.profile?.additionalRoots ?? []) {
    if (roots.some(existing => existing.path === root.path && existing.access !== root.access)) {
      throw new Error('Codex 工作区根权限冲突');
    }
    if (!roots.some(existing => existing.path === root.path)) roots.push(root);
  }
  for (const root of roots) {
    if (!isAbsolute(root.path) || root.path.includes('\0') || normalize(root.path) !== root.path) {
      throw new Error('Codex 工作区必须使用规范化绝对路径');
    }
    if (root.access !== 'read' && root.access !== 'write') throw new Error('Codex 工作区权限无效');
  }
  if ((opts.mode ?? 'full') === 'full') return roots;
  if (roots.some(root => ['/private/tmp', '/private/var/tmp', '/tmp', '/var/tmp'].some(scratch => contains(root.path, scratch)))) {
    throw new Error('受限工作区不能覆盖平台临时目录边界');
  }
  for (const root of roots) {
    for (const other of roots) {
      if (root === other || !contains(other.path, root.path)) continue;
      if ((root.access === 'write' && other.access === 'read')
        || CODEX_PROTECTED_PATHS.some(path => contains(join(other.path, path), root.path))) {
        throw new Error('Codex 工作区重叠会覆盖只读或原生配置保护');
      }
    }
  }
  return roots;
}

export type CodexInstallRoot = { path: string; kind: 'dir' | 'file' };
const installRoots = new Map<string, { root: CodexInstallRoot; bin: string }>();
const PackageSchema = z.object({ name: z.literal('@openai/codex') });

function safeInstallRoot(candidate: CodexInstallRoot, bin: string, roots: readonly Root[]): CodexInstallRoot {
  const depth = relative(parse(candidate.path).root, candidate.path).split(sep).filter(Boolean).length;
  const credentialRoots = [join(homedir(), '.codex'), resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))]
    .flatMap(path => {
      try { return [path, realpathSync(path)]; } catch { return [path]; }
    });
  if (candidate.kind === 'dir' && (depth <= 2 || ['bin', 'sbin'].includes(basename(candidate.path))
    || candidate.path === homedir() || credentialRoots.some(path => contains(candidate.path, path))
    || contains(candidate.path, paths.appDir) || roots.some(root => contains(candidate.path, root.path)))) {
    return { path: bin, kind: 'file' };
  }
  return candidate;
}

/** Resolve Codex's own runtime files, without granting access to shared directories. */
export function codexInstallRoot(bin: string, roots: readonly Root[] = []): CodexInstallRoot {
  const cached = installRoots.get(bin);
  if (cached) return safeInstallRoot(cached.root, cached.bin, roots);
  let target: string;
  try { target = realpathSync(bin); }
  catch (error) {
    target = resolve(bin);
    log.fail('agent', error, { phase: 'codex-install-root' });
  }
  let directory = dirname(target);
  let candidate: CodexInstallRoot = { path: directory, kind: 'dir' };
  for (;;) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (PackageSchema.safeParse(raw).success) { candidate = { path: directory, kind: 'dir' }; break; }
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  candidate = safeInstallRoot(candidate, target, []);
  installRoots.set(bin, { root: candidate, bin: target });
  return safeInstallRoot(candidate, target, roots);
}

export function codexFilesystem(roots: readonly Root[], mode: 'qa' | 'write', installRoot?: CodexInstallRoot,
  platform: NodeJS.Platform = process.platform, network = false) {
  const entries = roots.map(root => [root.path, {
    '.': mode === 'qa' ? 'read' : root.access,
    ...Object.fromEntries(CODEX_PROTECTED_PATHS.filter(path => {
      if (platform !== 'linux') return true;
      try { lstatSync(join(root.path, path)); return true; } catch { return false; }
    }).map(path => [path, 'read'])),
  }]);
  const runtime: Record<string, { '.': string }> = {};
  if (installRoot) runtime[installRoot.path] = { '.': 'read' };
  if (platform === 'linux' && network) {
    try { runtime[realpathSync('/etc/resolv.conf')] = { '.': 'read' }; } catch {}
  }
  return { ':minimal': 'read', ':workspace_roots': { '.': 'read' },
    '/private/tmp': { '.': 'read' }, '/private/var/tmp': { '.': 'read' }, ...runtime, ...Object.fromEntries(entries) };
}

const SandboxSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dangerFullAccess') }),
  z.object({ type: z.literal('readOnly'), networkAccess: z.boolean() }),
  z.object({
    type: z.literal('workspaceWrite'), writableRoots: z.array(z.string()), networkAccess: z.boolean(),
    excludeTmpdirEnvVar: z.boolean(), excludeSlashTmp: z.boolean(),
  }),
]);
const WorkspaceEchoSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
  cwd: z.string(), runtimeWorkspaceRoots: z.array(z.string()), sandbox: SandboxSchema,
  approvalPolicy: z.literal('never'),
  activePermissionProfile: z.object({ id: z.string(), extends: z.string().nullable() }).nullish(),
});

function samePaths(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length
    && expected.every(path => actual.includes(path));
}

/** Legacy sandbox is only a projection; native probes establish the eight path exclusions. */
export function verifyCodexWorkspaceEcho(raw: unknown, opts: {
  cwd: string; mode?: PermissionMode; network?: boolean; profile?: SessionProfile; sessionId?: string;
}): void {
  const parsed = WorkspaceEchoSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Codex 缺少可核对的工作区权限回显（s39a）');
  const echo = parsed.data;
  const roots = codexWorkspaceRoots(opts);
  const fail = (): never => { throw new Error('Codex 工作区或实际权限回显不符（s39a）'); };
  if (opts.sessionId !== undefined && echo.thread.id !== opts.sessionId) fail();
  if (echo.cwd !== opts.cwd || !samePaths(echo.runtimeWorkspaceRoots, roots.map(root => root.path))) fail();
  const mode = opts.mode ?? 'full';
  if (mode === 'full') {
    if (echo.sandbox.type !== 'dangerFullAccess') fail();
    return;
  }
  if (!echo.activePermissionProfile || echo.activePermissionProfile.id !== 'feishu' || echo.activePermissionProfile.extends !== null) fail();
  const writable = mode === 'qa' ? [] : roots.filter(root => root.access === 'write').map(root => root.path);
  if (writable.length === 0) {
    if (echo.sandbox.type !== 'readOnly' || echo.sandbox.networkAccess !== Boolean(opts.network)) fail();
    return;
  }
  if (echo.sandbox.type !== 'workspaceWrite') return fail();
  if (!samePaths(echo.sandbox.writableRoots, writable.filter(path => path !== opts.cwd))
    || echo.sandbox.networkAccess !== Boolean(opts.network)
    || !echo.sandbox.excludeTmpdirEnvVar || !echo.sandbox.excludeSlashTmp) fail();
}
