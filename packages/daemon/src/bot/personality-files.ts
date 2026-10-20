import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, parse, resolve } from 'node:path';

export type PersonalityFile =
  | { kind: 'bot-soul' | 'bot-agents' | 'public-memory' }
  | { kind: 'group-soul' | 'group-memory'; chatId: string }
  | { kind: 'dm-memory'; personId: string };
export type FileFailure = 'invalid-target' | 'unsafe-file' | 'too-large' | 'invalid-utf8' | 'too-many-characters' | 'io';
export interface FileSnapshot {
  file: string;
  /** Opaque bot-root identity; identical contents in another bot are different provenance. */
  source: string;
  version: string;
  content: string;
  characters: number;
  bytes: number;
  needsOrganization: boolean;
}
export type FileRead =
  | { kind: 'present'; snapshot: FileSnapshot }
  | { kind: 'missing'; file: string }
  | { kind: 'error'; file: string; reason: FileFailure };
/** A committed write is a file fact, never evidence that a model received it. */
export type FileWrite =
  | { kind: 'committed'; snapshot: FileSnapshot }
  | { kind: 'error'; file: string; reason: FileFailure };
export const PERSONALITY_SAFETY_BYTES = 64 * 1024;

class FileError extends Error {
  constructor(readonly reason: FileFailure) { super(reason); }
}
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
function failure(error: unknown): FileFailure { return error instanceof FileError ? error.reason : 'io'; }
function id(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new FileError('invalid-target');
  return value;
}
function relativeFile(target: PersonalityFile): string {
  switch (target.kind) {
    case 'bot-soul': return 'SOUL.md';
    case 'bot-agents': return 'AGENTS.md';
    case 'public-memory': return 'memory/shared.md';
    case 'group-soul': return `groups/${id(target.chatId)}/SOUL.md`;
    case 'group-memory': return `groups/${id(target.chatId)}/memory/group.md`;
    case 'dm-memory': return `memory/dm/${id(target.personId)}/dm.md`;
    default: { const exhaustive: never = target; return exhaustive; }
  }
}
function identity(stat: { dev: number; ino: number }): string { return `${stat.dev}:${stat.ino}`; }
function regular(stat: Awaited<ReturnType<typeof lstat>>): void {
  if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink()) throw new FileError('unsafe-file');
  if (stat.size > PERSONALITY_SAFETY_BYTES) throw new FileError('too-large');
}
function snapshot(file: string, content: string, maxCharacters: number, source: string): FileSnapshot {
  const characters = [...content].length;
  return { file, source, content, characters, bytes: Buffer.byteLength(content), needsOrganization: characters > maxCharacters,
    version: createHash('sha256').update(content).digest('hex') };
}

/** The caller supplies a trusted, physical canonical s36 bot root, never an agent path.
 * All aliases (including macOS /var and /tmp) fail closed. Resolve trusted OS/data-root
 * configuration before calling; this module never adopts a first-read link target as a bot.
 */
