import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { decodeGeneratedDefinition, type Definition, type SerializedDefinition } from './definitions';
import { resolveServiceRoot, type CanonicalRoot, type Target } from './identity';
import { runWindowsCommand, withTimeout, type WindowsRun } from './windows-command';

export type Registration =
  | { kind: 'absent' }
  | { kind: 'ours'; definition: Definition }
  | { kind: 'other-root'; recordedRoot: CanonicalRoot; definition: Definition }
  | { kind: 'unrecognized'; location: string; reason: string };
/** `run` answers `schtasks` for a Windows target; the real one by default. */
type ReadInput = { target: Target; requestedRoot: string; run?: WindowsRun };

const MAX_DEFINITION_BYTES = 1024 * 1024;
const NOT_A_REGULAR_FILE = 'Definition must be a regular file, not a symlink or directory';

/** An unrecognized definition that is a symlink or directory: install refuses to replace it, unlike an older format. */
export function isIrreplaceableDefinition(reason: string): boolean { return reason === NOT_A_REGULAR_FILE; }

async function readFile(path: string): Promise<Buffer | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) throw new Error(NOT_A_REGULAR_FILE);
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

/** `schtasks` could not say whether the task exists (it timed out, or failed some other way than "no such task"). */
export class TaskQueryFailed extends Error {
  constructor(detail: string) { super(detail); this.name = 'TaskQueryFailed'; }
}

const defaultRun = withTimeout(runWindowsCommand);

/**
 * I4a §4.2: whether the task exists comes from `/Query /FO CSV`'s exit code (0 or 1, whatever the UI language), and only
 * then its XML. Null when there is no task; TaskQueryFailed when `schtasks` gives no answer.
 */
async function readTask(taskName: string, run: WindowsRun): Promise<Buffer | null> {
  const query = await run('schtasks', ['/Query', '/TN', taskName, '/FO', 'CSV', '/NH']);
  if (query.status === 1) return null;
  if (!query.ok || query.status !== 0) throw new TaskQueryFailed(`schtasks /Query /TN ${taskName}: ${query.stderr.trim() || `exit ${query.status}`}`);
  const result = await run('schtasks', ['/Query', '/TN', taskName, '/XML']);
  if (!result.ok || result.status !== 0) throw new TaskQueryFailed(`schtasks /Query /TN ${taskName} /XML: ${result.stderr.trim() || `exit ${result.status}`}`);
  const bytes = Buffer.from(result.stdout);
  if (bytes.length > MAX_DEFINITION_BYTES) throw new Error('Definition exceeds size limit');
  return bytes;
}

/** Where the definition lives: its file, or on Windows the task's name. */
export const definitionLocation = (target: Target): string =>
  target.platform === 'darwin' ? target.plistPath : target.platform === 'linux' ? target.unitPath : target.taskName;

/** The definition file's exact bytes (on Windows the task's XML), or null when there is none. */
export function readDefinitionBytes(target: Target, run: WindowsRun = defaultRun): Promise<Buffer | null> {
  return target.platform === 'win32' ? readTask(target.taskName, run) : readFile(definitionLocation(target));
}

export async function readRegistration(input: ReadInput): Promise<Registration> {
  const location = definitionLocation(input.target);
  try {
    return await registrationFromBytes(input, await readDefinitionBytes(input.target, input.run));
  } catch (error) {
    return { kind: 'unrecognized', location, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Classifies definition bytes already read; the Windows adapter reads them itself to tell a failed query from a foreign task. */
export async function registrationFromBytes(input: ReadInput, content: Buffer | null): Promise<Registration> {
  const target = input.target;
  const location = definitionLocation(target);
  try {
    const requestedRoot = await resolveServiceRoot(input.requestedRoot);
    if (content === null) return { kind: 'absent' };
    const bytes: SerializedDefinition = target.platform === 'darwin' ? { platform: 'darwin', plist: content }
      : target.platform === 'linux' ? { platform: 'linux', unit: content } : { platform: 'win32', xml: content };
    const decoded = decodeGeneratedDefinition(target, bytes);
    const root = await resolveServiceRoot(decoded.root);
    if (root !== decoded.root) throw new Error('Recorded root is not its canonical realpath');
    const definition: Definition = { ...decoded, root };
    return root === requestedRoot ? { kind: 'ours', definition } : { kind: 'other-root', recordedRoot: root, definition };
  } catch (error) {
    return { kind: 'unrecognized', location, reason: error instanceof Error ? error.message : String(error) };
  }
}
