import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { loadOpenCodeBridgePluginArtifact } from '../src/agent/providers/opencode/bridge';

describe('built OpenCode V2 plugin', () => {
  it.each(['cli.js', 'index.js', 'host.js'])('loads beside the flat %s entry without compiling', async entry => {
    const moduleUrl = new URL(`../dist/${entry}`, import.meta.url);
    await readFile(moduleUrl);
    const expected = await readFile(new URL('../dist/v2/bridge-plugin.bundle.mjs', import.meta.url));
    const compile = vi.fn(async (): Promise<Uint8Array> => { throw new Error('Packaged code must not compile'); });
    expect(await loadOpenCodeBridgePluginArtifact(moduleUrl.href, compile, 2)).toEqual(expected);
    expect(compile).not.toHaveBeenCalled();
  });
});
