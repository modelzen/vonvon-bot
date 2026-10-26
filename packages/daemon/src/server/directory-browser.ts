import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { folderTokenSchema, type FolderChoice, type FolderToken } from '@vonvon/protocol';
import { RpcError } from './errors';
import { createDirectorySuggestions } from './directory-suggestions';

export async function createDirectoryBrowser(home = homedir()) {
  const root = await realpath(home);
  const tokens = new Map<FolderToken, { path: string; expiresAt: number }>();
  const suggestions = createDirectorySuggestions();
  function contained(path: string) {
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new RpcError('outside_home', '目录必须位于用户主目录内。');
  }
  async function canonical(path: string): Promise<string> {
    const resolved = await realpath(path);
    contained(resolved);
    if (!(await stat(resolved)).isDirectory()) throw new RpcError('invalid_directory', '请选择文件夹。');
    return resolved;
  }
  return {
    suggest: (query: string) => suggestions.search(root, query),
    close: () => suggestions.close(),
    async list(path = root) {
      const resolved = await canonical(path);
      const children = await readdir(resolved, { withFileTypes: true });
      const entries = [];
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue;
        try {
          const path = await canonical(join(resolved, child.name));
          entries.push({ name: child.name, path, hidden: child.name.startsWith('.') });
        } catch (error) {
          if (error instanceof RpcError || (error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'ELOOP'].includes(String(error.code)))) continue;
          throw error;
        }
      }
      return { kind: 'entries' as const, path: resolved, parent: resolved === root ? null : dirname(resolved), entries: entries.slice(0, 1000), truncated: entries.length > 1000 };
    },
    async choose(path: string): Promise<FolderChoice> {
      const resolved = await canonical(path);
      const now = Date.now();
      for (const [token, entry] of tokens) if (entry.expiresAt <= now) tokens.delete(token);
      const token = folderTokenSchema.parse(randomUUID());
      tokens.set(token, { path: resolved, expiresAt: now + 10 * 60_000 });
      return { token, displayPath: resolved };
    },
    async resolve(token: FolderToken): Promise<string> {
      const entry = tokens.get(token);
      if (!entry || entry.expiresAt <= Date.now()) {
        tokens.delete(token);
        throw new RpcError('invalid_folder_token', '目录选择已过期，请重新选择。');
      }
      return canonical(entry.path);
    },
  };
}
export type DirectoryBrowser = Awaited<ReturnType<typeof createDirectoryBrowser>>;
