import { realpath, stat, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { PermissionMode } from '../types';
import { TIER_NAMES } from '../permission/types';

/** Claude tiers use default/acceptEdits/bypassPermissions. The sandbox proxy is
 * not an offline boundary: SandboxNetworkAccess must be denied by the callback.
 * PreToolUse also checks writes because settings allow rules can skip callbacks.
 * Resolve links before checking the workspace; missing suffixes never fold '..'. */
export interface ClaudeAccess {
  mode: PermissionMode;
  network: boolean;
  cwd: string;
  realCwd: string;
  additionalRoots?: readonly { path: string; access: 'read' | 'write' }[];
}
export function claudeAccess(mode: PermissionMode | undefined, network: boolean | undefined, cwd: string, realCwd: string, additionalRoots?: ClaudeAccess['additionalRoots']): ClaudeAccess {
  return { mode: mode ?? 'full', network: network ?? false, cwd, realCwd, ...(additionalRoots?.length ? { additionalRoots } : {}) };
}
export function tierMode(mode: PermissionMode): 'default' | 'acceptEdits' | 'bypassPermissions' {
  return mode === 'qa' ? 'default' : mode === 'write' ? 'acceptEdits' : 'bypassPermissions';
}
export const FILE_WRITE = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
export const FILE_READ = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'];
const NETWORK_TOOLS = ['WebFetch', 'WebSearch'];
export type ClaudePermissionOptions = Pick<Options,
  'permissionMode' | 'allowDangerouslySkipPermissions' | 'sandbox' | 'disallowedTools' | 'allowedTools' | 'hooks'>;
export function permissionOptions(access: ClaudeAccess): ClaudePermissionOptions {
  const base = { permissionMode: tierMode(access.mode), allowDangerouslySkipPermissions: true };
  if (access.mode === 'full') return base;
  return {
    ...base,
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      ...(access.mode === 'qa' || access.additionalRoots?.length ? { filesystem: {
        ...(access.mode === 'qa' ? { denyWrite: [...new Set([access.cwd, access.realCwd, ...access.additionalRoots?.map(root => root.path) ?? []])] }
          : { allowWrite: access.additionalRoots?.filter(root => root.access === 'write').map(root => root.path) ?? [], denyWrite: access.additionalRoots?.filter(root => root.access === 'read').map(root => root.path) ?? [] }),
      } } : {}),
    },
    ...(access.network ? { allowedTools: NETWORK_TOOLS } : { disallowedTools: NETWORK_TOOLS }),
    hooks: { PreToolUse: [{ matcher: FILE_WRITE.join('|'), hooks: [fileHook(access)], timeout: 10 }] },
  };
}
export type Origin = 'hook' | 'callback';
export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
  decisionReason?: string;
  extra: Record<string, unknown>;
}
export type Verdict = { kind: 'continue' } | { kind: 'allow' } | { kind: 'deny'; message: string }
  | { kind: 'ask'; ask: 'choices' | 'confirmation' | 'permission' };
