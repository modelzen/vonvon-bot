import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface RecipeFileEntry {name: string; bytes: number; sha256: string; data?: string}
interface Request {
  operation: 'source' | 'identity' | 'stage' | 'load' | 'verify'; root: string; installation?: string; generation?: string;
  expectedRoot?: string; names?: readonly string[]; entries?: readonly RecipeFileEntry[];
}
interface Response {root: string; files?: {name: string; identity: string; data: string}[]}
function helperPath(): string {
  const name = `recipe-files${process.platform === 'win32' ? '.exe' : ''}`;
  const directory = dirname(fileURLToPath(import.meta.url));
  const native = directory.endsWith(join('src', 'recipe')) ? join(directory, '../../dist/native') : join(directory, 'native');
  const single = join(native, name);
  return existsSync(single) ? single : join(native, `${process.platform}-${process.arch}`, name);
}
export async function recipeFileIO(request: Request): Promise<Response> {
  if (!isAbsolute(request.root) || request.root.includes('\0')) throw new Error('Invalid recipe root');
  return new Promise((resolve, reject) => {
    const child = execFile(helperPath(), [], {timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true}, (error, stdout) => {
      if (error) {reject(new Error('Recipe file operation refused or packaged helper unavailable')); return;}
      try {resolve(JSON.parse(stdout) as Response);} catch {reject(new Error('Invalid recipe file helper response'));}
    });
    child.stdin!.on('error', () => { /* execFile reports the failed child. */ });
    child.stdin!.end(JSON.stringify(request));
  });
}
