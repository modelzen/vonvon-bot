import { constants } from 'node:fs';
import { access, chmod, lstat, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { findCliPathBlock, shellStartupFiles, spliceBlock, startupBlock } from '@vonvon/protocol';

/**
 * Reads and writes the shell startup files for the standalone server's `bin` (server-2 4.3): the same block the desktop
 * app writes (protocol `cli-path-block`), so there is only ever one. Each file is written to a temporary file beside
 * it and renamed over it, keeping its mode; a link is followed to the file it names, and a link that names nothing is
 * left alone. The files are handled as bytes (latin1 maps each byte to one character and back), so text that is not
 * UTF-8 comes back as it was; the block is turned into its UTF-8 bytes the same way.
 */
export type ShellPathResult = { files: string[]; notes: string[] };

const errnoOf = (error: unknown): string => (error instanceof Error && 'code' in error && typeof error.code === 'string') ? error.code : error instanceof Error ? error.message : String(error);
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const asBytes = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');

/** A startup file that is a link to nothing: writing through it would replace the link, so it is not written. */
class DanglingLink extends Error {}

const usable = (zdotdir: string | undefined): zdotdir is string => Boolean(zdotdir && isAbsolute(zdotdir));
const under = (dir: string, name: string): string => `${dir.replace(/\/+$/, '')}/${name}`;

/** The files setup writes the block into (protocol `shellStartupFiles`): bash's login file is the first that exists. */
export async function startupFiles(home: string, zdotdir: string | undefined): Promise<string[]> {
  const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);
  return shellStartupFiles(home, { ...(usable(zdotdir) ? { zdotdir } : {}), exists });
}

/**
 * Every file setup could have written the block into, whichever of them existed then: zsh's two under ZDOTDIR and
 * under the home, and all three of bash's login files. A `.bash_profile` made after setup, or a ZDOTDIR set since,
 * then does not hide the block setup wrote.
 */
export function everyStartupFile(home: string, zdotdir: string | undefined): string[] {
  const zsh = usable(zdotdir) && under(zdotdir, '') !== under(home, '') ? [zdotdir, home] : [home];
  return [
    ...zsh.flatMap(dir => [under(dir, '.zshrc'), under(dir, '.zprofile')]),
    ...['.bash_profile', '.bash_login', '.profile', '.bashrc'].map(name => under(home, name)),
  ];
}

/** The file a write lands in: the path itself, or what its link names. */
async function target(path: string): Promise<string> {
  let link: boolean;
  try { link = (await lstat(path)).isSymbolicLink(); }
  catch (error) { if (missing(error)) return path; throw error; }
  if (!link) return path;
  try { return await realpath(path); }
  catch (error) { if (missing(error)) throw new DanglingLink('符号链接指向的文件不存在'); throw error; }
}

async function rewrite(path: string, edit: (content: string) => string): Promise<boolean> {
  const file = await target(path);
  let before = '';
  let mode = 0o644;
  let existed = true;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error(`${file} is not a regular file`), { code: 'ENOTFILE' });
    before = (await readFile(file)).toString('latin1');
    mode = info.mode & 0o7777;
  } catch (error) { if (!missing(error)) throw error; existed = false; }
  const after = edit(before);
  if (after === before) return false;
  // the rename would replace a file its owner made read-only
  if (existed) await access(file, constants.W_OK);
  const temporary = join(dirname(file), `.${basename(file)}.vonvon-tmp`);
  try {
    await writeFile(temporary, Buffer.from(after, 'latin1'), { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return true;
}

/**
 * The startup files whose text had no newline at its end when the block went in, each with that text's length in
 * bytes: `spliceBlock` put a line break there so the block starts on a line of its own, and it goes out with the block
 * while that text is all there is before it. The caller keeps it between setup and teardown.
 */
export type AddedBreaks = Record<string, number>;

/**
 * Puts the block for `bin` in each file, and records in `breaks` each line break put before it. A file that cannot be
 * written is not an error: it is named in `notes`.
 */
export async function writePathBlock(files: string[], bin: string, breaks: AddedBreaks = {}): Promise<ShellPathResult> {
  const result: ShellPathResult = { files: [], notes: [] };
  const block = asBytes(startupBlock(bin));
  for (const file of files) {
    try {
      let added: number | undefined;
      await rewrite(file, content => {
        const rest = spliceBlock(content, null);
        if (rest && !rest.endsWith('\n')) added = rest.length;
        return spliceBlock(content, block);
      });
      if (added !== undefined) breaks[file] = added;
      result.files.push(file);
    } catch (error) { result.notes.push(`${file} 没写进去：${error instanceof DanglingLink ? error.message : errnoOf(error)}`); }
  }
  return result;
}

/** Every block in `content`, in order: protocol `findCliPathBlock` again from where the one before ended. */
function blocksIn(content: string): Array<{ start: number; end: number; text: string }> {
  const blocks: Array<{ start: number; end: number; text: string }> = [];
  for (let from = 0; ;) {
    const found = findCliPathBlock(content.slice(from));
    if (!found) return blocks;
    blocks.push({ start: from + found.start, end: from + found.end, text: found.text });
    from += found.end;
  }
}

/** One name for a file reached by several (a home behind a link): its real path, or the name when it does not resolve. */
const sameFile = (path: string): Promise<string> => realpath(path).catch(() => path);

/**
 * Takes every block for one of `bins` out of each file (a copy someone made of it too); other blocks, such as the
 * desktop app's, stay. The line break `breaks` names goes too while the last of them still starts right where that
 * text ended and nothing follows it; once something has been written after the block, or the text before it is no
 * longer as long as it was, the break stays. A file named twice (through a linked home and by its real path) is
 * handled once, and its break is found under either name.
 */
export async function removePathBlock(files: string[], bins: string[], breaks: AddedBreaks = {}): Promise<ShellPathResult> {
  const result: ShellPathResult = { files: [], notes: [] };
  const ours = new Set(bins.map(bin => asBytes(startupBlock(bin)).replace(/\n$/, '')));
  const added = new Map<string, number>();
  for (const [file, at] of Object.entries(breaks)) added.set(await sameFile(file), at);
  const seen = new Set<string>();
  for (const file of files) {
    const real = await sameFile(file);
    if (seen.has(real)) continue;
    seen.add(real);
    try {
      const changed = await rewrite(file, content => {
        const found = blocksIn(content).filter(block => ours.has(block.text.replace(/\n$/, '')));
        const last = found.at(-1);
        if (!last) return content;
        const at = added.get(real);
        if (at !== undefined && at >= (found.at(-2)?.end ?? 0) && last.start === at + 1 && last.end === content.length && content[at] === '\n') last.start = at;
        let rest = '';
        let from = 0;
        for (const block of found) { rest += content.slice(from, block.start); from = block.end; }
        return rest + content.slice(from);
      });
      if (changed) result.files.push(file);
    } catch (error) {
      // a link to nothing has no block to take out
      if (!missing(error) && !(error instanceof DanglingLink)) result.notes.push(`${file} 没改成：${errnoOf(error)}`);
    }
  }
  return result;
}
