import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export interface MutexChild { child: ChildProcess; output: () => string }

/** Bundles the real `config/data-access.ts` into `dir`, for child processes that hold a real mutex. */
export async function bundleDataAccess(dir: string): Promise<string> {
  const outfile = join(dir, 'data-access.cjs');
  const source = fileURLToPath(new URL('../../src/config/data-access.ts', import.meta.url));
  await build({ entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  return outfile;
}

/**
 * Runs `code` in a child with the bundle at `entry` as `m` and `args` as `process.argv.slice(1)`; resolves once the child
 * writes `ready`. `output()` is what it wrote after that.
 */
export async function mutexChild(entry: string, code: string, args: string[] = []): Promise<MutexChild> {
  const source = `const m=require(${JSON.stringify(entry)});${code};setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', source, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const exited = (exitCode: number | null): void => reject(new Error(`Mutex child exited with ${exitCode} before ready: ${out}`));
    child.once('exit', exited);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.startsWith('ready')) { child.removeListener('exit', exited); resolve(); }
    });
  });
  return { child, output: () => out.slice('ready'.length) };
}

/** A child holding the real `role` mutex of `home` until it is killed. */
export function holdMutex(entry: string, home: string, role: string): Promise<MutexChild> {
  return mutexChild(entry,
    `m.acquireMutex(process.argv[1],process.argv[2],0).then(()=>process.stdout.write('ready'),e=>{console.error(e.message);process.exit(1)})`, [home, role]);
}
