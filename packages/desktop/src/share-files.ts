import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Clipboard, ClipboardItem } from 'electron';

/** The share folder keeps this many GIFs; older ones it wrote go. */
const KEEP = 10;
const NAME = /^vonvon-share-\d{8}-\d{6}(?:-\d{1,3})?\.gif$/;

const pad = (value: number): string => String(value).padStart(2, '0');
export function shareFileName(date: Date, suffix = 0): string {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `vonvon-share-${stamp}${suffix ? `-${suffix}` : ''}.gif`;
}

/** Writes the GIF into `folder` (which the app owns) under a new date-time name and keeps the newest {@link KEEP}. */
export async function writeShareFile(folder: string, gif: Uint8Array, now: Date): Promise<string> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  for (let suffix = 0; ; suffix++) {
    const path = join(folder, shareFileName(now, suffix));
    try {
      await writeFile(path, gif, { flag: 'wx', mode: 0o600 });
      await pruneShareFolder(folder);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || suffix >= 99) throw error;
    }
  }
}

/** Deletes, by exact path, the share GIFs past the newest {@link KEEP}. Only names this app gives are touched. */
export async function pruneShareFolder(folder: string, keep = KEEP): Promise<void> {
  const names = (await readdir(folder)).filter(name => NAME.test(name));
  const dated = await Promise.all(names.map(async name => ({ name, at: (await stat(join(folder, name))).mtimeMs })));
  dated.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  for (const { name } of dated.slice(keep)) await unlink(join(folder, name)).catch(() => {});
}

/** A path the page gave back is one of the share folder's own GIFs, or none. */
export function ownShareFile(folder: string, path: unknown): string | undefined {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\0')) return undefined;
  const full = resolve(path);
  return dirname(full) === resolve(folder) && NAME.test(basename(full)) ? full : undefined;
}

export type ShareClipboard = {
  platform: NodeJS.Platform;
  clipboard: Pick<Clipboard, 'write'>;
  ClipboardItem: typeof ClipboardItem;
  /** Runs Windows PowerShell with this command; resolves when it succeeded. */
  powershell(command: string): Promise<void>;
};

/** Puts the GIF file on the clipboard, so pasting it into Feishu or WeChat sends the file. */
export async function putShareOnClipboard(target: ShareClipboard, path: string, gif: Uint8Array): Promise<void> {
  const url = pathToFileURL(path).href;
  const raw = (format: string): string => `electron application/osclipboard;format="${format}"`;
  if (target.platform === 'darwin') {
    // One pasteboard item: the file, and the GIF itself for apps that read image data.
    await target.clipboard.write([new target.ClipboardItem({
      [raw('public.file-url')]: new Blob([url]),
      [raw('com.compuserve.gif')]: new Blob([gif as Uint8Array<ArrayBuffer>], { type: 'image/gif' }),
    })]);
  } else if (target.platform === 'win32') {
    // A file list is CF_HDROP, a predefined format: Electron's raw formats are registered by name, so cannot write it.
    // Windows PowerShell's Set-Clipboard -LiteralPath writes the list as Explorer does.
    await target.powershell(`Set-Clipboard -LiteralPath '${path.replaceAll("'", "''")}'`);
  } else {
    await target.clipboard.write([new target.ClipboardItem({
      [raw('text/uri-list')]: new Blob([`${url}\r\n`]),
      [raw('x-special/gnome-copied-files')]: new Blob([`copy\n${url}`]),
    })]);
  }
}

/** Windows PowerShell 5.1, which every supported Windows has; the command goes encoded, so no quoting reaches a shell. */
export function runWindowsPowerShell(command: string): Promise<void> {
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return new Promise((done, fail) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15_000 }, error => error ? fail(error) : done());
  });
}
