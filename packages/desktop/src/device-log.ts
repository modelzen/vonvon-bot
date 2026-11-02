import { appendFile, rename, stat } from 'node:fs/promises';
import type { DeviceLogEvent } from './connections.js';

const LOG_LIMIT = 1_000_000;

/** devices-ui-1a 4.8: `userData/devices.log`, one line an event (`<ISO time> device-closed id=1a2b3c4d code=client_revoked`),
 * 0600, appended; past 1 MB it becomes `devices.log.1`, replacing the older one. The fields are the connections' own:
 * a device id's first 8 characters, codes and numbers. Writes go in order and never throw. */
export function createDeviceLog(path: string, now: () => number = Date.now): (event: DeviceLogEvent, fields: Record<string, string | number>) => void {
  let queue: Promise<void> = Promise.resolve();
  const clean = (value: string | number): string => String(value).replace(/[^\w.:-]/g, '_').slice(0, 64);
  return (event, fields) => {
    const line = `${new Date(now()).toISOString()} ${event}${Object.entries(fields).map(([key, value]) => ` ${clean(key)}=${clean(value)}`).join('')}\n`;
    queue = queue.then(async () => {
      const size = await stat(path).then(info => info.size, () => 0);
      if (size + line.length > LOG_LIMIT) await rename(path, `${path}.1`).catch(() => undefined);
      // The mode applies when the file is created, which is the only time it has none.
      await appendFile(path, line, { mode: 0o600 });
    }).catch(() => undefined);
  };
}