export interface PathFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{ dev: number; ino: number }>;
  lstat(p: string): Promise<unknown>;
}
const nativeFs: PathFs = { realpath, stat, lstat };
const fsError = z.object({ code: z.string() });
function missing(error: unknown): boolean {
  const parsed = fsError.safeParse(error);
  return parsed.success && ['ENOENT', 'ENOTDIR'].includes(parsed.data.code);
}
class OutsideWorkspace extends Error {}
export async function resolveReal(p: string, cwd: string, fsx: PathFs): Promise<string> {
  let prefix = isAbsolute(p) ? p : `${cwd}${sep}${p}`;
  const suffix: string[] = [];
  for (;;) {
    try {
      const resolved = await fsx.realpath(prefix);
      if (suffix.some(part => part === '.' || part === '..')) throw new OutsideWorkspace();
      return suffix.length ? `${resolved}${sep}${suffix.join(sep)}` : resolved;
    } catch (error) {
      if (!missing(error)) throw error;
      try {
        await fsx.lstat(prefix);
      } catch (entryError) {
        if (!missing(entryError)) throw entryError;
        // Slice the original string: dirname() would normalize link/../ first.
        const end = prefix.lastIndexOf(sep);
        if (end < 0 || prefix === sep) throw error;
        suffix.unshift(prefix.slice(end + 1));
        prefix = end === 0 ? sep : prefix.slice(0, end);
        continue;
      }
      // Existing directory entry whose target cannot resolve: dangling symlink.
      throw new OutsideWorkspace();
    }
  }
}
export function inside(base: string, target: string, fold = false): boolean {
  const rel = relative(fold ? base.toLowerCase() : base, fold ? target.toLowerCase() : target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export async function within(base: string, target: string, fsx: PathFs): Promise<boolean> {
  if (inside(base, target)) return true;
  const root = await fsx.stat(base);
  for (let p = target;; p = dirname(p)) {
    try {
      const current = await fsx.stat(p);
      if (current.dev === root.dev && current.ino === root.ino) return true;
    } catch (error) { if (!missing(error)) throw error; }
    if (dirname(p) === p) return false;
  }
}
/** SDK 0.3.296 preflight B/E/J: rule is explicit, while workingDir,
 * sensitive-file safetyCheck and the default MCP prompt are not ask rules. */
export function ownAsk(call: ToolCall): 'rule' | 'other' {
  return call.extra.decisionReasonType === 'rule' ? 'rule' : 'other';
}
export const PERMISSION_ERROR = '权限检查出错，这一步先不做。';
export const PERMISSION_TIMEOUT = '权限检查超时，这一步先不做。';
export const NO_TURN = '现在没有在进行的对话，没法问人。按你自己的判断继续，或者停下来说明。';
const deny = (message: string): Verdict => ({ kind: 'deny', message });
// Keep directory identity in this session, never across resumed sessions.
const sessions = new WeakMap<ClaudeAccess, PathFs>();
function sessionFs(access: ClaudeAccess): PathFs {
  let fsx = sessions.get(access);
  if (!fsx) {
    let identity: ReturnType<PathFs['stat']> | undefined;
    fsx = { ...nativeFs, stat: p => p === access.realCwd ? identity ??= nativeFs.stat(p) : nativeFs.stat(p) };
    sessions.set(access, fsx);
  }
  return fsx;
}
export async function decide(access: ClaudeAccess, call: ToolCall, origin: Origin, fsx: PathFs = sessionFs(access)): Promise<Verdict> {
  const { toolName: tool, input } = call;
  if (origin === 'callback') {
    if (tool === 'AskUserQuestion') return { kind: 'ask', ask: 'choices' };
    if (tool === 'ExitPlanMode') return { kind: 'ask', ask: 'confirmation' };
    if (tool === 'EnterPlanMode') return { kind: 'allow' };
    if (access.mode === 'full') return { kind: 'ask', ask: 'permission' };
  }
  const own = (): Verdict => deny(`这一步 Claude 标成了要人确认（${call.decisionReason ?? '命中了设置里的规则'}）。这个群的权限是${TIER_NAMES[access.mode]}，这类操作直接拒绝。换个办法，或者停下来说明。`);
  if (origin === 'callback' && ownAsk(call) === 'rule') return own();
  if (origin === 'callback' && ['SandboxNetworkAccess', ...NETWORK_TOOLS].includes(tool)) {
    if (access.network) return { kind: 'allow' };
    const host = tool === 'SandboxNetworkAccess' && typeof input.host === 'string' ? input.host.slice(0, 100) : '外网';
    const next = access.mode === 'write' ? '要联网得请主人在群设置里重新选一次工作区可写，或者改成完全访问。'
      : '要联网得请主人把群的权限改成工作区可写或完全访问。';
    return deny(`这个群的权限不联网，连不上 ${host}。不要再试着联网，换个办法，或者停下来说明：${next}`);
  }
  if (origin === 'callback' && tool === 'Bash') {
    if (input.dangerouslyDisableSandbox === true) return deny('这个群的命令只能在沙箱里跑。');
    return call.extra.decisionReasonType === 'safetyCheck' ? own() : { kind: 'allow' };
  }
  if (!FILE_WRITE.includes(tool) || access.mode === 'full') return { kind: origin === 'hook' ? 'continue' : 'allow' };
  const path = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof path !== 'string') return deny(PERMISSION_ERROR);
  const shown = path.slice(0, 200);
  if (access.mode === 'qa') return deny(`这个群的权限是只读，不能写文件（${shown}）。换个不用写文件的办法，或者停下来说明：要写文件得请主人把群的权限改成工作区可写。`);
  let allowed: boolean;
  try {
    const target = await resolveReal(path, access.cwd, fsx);
    const roots = [access.realCwd, ...access.additionalRoots?.filter(root => root.access === 'write').map(root => root.path) ?? []];
    allowed = (await Promise.all(roots.map(root => within(root, target, fsx)))).some(Boolean);
    if ((await Promise.all((access.additionalRoots ?? []).filter(root => root.access === 'read').map(root => within(root.path, target, fsx)))).some(Boolean)) allowed = false;
  }
  catch (error) { if (!(error instanceof OutsideWorkspace)) throw error; allowed = false; }
  if (!allowed) return deny(`这个群的权限是工作区可写，只能写工作区里的文件，${shown} 在工作区以外。改写到工作区里，或者停下来说明。`);
  return { kind: origin === 'hook' ? 'continue' : 'allow' };
}
export function fileHook(access: ClaudeAccess, fsx: PathFs = sessionFs(access)): HookCallback {
  return async input => {
    try {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const parsed = z.record(z.string(), z.unknown()).parse(input.tool_input);
      const verdict = await decide(access, { toolName: input.tool_name, input: parsed, extra: {} }, 'hook', fsx);
      if (verdict.kind !== 'deny') return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.message } };
    } catch {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PERMISSION_ERROR } };
    }
  };
}
