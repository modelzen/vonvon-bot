import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from '../server/atomic-file';
import { RpcError } from '../server/errors';
import { devicesPath, prepareDevicesDirectory, refuseNewer } from './files';

export const DEFAULT_REMOTE_PORT = 7767;
/** `<dataRoot>/devices/remote.json` (devices 4.2): the addresses the owner opened to other devices. D3 writes it, keeping
 * the fields a newer version added ({@link readRemoteConfig} reads them along). */
export const remoteConfigSchema = z.object({
  v: z.literal(1), port: z.number().int().min(1).max(65535),
  addresses: z.array(z.object({
    host: z.string(), enabledAt: z.number().int(), kind: z.enum(['tailscale', 'lan', 'cgnat', 'public']), iface: z.string().optional(), network: z.string().optional(),
  }).strict()),
}).strict();
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export type RemoteAddress = RemoteConfig['addresses'][number];
const remoteFileSchema = z.looseObject({ ...remoteConfigSchema.shape, addresses: z.array(z.looseObject(remoteConfigSchema.shape.addresses.element.shape)) });

/** No file: nothing opened yet, on the default port. A file that does not parse is an error, never "nothing opened". */
export async function readRemoteConfig(home: string): Promise<RemoteConfig> {
  const file = devicesPath(home, 'remote.json');
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { v: 1, port: DEFAULT_REMOTE_PORT, addresses: [] };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  refuseNewer(file, parsed);
  try { return remoteFileSchema.parse(parsed); }
  catch (error) { throw new Error(`remote.json 损坏：${file} 不是有效的远程连接配置。`, { cause: error }); }
}

/** D3 4.1: the whole file, 0600, through a temporary file and a rename. Fields a newer version added stay. */
export async function writeRemoteConfig(home: string, config: RemoteConfig): Promise<void> {
  const checked = remoteFileSchema.parse(config);
  await prepareDevicesDirectory(home);
  await writeFileAtomic(devicesPath(home, 'remote.json'), `${JSON.stringify(checked, null, 2)}\n`, { durable: true });
}
const turns = new Map<string, Promise<unknown>>();
/** Read, change and write one at a time in this process (two `device.enable` at once would each write over the other);
 * the daemon is the only writer while it runs, the CLI holds the host mutex when it writes with none. */
export function updateRemoteConfig(home: string, change: (config: RemoteConfig) => RemoteConfig): Promise<RemoteConfig> {
  const run = (turns.get(home) ?? Promise.resolve()).then(async () => {
    const next = change(await readRemoteConfig(home));
    await writeRemoteConfig(home, next);
    return next;
  });
  const settled = run.catch(() => undefined);
  turns.set(home, settled);
  void settled.then(() => { if (turns.get(home) === settled) turns.delete(home); });
  return run;
}
/** The same host opened again replaces its entry (a LAN address gets its network anew: the owner's confirmation). */
export function enableAddress(config: RemoteConfig, address: RemoteAddress): RemoteConfig {
  const at = config.addresses.findIndex(entry => entry.host === address.host);
  const addresses = [...config.addresses];
  if (at < 0) addresses.push(address); else addresses[at] = address;
  return { ...config, addresses };
}
export function disableAddress(config: RemoteConfig, host: string): RemoteConfig {
  if (!config.addresses.some(entry => entry.host === host)) throw new RpcError('invalid_request', '这个地址没有开启。');
  return { ...config, addresses: config.addresses.filter(entry => entry.host !== host) };
}
export const PORT_RANGE = '端口要在 1024 到 65535 之间。';
export function setPort(config: RemoteConfig, port: number): RemoteConfig {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RpcError('invalid_request', PORT_RANGE);
  return { ...config, port };
}
