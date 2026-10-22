import {z} from 'zod';
import {join, isAbsolute} from 'node:path';
import {constants, openSync, closeSync, fstatSync, readFileSync, realpathSync} from 'node:fs';
import {readLocalText} from './bounded-local-files';

export const bridgeDoneSchema = z.object({version: z.literal(1), txId: z.string().uuid(), at: z.number().int().positive(),
  bridgeDir: z.string().refine(isAbsolute), bots: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1).max(128),
}).strict();
export async function readBridgeDone(appDir: string, sourceDir: string) {
  const text = await readLocalText(appDir, join(appDir, 'import/bridge/done.json'), undefined, 64 * 1024);
  if (text === undefined) return undefined;
  const done = bridgeDoneSchema.parse(JSON.parse(text));
  if (done.bridgeDir !== sourceDir || new Set(done.bots).size !== done.bots.length) throw new Error('Invalid Bridge migration marker');
  return done;
}

/** The resolver is synchronous. A bounded, authenticated-shape marker only adds the old private Codex last. */
export function committedBridgeCodex(home: string, root: string): string | undefined {
  let handle: number | undefined;
  try {
    handle = openSync(join(root, 'import/bridge/done.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(handle);
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024) return;
    const done = bridgeDoneSchema.parse(JSON.parse(readFileSync(handle, 'utf8')));
    const source = join(realpathSync(home), '.feishu-codex-bridge');
    if (done.bridgeDir !== source) return;
    const candidate = join(source, 'codex-cli/node_modules/.bin/codex');
    const target = realpathSync(candidate), privateRoot = realpathSync(join(source, 'codex-cli'));
    if (target.startsWith(`${privateRoot}/`)) return candidate;
  } catch { /* Invalid or absent migration data must never become a binary search path. */ }
  finally {if (handle !== undefined) closeSync(handle);}
  return;
}
