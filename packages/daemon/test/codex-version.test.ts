import { appendFile, chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedCodexVersion, codexVersion, codexVersionAsync } from '../src/agent/codex-appserver/locate';
import { CODEX_MIN_VERSION, CODEX_VERIFIED_VERSION, classifyCodexVersion, compareCodexVersions, parseCodexVersion } from '../src/agent/codex-appserver/version';
import { withBinDirectory } from '../src/platform/tool-path';
import { writeNodeExecutable } from './helpers/node-executable';

describe('Codex version check', () => {
  it('reads codex-cli output, bare versions and prereleases', () => {
    expect(parseCodexVersion('codex-cli 0.162.1')).toBe('0.162.1');
    expect(parseCodexVersion('0.125.0-alpha.3\n')).toBe('0.125.0-alpha.3');
    expect(parseCodexVersion('codex-cli')).toBeNull();
    expect(parseCodexVersion(null)).toBeNull();
  });

  it('orders prereleases before their release', () => {
    expect(compareCodexVersions('0.139.0-alpha.1', '0.139.0')).toBeLessThan(0);
    expect(compareCodexVersions('0.139.0', '0.139.0-alpha.1')).toBeGreaterThan(0);
    expect(compareCodexVersions('0.139.0-alpha.2', '0.139.0-alpha.10')).toBeLessThan(0);
    expect(compareCodexVersions('0.139.0-alpha.1', '0.139.0-beta')).toBeLessThan(0);
    expect(compareCodexVersions('0.140.0', '0.139.9')).toBeGreaterThan(0);
    expect(compareCodexVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('classifies against the minimum and the verified version', () => {
    expect(CODEX_MIN_VERSION).toBe('0.156.1');
    expect(CODEX_VERIFIED_VERSION).toBe('0.156.1');
    expect(classifyCodexVersion('codex-cli 0.139.0')).toBe('tooOld');
    expect(classifyCodexVersion('codex-cli 0.148.0')).toBe('tooOld');
    expect(classifyCodexVersion('codex-cli 0.156.1-alpha.1')).toBe('tooOld');
    expect(classifyCodexVersion('codex-cli 0.156.1')).toBe('ok');
    expect(classifyCodexVersion('codex-cli 0.162.1')).toBe('newer');
    expect(classifyCodexVersion('not a version')).toBe('unknown');
  });
});

describe('PATH for codex children', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it.skipIf(process.platform === 'win32')('appends the binary directory and tool directories after the user PATH', () => {
    expect(withBinDirectory('/Users/u/.nvm/versions/node/v24.14.1/bin/codex', '/usr/bin:/bin', '/Users/u', 'darwin'))
      .toBe(['/usr/bin', '/bin', '/Users/u/.nvm/versions/node/v24.14.1/bin', '/opt/homebrew/bin', '/usr/local/bin', '/Users/u/.local/bin'].join(delimiter));
    expect(withBinDirectory('/usr/local/bin/codex', '/usr/local/bin:/usr/bin', '/home/u', 'linux'))
      .toBe(['/usr/local/bin', '/usr/bin', '/home/u/.local/bin'].join(delimiter));
    expect(withBinDirectory('codex', '/usr/bin', '/home/u', 'linux')).toBe(['/usr/bin', '/usr/local/bin', '/home/u/.local/bin'].join(delimiter));
  });

  it.skipIf(process.platform !== 'win32')('preserves Windows PATH ordering and appends only the selected binary directory', () => {
    const userPath = ['C:\\User Tools', 'C:\\Windows\\System32'].join(delimiter);
    expect(withBinDirectory('D:\\Managed Codex\\codex.cmd', userPath, 'C:\\Users\\fixture', 'win32'))
      .toBe(['C:\\User Tools', 'C:\\Windows\\System32', 'D:\\Managed Codex'].join(delimiter));
    expect(withBinDirectory('codex', userPath, 'C:\\Users\\fixture', 'win32')).toBe(userPath);
  });

  it('distinguishes a failed version probe from an unprobed CLI and retries after repair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vonvon-version-retry-')); dirs.push(dir);
    const { bin, script } = writeNodeExecutable(dir, 'codex', 'process.exit(1);');
    expect(cachedCodexVersion(bin)).toBeUndefined();
    expect(await codexVersionAsync(bin)).toBeNull();
    expect(cachedCodexVersion(bin)).toBeNull();
    await writeFile(script, "console.log('codex-cli 0.163.0');\n");
    expect(await codexVersionAsync(bin)).toBe('codex-cli 0.163.0');
    expect(cachedCodexVersion(bin)).toBe('codex-cli 0.163.0');
  });

  it('invalidates a cached version after the executable is replaced at the same path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vonvon-version-replace-')); dirs.push(dir);
    const { bin, script } = writeNodeExecutable(dir, 'codex', "console.log('codex-cli 0.163.0');");
    expect(await codexVersionAsync(bin)).toBe('codex-cli 0.163.0');
    expect(cachedCodexVersion(bin)).toBe('codex-cli 0.163.0');
    await writeFile(script, "console.log('codex-cli 0.164.0');\n");
    // Change the launcher bytes as an in-place package replacement does. Size differs
    // deterministically, so this exercises invalidation without relying on clock precision.
    await appendFile(bin, process.platform === 'win32' ? '\r\nrem replaced fixture launcher\r\n' : '\n# replaced fixture launcher\n');
    expect(cachedCodexVersion(bin)).toBeUndefined();
    expect(await codexVersionAsync(bin)).toBe('codex-cli 0.164.0');
    expect(cachedCodexVersion(bin)).toBe('codex-cli 0.164.0');
    expect(codexVersion(bin)).toBe('codex-cli 0.164.0');
  });

  // The interpreter has a name found only next to the launcher, as nvm's `node` is
  // when the app is opened from Finder; a machine-wide `node` cannot make this pass.
  it.skipIf(process.platform === 'win32')('runs an nvm-style `#!/usr/bin/env node` codex whose node is not on PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vonvon-nvm-')); dirs.push(dir);
    await symlink(process.execPath, join(dir, 'vonvon-fixture-node'));
    const bin = join(dir, 'codex');
    await writeFile(bin, "#!/usr/bin/env vonvon-fixture-node\nconsole.log('codex-cli 0.162.1');\n");
    await chmod(bin, 0o755);
    vi.stubEnv('PATH', '/usr/bin:/bin');
    expect(codexVersion(bin, { force: true })).toBe('codex-cli 0.162.1');
  });
});
