import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { opendir, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { folderTokenSchema, type DirectoryEntry, type FolderChoice, type FolderToken } from '@vonvon/protocol';
import { RpcError } from './errors';

const SUGGESTION_LIMIT = 50;
const SEARCH_ENTRY_LIMIT = 4000;
const SEARCH_DIRECTORY_LIMIT = 256;
const SEARCH_DEPTH_LIMIT = 8;
const DISCOVERY_EXCLUDES = new Set(['Library', 'OrbStack', 'Virtual Machines', 'Virtual Machines.localized', 'Parallels', 'node_modules', 'vendor', 'venv', '.venv', 'dist', 'build', 'target', 'out', 'coverage', '__pycache__']);
const fileErrorCode = (error: unknown) => error instanceof Error && 'code' in error ? String(error.code) : undefined;
const inaccessible = (error: unknown) => ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(fileErrorCode(error) ?? '');
class SearchTimeout extends Error {}

function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SearchTimeout()), Math.max(0, deadline - Date.now()));
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

// A timed-out filesystem call cannot be cancelled by Node. Keep counting it until it
// settles, and share pending metadata reads, so repeated typing cannot consume all
// four libuv filesystem threads with the same stalled mount.
function createSearchIO() {
  const pending = new Map<string, {promise: Promise<unknown>; expired: boolean}>();
  return async function read<T>(key: string, operation: () => Promise<T>, deadline: number, shared = true, late?: (value: T) => void): Promise<T> {
    for (;;) {
      if (Date.now() >= deadline) throw new SearchTimeout();
      const existing = pending.get(key);
      if (existing) {
        if (existing.expired) throw new SearchTimeout();
        if (shared) return beforeDeadline(existing.promise as Promise<T>, deadline);
        await beforeDeadline(existing.promise.then(() => undefined, () => undefined), deadline);
        continue;
      }
      if (pending.size < 2) break;
      await beforeDeadline(Promise.race([...pending.values()].map(entry => entry.promise.then(() => undefined, () => undefined))), deadline);
    }
    const operationPromise = operation();
    const entry = {promise: operationPromise, expired: false};
    pending.set(key, entry);
    const settled = () => { if (pending.get(key) === entry) pending.delete(key); };
    operationPromise.then(settled, settled);
    try { return await beforeDeadline(operationPromise, deadline); }
    catch (error) {
      if (error instanceof SearchTimeout) {
        entry.expired = true;
        // opendir may finish after the caller has left; it still owns a handle.
        if (late) void operationPromise.then(late, () => undefined).catch(() => undefined);
      }
      throw error;
    }
  };
}

