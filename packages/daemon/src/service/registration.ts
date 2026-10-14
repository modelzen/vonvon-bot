import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { decodeGeneratedDefinition, type Definition, type SerializedDefinition } from './definitions';
import { resolveServiceRoot, type CanonicalRoot, type Target } from './identity';

export type Registration =
  | { kind: 'absent' }
  | { kind: 'ours'; definition: Definition }
  | { kind: 'other-root'; recordedRoot: CanonicalRoot; definition: Definition }
  | { kind: 'unrecognized'; location: string; reason: string };
type ReadInput = { target: Target; requestedRoot: string };

const MAX_DEFINITION_BYTES = 1024 * 1024;

async function readFile(path: string): Promise<Buffer | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) throw new Error('Definition must be a regular file, not a symlink or directory');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('Definition changed during read');
    if (opened.size > MAX_DEFINITION_BYTES) throw new Error('Definition exceeds size limit');
    const bytes = Buffer.alloc(MAX_DEFINITION_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > MAX_DEFINITION_BYTES) throw new Error('Definition exceeds size limit');
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

export async function readRegistration(input: ReadInput): Promise<Registration> {
  const target = input.target;
  const location = target.platform === 'darwin' ? target.plistPath : target.unitPath;
  try {
    const requestedRoot = await resolveServiceRoot(input.requestedRoot);
    const content = await readFile(location);
    if (content === null) return { kind: 'absent' };
    const bytes: SerializedDefinition = target.platform === 'darwin' ? { platform: 'darwin', plist: content } : { platform: 'linux', unit: content };
    const decoded = decodeGeneratedDefinition(target, bytes);
    const root = await resolveServiceRoot(decoded.root);
    if (root !== decoded.root) throw new Error('Recorded root is not its canonical realpath');
    const definition: Definition = { ...decoded, root };
    return root === requestedRoot ? { kind: 'ours', definition } : { kind: 'other-root', recordedRoot: root, definition };
  } catch (error) {
    return { kind: 'unrecognized', location, reason: error instanceof Error ? error.message : String(error) };
  }
}
