import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AUTO_SELECT_ATTEMPT_MS, tuneNetworkDefaults } from '../src/core/net-tuning';

const before = { timeout: net.getDefaultAutoSelectFamilyAttemptTimeout(), order: dns.getDefaultResultOrder() };
const dirs: string[] = [];
afterEach(() => {
  net.setDefaultAutoSelectFamilyAttemptTimeout(before.timeout);
  dns.setDefaultResultOrder(before.order);
});
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('network defaults (s23f2)', () => {
  it('each connection attempt waits 1 s, and IPv4 is tried first', () => {
    tuneNetworkDefaults();
    expect(AUTO_SELECT_ATTEMPT_MS).toBe(1_000);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(1_000);
    expect(dns.getDefaultResultOrder()).toBe('ipv4first');
  });

  it('the CLI entry imports the module that sets them before anything else, so no daemon module runs without them', async () => {
    const source = await readFile(resolve('src/cli/index.ts'), 'utf8');
    expect(source.match(/^import\s[^;]*;/m)?.[0]).toBe("import './tune-network';");
    const tune = await readFile(resolve('src/cli/tune-network.ts'), 'utf8');
    expect(tune).toMatch(/^tuneNetworkDefaults\(\);$/m);
  });

  it('the CLI entry sets them as it loads, so the supervisor, each bot it starts with that entry and each command have them', async () => {
    await mkdir(resolve('node_modules/.cache'), { recursive: true });
    const dir = await mkdtemp(resolve('node_modules/.cache/vonvon-net-'));
    dirs.push(dir);
    const entry = join(dir, 'cli.mjs');
    await build({ entryPoints: [resolve('src/cli/index.ts')], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
    // read once the entry has run: `--version` prints and exits without touching any data
    const probe = join(dir, 'probe.mjs');
    await writeFile(probe, "import net from 'node:net'; import dns from 'node:dns';\n"
      + "process.on('exit', () => process.stderr.write(`\\nNET ${net.getDefaultAutoSelectFamilyAttemptTimeout()} ${dns.getDefaultResultOrder()}\\n`));\n");
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(probe).href, entry, '--version'], { encoding: 'utf8', timeout: 30_000 });
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('NET 1000 ipv4first');
  });
});
