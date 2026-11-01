import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { devicesPath, refuseNewer } from './files';

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
