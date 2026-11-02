import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, expect, it } from 'vitest';
import { switchCurrent } from '../src/service/current-release';

// main 必败: a running process took process.argv[1], `current/...`, as its entry, so after the switch whatever it
// started ran the new release (server-3 4.7)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-self-entry-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it.skipIf(process.platform === 'win32')('keeps the release it started from after current moves, and Node resolves its own path', async () => {
  for (const version of ['1.0.0', '1.0.1']) {
    const bin = join(root, 'releases', version, 'app', 'bin');
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, 'releases', version, 'node', 'bin'), { recursive: true });
    await symlink(process.execPath, join(root, 'releases', version, 'node', 'bin', 'node'));
    await writeFile(join(root, 'releases', version, 'standalone.json'), JSON.stringify({ v: 1, version }));
    await build({ entryPoints: [fileURLToPath(new URL('../src/core/self-entry.ts', import.meta.url))], outfile: join(bin, 'self-entry.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    await writeFile(join(bin, 'x.mjs'), `import { selfEntry } from './self-entry.mjs';
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => process.stdout.write(JSON.stringify({ entry: selfEntry(), node: process.execPath }) + '\\n'));
`);
  }
  await switchCurrent(root, '1.0.0', 'linux');
  const child = spawn(join(root, 'current', 'node', 'bin', 'node'), [join(root, 'current', 'app', 'bin', 'x.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines: string[] = [];
  child.stdout.setEncoding('utf8').on('data', (text: string) => lines.push(...text.trim().split('\n')));
  const ask = async (count: number): Promise<{ entry: string; node: string }> => {
    child.stdin.write('?\n');
    await expect.poll(() => lines.length, { timeout: 10_000 }).toBe(count);
    return JSON.parse(lines[count - 1]!) as { entry: string; node: string };
  };
  try {
    const before = await ask(1);
    await switchCurrent(root, '1.0.1', 'linux');
    const after = await ask(2);
    for (const seen of [before, after]) {
      expect(seen.entry).toBe(join(root, 'releases', '1.0.0', 'app', 'bin', 'x.mjs'));
      // started through current/node/bin/node, a link: Node reports the file itself, so no selfNode() pin is needed
      expect(seen.node).toBe(realpathSync(process.execPath));
    }
  } finally { child.kill(); }
});