export function createPersonalityFiles(
  botRoot: string,
  policy: { maxCharacters: number },
  operations: { commitRename?: typeof rename } = {},
) {
  if (!isAbsolute(botRoot) || !Number.isSafeInteger(policy.maxCharacters) || policy.maxCharacters < 1) {
    throw new Error('Invalid personality file policy');
  }
  let rootIdentity: string | undefined;
  function source(): string {
    if (rootIdentity === undefined) throw new FileError('io');
    return createHash('sha256').update(rootIdentity).digest('hex');
  }
  // Inspect every ancestor before pinning: lstat only on botRoot would trust a linked parent.
  async function root(): Promise<string> {
    if (resolve(botRoot) !== botRoot) throw new FileError('unsafe-file');
    let path = parse(botRoot).root;
    for (const part of botRoot.slice(path.length).split('/').filter(Boolean)) {
      path = join(path, part);
      const ancestor = await lstat(path).catch(() => { throw new FileError('io'); });
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) throw new FileError('unsafe-file');
    }
    if (await realpath(botRoot) !== botRoot) throw new FileError('unsafe-file');
    const stat = await lstat(botRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FileError('unsafe-file');
    const current = identity(stat);
    if (rootIdentity !== undefined && rootIdentity !== current) throw new FileError('unsafe-file');
    rootIdentity = current;
    return botRoot;
  }
  async function parents(file: string, create: boolean): Promise<{ path: string; token: string }> {
    let path = await root();
    const tokens = [identity(await lstat(path))];
    for (const part of file.split('/').slice(0, -1)) {
      path = join(path, part);
      if (create) {
        try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      }
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FileError('unsafe-file');
      tokens.push(identity(stat));
    }
    return { path, token: tokens.join('/') };
  }
  async function verifyParents(file: string, token: string): Promise<void> {
    if ((await parents(file, false)).token !== token) throw new FileError('unsafe-file');
  }
  async function existing(path: string): Promise<string | undefined> {
    try { const stat = await lstat(path); regular(stat); return identity(stat); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async function read(target: PersonalityFile): Promise<FileRead> {
    let file = '(invalid)';
    try {
      file = relativeFile(target);
      const parent = await parents(file, false);
      const path = join(parent.path, basename(file));
      const before = await existing(path);
      if (before === undefined) return { kind: 'missing', file };
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        regular(stat);
        if (identity(stat) !== before) throw new FileError('unsafe-file');
        // Bounded read even if an agent grows the file after fstat. Never wait for FIFO input.
        const bytes = Buffer.alloc(PERSONALITY_SAFETY_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const chunk = await handle.read(bytes, length, bytes.length - length, length);
          if (!chunk.bytesRead) break;
          length += chunk.bytesRead;
        }
        if (length > PERSONALITY_SAFETY_BYTES) throw new FileError('too-large');
        const after = await handle.stat();
        regular(after);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || await existing(path) !== before) throw new FileError('unsafe-file');
        await verifyParents(file, parent.token);
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
        catch { throw new FileError('invalid-utf8'); }
        return { kind: 'present', snapshot: snapshot(file, content, policy.maxCharacters, source()) };
      } finally { await handle.close(); }
    } catch (error) {
      return missing(error) ? { kind: 'missing', file } : { kind: 'error', file, reason: failure(error) };
    }
  }
  async function write(target: PersonalityFile, content: string): Promise<FileWrite> {
    let file = '(invalid)';
    let temporary: { path: string; file: string; token: string } | undefined;
    try {
      file = relativeFile(target);
      await root();
      const next = snapshot(file, content, policy.maxCharacters, source());
      if (next.needsOrganization) throw new FileError('too-many-characters');
      if (next.bytes > PERSONALITY_SAFETY_BYTES) throw new FileError('too-large');
      // Reject strings that cannot round-trip as UTF-8 (unpaired UTF-16 surrogates).
      if (Buffer.from(content).toString('utf8') !== content) throw new FileError('invalid-utf8');
      const parent = await parents(file, true);
      const path = join(parent.path, basename(file));
      const before = await existing(path);
      temporary = { path: join(parent.path, `.vonvon-${randomUUID()}.tmp`), file, token: parent.token };
      const handle = await open(temporary.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await verifyParents(file, parent.token);
      if (await existing(path) !== before) throw new FileError('unsafe-file');
      await (operations.commitRename ?? rename)(temporary.path, path);
      temporary = undefined;
      return { kind: 'committed', snapshot: next };
    } catch (error) { return { kind: 'error', file, reason: failure(error) }; }
    finally {
      // Never chase a swapped ancestor while cleaning up our own temporary file.
      const cleanup = temporary;
      if (cleanup) await verifyParents(cleanup.file, cleanup.token).then(() => unlink(cleanup.path)).catch(() => undefined);
    }
  }
  return { read, write };
}
export type PersonalityFiles = ReturnType<typeof createPersonalityFiles>;
