import { constants } from 'node:fs';
import { access, chmod, lstat, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { findCliPathBlock, shellStartupFiles, spliceBlock, startupBlock } from '@vonvon/protocol';

/**
 * Reads and writes the shell startup files for the standalone server's `bin` (server-2 4.3): the same block the desktop
 * app writes (protocol `cli-path-block`), so there is only ever one. Each file is written to a temporary file beside
 * it and renamed over it, keeping its mode; a link is followed to the file it names, as `>>` would.
 */
export type ShellPathResult = { files: string[]; notes: string[] };

const errnoOf = (error: unknown): string => (error instanceof Error && 'code' in error && typeof error.code === 'string') ? error.code : error instanceof Error ? error.message : String(error);
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export async function startupFiles(home: string, zdotdir: string | undefined): Promise<string[]> {
  const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);
  return shellStartupFiles(home, { ...(zdotdir && isAbsolute(zdotdir) ? { zdotdir } : {}), exists });
}

/** The file a write lands in: the path itself, or what its link names. */
async function target(path: string): Promise<string> {
  try { return (await lstat(path)).isSymbolicLink() ? await realpath(path) : path; }
  catch (error) { if (missing(error)) return path; throw error; }
}

async function rewrite(path: string, edit: (content: string) => string): Promise<boolean> {
  const file = await target(path);
  let before = '';
  let mode = 0o644;
  let existed = true;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error(`${file} is not a regular file`), { code: 'ENOTFILE' });
    before = await readFile(file, 'utf8');
    mode = info.mode & 0o7777;
  } catch (error) { if (!missing(error)) throw error; existed = false; }
  const after = edit(before);
  if (after === before) return false;
  // the rename would replace a file its owner made read-only
  if (existed) await access(file, constants.W_OK);
  const temporary = join(dirname(file), `.${basename(file)}.vonvon-tmp`);
  try {
    await writeFile(temporary, after, { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return true;
}

/** Puts the block for `bin` in each file. A file that cannot be written is not an error: it is named in `notes`. */
export async function writePathBlock(files: string[], bin: string): Promise<ShellPathResult> {
  const result: ShellPathResult = { files: [], notes: [] };
  for (const file of files) {
    try {
      await rewrite(file, content => spliceBlock(content, startupBlock(bin)));
      result.files.push(file);
    } catch (error) { result.notes.push(`${file} 没写进去：${errnoOf(error)}`); }
  }
  return result;
}

/** Takes the block out of each file, only where it is the block for `bin`: the desktop app's block stays. */
export async function removePathBlock(files: string[], bin: string): Promise<ShellPathResult> {
  const result: ShellPathResult = { files: [], notes: [] };
  const ours = startupBlock(bin).replace(/\n$/, '');
  for (const file of files) {
    try {
      const changed = await rewrite(file, content => findCliPathBlock(content)?.text.replace(/\n$/, '') === ours ? spliceBlock(content, null) : content);
      if (changed) result.files.push(file);
    } catch (error) {
      if (!missing(error)) result.notes.push(`${file} 没改成：${errnoOf(error)}`);
    }
  }
  return result;
}
