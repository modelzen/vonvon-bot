import type { Stats } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StartThreadOptions } from '../types';
import { CODEX_PROTECTED_PATHS, codexWorkspaceRoots } from './workspace-policy';

/** Unsafe layouts must not be retried as a fresh conversation by the restore path. */
export class CodexWorkspaceLayoutError extends Error {
  constructor() { super('工作区的原生配置布局无法安全检查，请移除保护文件的硬链接或异常条目后重试'); }
}

/** Read metadata only, before every restricted start/resume. Never alter owner files. */
export async function admitCodexWorkspaceLayout(opts: Pick<StartThreadOptions, 'cwd' | 'mode' | 'profile'>): Promise<void> {
  if ((opts.mode ?? 'full') === 'full') return;
  async function inspect(path: string, directory: boolean, optional: boolean): Promise<void> {
    let info: Stats;
    try { info = await lstat(path); }
    catch (error) {
      if (optional && error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new CodexWorkspaceLayoutError();
    if (info.isFile()) {
      if (directory || info.nlink !== 1) throw new CodexWorkspaceLayoutError();
      return;
    }
    if (!directory || !info.isDirectory()) throw new CodexWorkspaceLayoutError();
    for (const entry of await readdir(path)) {
      const child = join(path, entry);
      const kind = await lstat(child);
      // Only regular files/directories are traversable. A disappearing entry or any
      // failed read aborts admission instead of accepting an incomplete walk.
      await inspect(child, kind.isDirectory(), false);
    }
  }
  try {
    for (const root of codexWorkspaceRoots(opts)) {
      const canonical = await realpath(root.path);
      if (!(await lstat(canonical)).isDirectory()) throw new CodexWorkspaceLayoutError();
      for (const protectedPath of CODEX_PROTECTED_PATHS) {
        const target = join(canonical, protectedPath);
        let parent = dirname(target);
        const ancestors: string[] = [];
        while (parent !== canonical) { ancestors.unshift(parent); parent = dirname(parent); }
        let absent = false;
        for (const ancestor of ancestors) {
          try {
            const info = await lstat(ancestor);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new CodexWorkspaceLayoutError();
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { absent = true; break; }
            throw error;
          }
        }
        if (!absent) await inspect(target, protectedPath === '.codex' || protectedPath.endsWith('/skills')
          || protectedPath.endsWith('/commands') || protectedPath.endsWith('/agents'), true);
      }
    }
  } catch { throw new CodexWorkspaceLayoutError(); }
}
