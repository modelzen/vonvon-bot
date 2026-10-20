import { isAbsolute, join, normalize, relative, sep } from 'node:path';
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

export function codexFilesystem(roots: readonly Root[], mode: 'qa' | 'write') {
  const entries = roots.map(root => [root.path, {
    '.': mode === 'qa' ? 'read' : root.access,
    ...Object.fromEntries(CODEX_PROTECTED_PATHS.map(path => [path, 'read'])),
  }]);
  return { ':minimal': 'read', ':workspace_roots': { '.': 'read' }, ...Object.fromEntries(entries) };
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
