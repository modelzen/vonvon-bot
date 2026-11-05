import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Same Windows/.NET toolchain as the packaged process supervisor; no compiler or Node is needed at runtime. */
export async function buildWindowsCli(destination) {
  const source = fileURLToPath(new URL('../packages/desktop/src/windows-cli.cs', import.meta.url));
  await mkdir(destination, { recursive: true });
  const assembly = join(destination, 'vonvon.exe');
  const script = join(destination, 'compile-cli.ps1');
  await writeFile(script, [
    'param([string]$Source, [string]$Assembly)',
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -Path $Source -ReferencedAssemblies "System.Core.dll" -OutputAssembly $Assembly -OutputType ConsoleApplication',
  ].join('\r\n'));
  try {
    // Add-Type refuses an existing output; only replace this helper's exact build output.
    await unlink(assembly).catch(error => { if (error.code !== 'ENOENT') throw error; });
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, source, assembly],
      { windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    return createHash('sha256').update(await readFile(assembly)).digest('hex');
  } finally { await unlink(script); }
}