export async function createDirectoryBrowser(home = homedir()) {
  const root = await realpath(home);
  const tokens = new Map<FolderToken, { path: string; expiresAt: number }>();
  const searchIO = createSearchIO();
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
  const entryFor = (path: string, name = basename(path)): DirectoryEntry => ({name, path, hidden: name.startsWith('.')});
  async function suggestions(query: string) {
    const typed = query.trim();
    const entries = new Map<string, DirectoryEntry>();
    const budget = {entries: SEARCH_ENTRY_LIMIT, directories: SEARCH_DIRECTORY_LIMIT, deadline: Date.now() + 1500, truncated: false};
    let path: string | null = null;
    const rooted = isAbsolute(typed) || typed === '~' || typed.startsWith('~/');
    const discovery = Boolean(typed && !rooted);
    const ioDeadline = () => discovery ? Math.min(budget.deadline, Date.now() + 200) : budget.deadline;
    async function searchCanonical(path: string) {
      const resolved = await searchIO(`realpath:${path}`, () => realpath(path), ioDeadline());
      contained(resolved);
      const info = await searchIO(`stat:${resolved}`, () => stat(resolved), ioDeadline());
      if (!info.isDirectory()) throw new RpcError('invalid_directory', '请选择文件夹。');
      return resolved;
    }
    function exhausted() {
      const limited = budget.entries <= 0 || budget.directories <= 0 || Date.now() >= budget.deadline;
      if (limited) budget.truncated = true;
      return limited;
    }
    // Use an iterator so a single enormous folder cannot allocate an unbounded listing.
    async function children(directory: string) {
      if (exhausted()) return [];
      const candidates: Array<DirectoryEntry & {symlink: boolean}> = [];
      budget.directories--;
      // Recheck before every read, including queued descendants and explicit typed paths.
      const safeDirectory = await searchCanonical(directory);
      const handle = await searchIO(`open:${safeDirectory}`, () => opendir(safeDirectory, {bufferSize: 64}), ioDeadline(), false, handle => { void handle.close().catch(() => undefined); });
      let reading: Promise<Dirent | null> | undefined;
      try {
        while (!exhausted()) {
          const child = await searchIO(`read:${safeDirectory}`, () => reading = handle.read(), ioDeadline(), false);
          if (!child) break;
          budget.entries--;
          // Do this before metadata calls: even stat/realpath on virtual mounts can hang.
          if (discovery && (child.name.startsWith('.') || DISCOVERY_EXCLUDES.has(child.name) || /\.(?:pvm|vmwarevm)$/.test(child.name))) continue;
          if (child.isDirectory() || child.isSymbolicLink()) {
            try {
              const safe = await searchCanonical(join(safeDirectory, child.name));
              candidates.push({...entryFor(safe, child.name), symlink: child.isSymbolicLink()});
            } catch (error) {
              if (error instanceof SearchTimeout) budget.truncated = true;
              else if (!(error instanceof RpcError) && !inaccessible(error)) throw error;
            }
          }
        }
      } catch (error) {
        if (error instanceof SearchTimeout) budget.truncated = true;
        else throw error;
      } finally {
        // Closing during a pending read is invalid. Release it when that read settles,
        // but never make the RPC wait for a stalled read or close to complete.
        void Promise.resolve(reading).catch(() => undefined).then(() => handle.close()).catch(() => undefined);
      }
      return candidates.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (!typed || rooted) {
      // Keep aliases such as macOS /var -> /private/var working, but canonicalize the
      // directory before listing it. A non-existent leaf is a completion query.
      const requested = !typed || typed === '~' ? root : typed.startsWith('~/') ? resolve(root, typed.slice(2)) : resolve(typed);
      let prefix = '';
      try {
        path = await searchCanonical(requested);
        entries.set(path, entryFor(path));
      } catch (error) {
        if (fileErrorCode(error) !== 'ENOENT' || typed.endsWith('/')) throw error;
        path = await searchCanonical(dirname(requested));
        prefix = basename(requested).toLocaleLowerCase();
      }
      for (const entry of await children(path)) {
        if (entry.hidden && !prefix.startsWith('.')) continue;
        if (!entry.name.toLocaleLowerCase().includes(prefix)) continue;
        entries.set(entry.path, entry);
      }
    } else {
      // Name discovery is intentionally bounded. Explicit paths can still open hidden
      // and build folders; discovery does not walk into them or follow symlinks.
      const needle = typed.toLocaleLowerCase();
      const queue = [{path: root, depth: 0}];
      const visited = new Set([root]);
      for (let index = 0; index < queue.length && !exhausted(); index++) {
        const directory = queue[index]!;
        let found;
        try { found = await children(directory.path); }
        catch (error) {
          if (error instanceof SearchTimeout) { budget.truncated = true; continue; }
          if (directory.path === root || (!(error instanceof RpcError) && !inaccessible(error))) throw error;
          continue;
        }
        for (const entry of found) {
          if (entry.hidden || DISCOVERY_EXCLUDES.has(entry.name)) continue;
          if (entry.name.toLocaleLowerCase().includes(needle)) entries.set(entry.path, entry);
          if (entry.symlink || visited.has(entry.path)) continue;
          if (directory.depth >= SEARCH_DEPTH_LIMIT) { budget.truncated = true; continue; }
          visited.add(entry.path);
          queue.push({path: entry.path, depth: directory.depth + 1});
        }
      }
      const score = (entry: DirectoryEntry) => entry.name.toLocaleLowerCase() === needle ? 0 : entry.name.toLocaleLowerCase().startsWith(needle) ? 1 : 2;
      const sorted = [...entries.values()].sort((a, b) => score(a) - score(b) || a.path.split(sep).length - b.path.split(sep).length || a.path.localeCompare(b.path));
      entries.clear();
      for (const entry of sorted) entries.set(entry.path, entry);
    }
    return {
      kind: 'suggestions' as const, root, path, parent: path && path !== root ? dirname(path) : null,
      entries: [...entries.values()].slice(0, SUGGESTION_LIMIT).map(({name, path, hidden}) => ({name, path, hidden})),
      truncated: budget.truncated || entries.size > SUGGESTION_LIMIT,
    };
  }
  return {
    async suggest(query: string) {
      try { return await suggestions(query); }
      catch (error) {
        if (error instanceof RpcError) throw error;
        if (error instanceof SearchTimeout) throw new RpcError('directory_timeout', '读取目录超时，请选择其他目录或稍后重试。');
        if (['EACCES', 'EPERM'].includes(fileErrorCode(error) ?? '')) throw new RpcError('directory_unreadable', '无法读取这个目录，请检查 Bot 所在设备的访问权限。');
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(fileErrorCode(error) ?? '')) throw new RpcError('invalid_directory', '找不到这个目录，请检查路径。');
        throw error;
      }
    },
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
