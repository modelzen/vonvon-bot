import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Compile the embedded C# at packaging time. The digest is embedded in cli.js,
 * so a packaged daemon never accepts an unbound on-disk compilation cache. */
export async function buildWindowsSupervisor(destination) {
  const sourcePath = fileURLToPath(new URL('../packages/daemon/src/provider/process/windows-supervisor.ts', import.meta.url));
  const result = await build({ stdin: { contents: `export {SUPERVISOR_SOURCE} from ${JSON.stringify(sourcePath)};`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', define: { __VONVON_SUPERVISOR_SHA256__: 'undefined' } });
  const { SUPERVISOR_SOURCE } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const directory = join(destination, 'native');
  await mkdir(directory, { recursive: true });
  const source = join(directory, 'supervisor.cs');
  const script = join(directory, 'compile-supervisor.ps1');
  const assembly = join(directory, 'windows-supervisor.exe');
  await writeFile(source, SUPERVISOR_SOURCE, 'utf8');
  await writeFile(script, [
    'param([string]$Source, [string]$Assembly)',
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -Path $Source -ReferencedAssemblies "System.Core.dll" -OutputAssembly $Assembly -OutputType ConsoleApplication',
  ].join('\r\n'));
  try {
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, source, assembly], { windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return createHash('sha256').update(await readFile(assembly)).digest('hex');
  } finally { await Promise.all([unlink(source), unlink(script)]); }
}
