import { vi } from 'vitest';
import type { CommandInfo } from '../../src/cli/index';

/** The CLI entry runs its command line as it loads: under `--version` it only prints, so the tree loads with nothing run. */
export async function loadCommands(): Promise<CommandInfo[]> {
  const argv = process.argv;
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  process.argv = [argv[0] ?? 'node', 'vonvon', '--version'];
  try { return (await import('../../src/cli/index')).commandList(); }
  finally { process.argv = argv; write.mockRestore(); }
}
