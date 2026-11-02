import { vi } from 'vitest';
import type { CommandInfo } from '../../src/cli/index';

/** The CLI entry runs its command line as it loads: under `--version` it only prints, so the tree loads with nothing run. */
async function loadEntry(): Promise<typeof import('../../src/cli/index')> {
  const argv = process.argv;
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  process.argv = [argv[0] ?? 'node', 'vonvon', '--version'];
  try { return await import('../../src/cli/index'); }
  finally { process.argv = argv; write.mockRestore(); }
}
export async function loadCommands(): Promise<CommandInfo[]> {
  return (await loadEntry()).commandList();
}
/** The commands refused in a Bot session (devices-4a 4.9). */
export async function loadLocalOnly(): Promise<readonly string[]> {
  return [...(await loadEntry()).LOCAL_ONLY];
}
