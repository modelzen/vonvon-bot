import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownShareFile, putShareOnClipboard, shareFileName, writeShareFile, type ShareClipboard } from '../src/share-files.js';

let folder = '';
beforeEach(async () => { folder = join(await mkdtemp(join(tmpdir(), 'vonvon-share-test-')), 'share'); });
afterEach(async () => { await rm(join(folder, '..'), { recursive: true, force: true }); });

/** A ClipboardItem as Electron's: the entries it was made with. */
class FakeItem {
  constructor(readonly entries: Record<string, Blob>) {}
  get types(): string[] { return Object.keys(this.entries); }
}
function target(platform: NodeJS.Platform) {
  const write = vi.fn(async (_items: FakeItem[]) => {});
  const powershell = vi.fn(async (_command: string) => {});
  const value = { platform, clipboard: { write }, ClipboardItem: FakeItem, powershell } as unknown as ShareClipboard;
  return { value, write, powershell };
}
const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);

describe('share files', () => {
  it('writes date-time names and keeps only the newest ten it wrote', async () => {
    const day = new Date(2026, 10, 8, 17, 39, 5);
    expect(shareFileName(day)).toBe('vonvon-share-20261108-173905.gif');
    const first = await writeShareFile(folder, gif, day);
    const second = await writeShareFile(folder, gif, day);
    expect([first, second]).toEqual([join(folder, 'vonvon-share-20261108-173905.gif'), join(folder, 'vonvon-share-20261108-173905-1.gif')]);
    expect(await readFile(first)).toEqual(Buffer.from(gif));
    await writeFile(join(folder, 'notes.txt'), 'not ours');
    for (const [i, name] of (await readdir(folder)).filter(entry => entry.endsWith('.gif')).entries()) {
      await utimes(join(folder, name), new Date(2026, 0, 1), new Date(2026, 0, 1, 0, 0, i));
    }
    for (let minute = 0; minute < 10; minute++) await writeShareFile(folder, gif, new Date(2026, 10, 9, 8, minute, 0));
    const left = (await readdir(folder)).sort();
    expect(left).toHaveLength(11);
    expect(left).toContain('notes.txt');
    expect(left.filter(name => name.startsWith('vonvon-share-20261108'))).toEqual([]);
  });

  it('only reveals a GIF of the share folder', () => {
    const own = join(folder, 'vonvon-share-20261108-173905.gif');
    expect(ownShareFile(folder, own)).toBe(own);
    expect(ownShareFile(folder, join(folder, '..', 'vonvon-share-20261108-173905.gif'))).toBeUndefined();
    expect(ownShareFile(folder, join(folder, 'notes.txt'))).toBeUndefined();
    expect(ownShareFile(folder, join(folder, 'sub', 'vonvon-share-20261108-173905.gif'))).toBeUndefined();
    expect(ownShareFile(folder, 42)).toBeUndefined();
  });
});

describe('share clipboard', () => {
  const path = '/Users/u/Library/Application Support/Vonvon Bot/share/vonvon-share-20261108-173905.gif';

  it('on macOS puts one item with the file URL and the GIF data', async () => {
    const { value, write } = target('darwin');
    await putShareOnClipboard(value, path, gif);
    const [items] = write.mock.calls[0]!;
    expect(items).toHaveLength(1);
    expect(items[0]!.types).toEqual([
      'electron application/osclipboard;format="public.file-url"', 'electron application/osclipboard;format="com.compuserve.gif"',
    ]);
    expect(await items[0]!.entries['electron application/osclipboard;format="public.file-url"']!.text()).toBe(pathToFileURL(path).href);
    expect(new Uint8Array(await items[0]!.entries['electron application/osclipboard;format="com.compuserve.gif"']!.arrayBuffer())).toEqual(gif);
  });

  it('on Windows sets a file list through PowerShell, quoting the path for it', async () => {
    const { value, write, powershell } = target('win32');
    await putShareOnClipboard(value, "C:\\Users\\o'brien\\AppData\\Roaming\\Vonvon Bot\\share\\vonvon-share-20261108-173905.gif", gif);
    expect(write).not.toHaveBeenCalled();
    expect(powershell).toHaveBeenCalledExactlyOnceWith("Set-Clipboard -LiteralPath 'C:\\Users\\o''brien\\AppData\\Roaming\\Vonvon Bot\\share\\vonvon-share-20261108-173905.gif'");
  });

  it('elsewhere puts the file as a URI list', async () => {
    const { value, write } = target('linux');
    await putShareOnClipboard(value, '/home/u/.config/Vonvon Bot/share/vonvon-share-20261108-173905.gif', gif);
    const [items] = write.mock.calls[0]!;
    expect(await items[0]!.entries['electron application/osclipboard;format="text/uri-list"']!.text())
      .toBe('file:///home/u/.config/Vonvon%20Bot/share/vonvon-share-20261108-173905.gif\r\n');
  });
});
