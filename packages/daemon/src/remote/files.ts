import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** `<dataRoot>/devices/` (0700): device.json, clients.json, remote.json and their temporary files. A session's read deny
 * names this directory (config/read-scope.ts), which the Linux sandbox hides as a whole. Denied one by one, each file is a
 * bind mount that the next atomic replace (temporary file + rename) detaches, and a file that did not exist yet when the
 * session started is not denied at all. */
export const DEVICES_DIR = 'devices';
export type DevicesFile = 'device.json' | 'clients.json' | 'remote.json';
export const devicesPath = (home: string, file: DevicesFile): string => join(home, DEVICES_DIR, file);

/** Made when the daemon starts, before any Bot (host/bootstrap.ts), and before the CLI writes these files itself.
 * A link or another user's directory is refused; a mode wider than 0700 (a copied or restored data root) is narrowed. */
export async function prepareDevicesDirectory(home: string): Promise<void> {
  const directory = join(home, DEVICES_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (process.platform !== 'win32' && info.uid !== process.getuid?.())) {
    throw new Error(`${directory} 必须是当前用户自己的目录，不能是链接。改好它的类型和属主再启动；里面的 device.json 是这台设备的身份，别删。`);
  }
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
}

/** A file a newer Vonvon Bot wrote (`v` above 1) is not a damaged one: say so, and leave it alone. Unknown fields at the
 * same `v` are a newer version's optional ones; the readers keep them and write them back. */
export function refuseNewer(file: string, parsed: unknown): void {
  const v = typeof parsed === 'object' && parsed !== null && 'v' in parsed ? parsed.v : undefined;
  if (typeof v === 'number' && Number.isInteger(v) && v > 1) {
    throw new Error(`${file} 是较新版本的 Vonvon Bot 写的（格式 v${v}），这一版读不了。把 Vonvon Bot 升级回去再启动，别删这个文件。`);
  }
}
