import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { win32 } from 'node:path';
import { decodeGeneratedDefinition, type Definition, type SerializedDefinition } from './definitions';
import { resolveServiceRoot, WINDOWS_CMD_NAME, WINDOWS_VBS_NAME, WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE, type CanonicalRoot, type Target } from './identity';

export type Registration =
  | { kind: 'absent' }
  | { kind: 'ours'; definition: Definition }
  | { kind: 'other-root'; recordedRoot: CanonicalRoot; definition: Definition }
  | { kind: 'unrecognized'; location: string; reason: string };
export type WindowsRunObservation =
  | { kind: 'absent' }
  | { kind: 'value'; type: 'REG_SZ' | 'REG_EXPAND_SZ'; value: string }
  | { kind: 'unavailable'; reason: string };

type ReadInput =
  | { target: Extract<Target, { platform: 'darwin' | 'linux' }>; requestedRoot: string }
  | { target: Extract<Target, { platform: 'win32' }>; requestedRoot: string; windowsRun: WindowsRunObservation };

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
  let target = input.target;
  let location = target.platform === 'darwin' ? target.plistPath : target.platform === 'linux' ? target.unitPath : target.vbsPath;
  try {
    const requestedRoot = await resolveServiceRoot(input.requestedRoot);
    let bytes: SerializedDefinition;
    if (target.platform === 'win32') {
      location = `${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE}`;
      if (!('windowsRun' in input)) throw new Error('Windows Run observation is required');
      const observation = input.windowsRun;
      if (observation.kind === 'unavailable') throw new Error(`Windows Run observation unavailable: ${observation.reason}`);
      let runValue: string;
      if (observation.kind === 'value') {
        if (observation.type !== 'REG_SZ') throw new Error('Windows Run value must be REG_SZ');
        const match = /^wscript\.exe \/\/B "([^"\r\n]+)"$/.exec(observation.value);
        const vbsPath = match?.[1];
        if (!vbsPath || !win32.isAbsolute(vbsPath) || win32.basename(vbsPath) !== WINDOWS_VBS_NAME) throw new Error('Unrecognized Windows Run locator');
        target = { platform: 'win32', vbsPath, cmdPath: win32.join(win32.dirname(vbsPath), WINDOWS_CMD_NAME) };
        runValue = observation.value;
      } else {
        const service = win32.join(requestedRoot, 'service');
        if (target.cmdPath !== win32.join(service, WINDOWS_CMD_NAME) || target.vbsPath !== win32.join(service, WINDOWS_VBS_NAME)) throw new Error('Local Windows target does not match requested root');
        runValue = `wscript.exe //B "${target.vbsPath}"`;
      }
      location = target.vbsPath;
      const vbs = await readFile(target.vbsPath);
      location = target.cmdPath;
      const cmd = await readFile(target.cmdPath);
      if (vbs === null && cmd === null && observation.kind === 'absent') return { kind: 'absent' };
      if (vbs === null || cmd === null) {
        location = vbs === null ? target.vbsPath : target.cmdPath;
        throw new Error('Incomplete Windows launcher pair');
      }
      bytes = { platform: 'win32', cmd, vbs, runValue };
    } else {
      const content = await readFile(location);
      if (content === null) return { kind: 'absent' };
      bytes = target.platform === 'darwin' ? { platform: 'darwin', plist: content } : { platform: 'linux', unit: content };
    }
    const decoded = decodeGeneratedDefinition(target, bytes);
    const root = await resolveServiceRoot(decoded.root);
    if (root !== decoded.root) throw new Error('Recorded root is not its canonical realpath');
    const definition: Definition = { ...decoded, root };
    return root === requestedRoot ? { kind: 'ours', definition } : { kind: 'other-root', recordedRoot: root, definition };
  } catch (error) {
    if (error instanceof Error && 'location' in error && typeof error.location === 'string') location = error.location;
    return { kind: 'unrecognized', location, reason: error instanceof Error ? error.message : String(error) };
  }
}
