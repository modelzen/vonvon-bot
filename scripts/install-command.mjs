import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Pasteable command: the bootstrap itself never depends on fetching a single remote URL. */
export async function linuxInstallCommand() {
  const body = await readFile(new URL('./install-bootstrap.sh', import.meta.url), 'utf8');
  return `sh <<'VONVON_INSTALL'\n${body}VONVON_INSTALL\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(await linuxInstallCommand());
