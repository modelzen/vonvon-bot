import {spawn} from 'node:child_process';
import {directoryReplySchema, type DirectoryReply} from '@vonvon/protocol';
import {RpcError} from './errors';

type Suggestions = Extract<DirectoryReply, {kind: 'suggestions'}>;

// Self-contained because its compiled function body runs in a fresh Node process.
// Never move filesystem reads into the parent: TCC/network mounts can block them
// indefinitely, and a Promise timeout does not release a daemon threadpool slot.
async function directorySuggestionWorker(root: string, query: string) {
  const {opendir, realpath, stat} = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
  const {basename, dirname, isAbsolute, join, relative, resolve, sep} = process.getBuiltinModule('node:path') as typeof import('node:path');
  const entries = new Map<string, {name: string; path: string; hidden: boolean}>();
  const typed = query.trim();
  const rooted = isAbsolute(typed) || typed === '~' || typed.startsWith('~/');
  const discovery = Boolean(typed && !rooted);
  const ignored = new Set(['node_modules', 'vendor', 'venv', 'dist', 'build', 'target', 'out', 'coverage', '__pycache__']);
  const noDescent = new Set(['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Movies', 'Library', 'OrbStack', 'Virtual Machines', 'Virtual Machines.localized', 'Parallels']);
  const preferred = new Set(['develop', 'developer', 'projects', 'project', 'workspaces', 'workspace', 'work', 'src', 'code']);
  let path: string | null = null;
  let truncated = false;
  let remaining = 4000;
  let directoryCount = 0;
  const deadline = Date.now() + 1200;
  const code = (error: unknown) => error instanceof Error && 'code' in error ? String(error.code) : '';
  const fail = (code: string, message: string) => Object.assign(new Error(message), {code});
  const contained = (candidate: string) => {
    const rel = relative(root, candidate);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw fail('outside_home', '目录必须位于用户主目录内。');
  };
  const canonical = async (candidate: string) => {
    const safe = await realpath(candidate);
    contained(safe);
    if (!(await stat(safe)).isDirectory()) throw fail('invalid_directory', '请选择文件夹。');
    return safe;
  };
  const exhausted = () => {
    if (remaining <= 0 || directoryCount >= 256 || Date.now() >= deadline) truncated = true;
    return remaining <= 0 || directoryCount >= 256 || Date.now() >= deadline;
  };
  const emit = (partial = true) => {
    const needle = typed.toLocaleLowerCase();
    const score = (entry: {name: string}) => entry.name.toLocaleLowerCase() === needle ? 0 : entry.name.toLocaleLowerCase().startsWith(needle) ? 1 : 2;
    const list = [...entries.values()];
    if (discovery) list.sort((a, b) => score(a) - score(b) || a.path.split(sep).length - b.path.split(sep).length || a.path.localeCompare(b.path));
    process.stdout.write(`${JSON.stringify({kind: 'suggestions', root, path, parent: path && path !== root ? dirname(path) : null, entries: list.slice(0, 50), truncated: partial || truncated || entries.size > 50})}\n`);
  };
  const add = (entry: {name: string; path: string; hidden: boolean}) => { entries.set(entry.path, entry); emit(); };
  const children = async (directory: string, visit: (entry: {name: string; path: string; hidden: boolean; symlink: boolean}) => void) => {
    if (exhausted()) return;
    directoryCount++;
    const safe = await canonical(directory);
    const handle = await opendir(safe, {bufferSize: 64});
    for await (const child of handle) {
      if (exhausted()) break;
      remaining--;
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      if (discovery && (child.name.startsWith('.') || ignored.has(child.name) || child.isSymbolicLink())) continue;
      try {
        // Dirent already proves the plain entry is a directory. Only symlinks need
        // metadata here; every actual descent and final choose is canonicalized.
        const target = child.isSymbolicLink() ? await canonical(join(safe, child.name)) : join(safe, child.name);
        visit({name: child.name, path: target, hidden: child.name.startsWith('.'), symlink: child.isSymbolicLink()});
      } catch (error) {
        if (!['outside_home', 'invalid_directory', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(code(error))) throw error;
      }
    }
  };
  try {
    if (!discovery) {
      const requested = !typed || typed === '~' ? root : typed.startsWith('~/') ? resolve(root, typed.slice(2)) : resolve(typed);
      let prefix = '';
      try { path = await canonical(requested); add({name: basename(path), path, hidden: basename(path).startsWith('.')}); }
      catch (error) {
        if (code(error) !== 'ENOENT' || typed.endsWith('/')) throw error;
        path = await canonical(dirname(requested)); prefix = basename(requested).toLocaleLowerCase();
      }
      const found: Array<{name: string; path: string; hidden: boolean}> = [];
      await children(path, entry => {
        if ((!entry.hidden || prefix.startsWith('.')) && entry.name.toLocaleLowerCase().includes(prefix)) { found.push(entry); add(entry); }
      });
      for (const entry of found) entries.delete(entry.path);
      for (const entry of found.sort((a, b) => a.name.localeCompare(b.name))) entries.set(entry.path, entry);
    } else {
      const queue = [{path: root, depth: 0, preferred: false}];
      const seen = new Set([root]);
      while (queue.length && !exhausted()) {
        queue.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.depth - b.depth || a.path.localeCompare(b.path));
        const directory = queue.shift()!;
        try {
          await children(directory.path, entry => {
            if (entry.name.toLocaleLowerCase().includes(typed.toLocaleLowerCase())) add(entry);
            if (entry.symlink || seen.has(entry.path) || noDescent.has(entry.name) || /\.(?:pvm|vmwarevm)$/.test(entry.name)) return;
            if (directory.depth >= 8) { truncated = true; return; }
            seen.add(entry.path);
            queue.push({path: entry.path, depth: directory.depth + 1, preferred: directory.preferred || preferred.has(entry.name.toLocaleLowerCase())});
          });
        } catch (error) {
          if (directory.path === root || !['outside_home', 'invalid_directory', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(code(error))) throw error;
        }
      }
    }
    emit(false);
  } catch (error) {
    const failure = code(error);
    const errorCode = failure === 'outside_home' ? failure : ['ENOENT', 'ENOTDIR', 'ELOOP', 'invalid_directory'].includes(failure) ? 'invalid_directory' : 'directory_unreadable';
    const message = errorCode === 'outside_home' ? '目录必须位于用户主目录内。' : errorCode === 'invalid_directory' ? '找不到这个目录，请检查路径。' : '无法读取这个目录，请检查 Bot 所在设备的访问权限。';
    process.stdout.write(`${JSON.stringify({error: errorCode, message})}\n`);
    process.exitCode = 1;
  }
}

export const directorySuggestionWorkerSource = `(${directorySuggestionWorker.toString()})(process.argv[1],process.argv[2]).catch(()=>{process.exitCode=1;});`;

/** The source override lets tests block an actual child on a FIFO, without a real mount. */
export function createDirectorySuggestions(source = directorySuggestionWorkerSource) {
  const active = new Set<() => void>();
  let closed = false;
  return {
    close() { closed = true; for (const cancel of [...active]) cancel(); },
    search(root: string, query: string): Promise<Suggestions> {
      if (closed) return Promise.reject(new RpcError('directory_closed', '目录选择已关闭。'));
      // A newly typed query must not queue behind two slow older searches.
      while (active.size >= 2) active.values().next().value!();
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', source, '--', root, query], {stdio: ['ignore', 'pipe', 'ignore'], env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}});
        let latest: Suggestions | undefined;
        let buffer = '';
        let bytes = 0;
        let settled = false;
        const finish = (error?: Error, partial = false) => {
          if (settled) return;
          settled = true; clearTimeout(timer); active.delete(cancel);
          child.stdout.destroy();
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          child.unref();
          if (error) reject(error);
          else resolve(latest ? {...latest, truncated: partial || latest.truncated} : {kind: 'suggestions', root, path: null, parent: null, entries: [], truncated: partial});
        };
        const cancel = () => finish(undefined, true);
        const timer = setTimeout(() => {
          const typed = query.trim();
          if ((!typed || typed.startsWith('/') || typed === '~' || typed.startsWith('~/')) && !latest?.path) finish(new RpcError('directory_timeout', '读取目录超时，请重试或选择其他目录。'));
          else cancel();
        }, 1500);
        active.add(cancel);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk); buffer += chunk;
          if (bytes > 2_000_000 || buffer.length > 262_144) { cancel(); return; }
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            try {
              const value: unknown = JSON.parse(line);
              if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' && 'message' in value && typeof value.message === 'string') { finish(new RpcError(value.error, value.message)); return; }
              const parsed = directoryReplySchema.safeParse(value);
              if (parsed.success && parsed.data.kind === 'suggestions') latest = parsed.data;
            } catch { finish(new RpcError('directory_unreadable', '无法读取目录搜索结果。')); return; }
          }
        });
        child.on('error', () => finish(new RpcError('directory_unreadable', '无法启动目录搜索。')));
        child.on('close', code => finish(code === 0 || latest ? undefined : new RpcError('directory_unreadable', '无法读取目录。')));
      });
    },
  };
}
