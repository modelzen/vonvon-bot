import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundledNpmCli, npmInvocation } from '../src/platform/npm';
import { toolDirectories, withToolDirectories } from '../src/platform/tool-path';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** The desktop app's Resources: bundled daemon, app.asar and, unless `npm` is false, npm. */
async function resources(npm = true): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bundled-npm-')));
  roots.push(root);
  const files: Array<[string, string]> = [
    ['daemon/package.json', JSON.stringify({ name: '@vonvon/daemon', bin: { vonvon: 'bin/vonvon.mjs' } })],
    ['daemon/bin/vonvon.mjs', ''],
    ['daemon/dist/cli.js', ''],
    ['app.asar/package.json', JSON.stringify({ name: 'vonvon-bot-desktop', main: 'desktop/main.cjs' })],
    ['app.asar/desktop/main.cjs', ''],
  ];
  if (npm) files.push(['npm/bin/npm-cli.js', '']);
  for (const [file, content] of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}

describe('bundled npm', () => {
  it('finds npm next to the bundled daemon and nowhere else', async () => {
    const withNpm = await resources();
    expect(bundledNpmCli({}, join(withNpm, 'daemon'))).toBe(join(withNpm, 'npm', 'bin', 'npm-cli.js'));
    expect(bundledNpmCli({}, join(await resources(false), 'daemon'))).toBeUndefined();
    // This checkout is a development daemon, which has no bundled npm.
    expect(bundledNpmCli({})).toBeUndefined();
  });

  it('prefers an absolute VONVON_NPM_CLI and ignores a relative one', async () => {
    const daemon = join(await resources(), 'daemon');
    expect(bundledNpmCli({ VONVON_NPM_CLI: '/opt/npm/bin/npm-cli.js' }, daemon)).toBe('/opt/npm/bin/npm-cli.js');
    expect(bundledNpmCli({ VONVON_NPM_CLI: 'npm-cli.js' }, daemon)).toBeUndefined();
  });

  it('runs a trusted CLI with this Node in Node mode, otherwise npm from PATH', () => {
    expect(npmInvocation('/r/npm/bin/npm-cli.js')).toEqual({ command: process.execPath, args: ['/r/npm/bin/npm-cli.js'], env: { ELECTRON_RUN_AS_NODE: '1', npm_config_update_notifier: 'false' } });
    expect(npmInvocation()).toEqual({ command: 'npm', args: [], env: {} });
  });
});

describe('tool directories', () => {
  it('adds Homebrew only on macOS and nothing on Windows', () => {
    expect(toolDirectories('/Users/u', 'darwin')).toEqual(['/opt/homebrew/bin', '/usr/local/bin', '/Users/u/.local/bin']);
    expect(toolDirectories('/home/u', 'linux')).toEqual(['/usr/local/bin', '/home/u/.local/bin']);
    expect(toolDirectories('C:\\Users\\u', 'win32')).toEqual([]);
  });

  it('appends only the missing directories after the user PATH', () => {
    const finder = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
    expect(withToolDirectories(finder, '/Users/u', 'darwin')).toBe([finder, '/opt/homebrew/bin', '/usr/local/bin', '/Users/u/.local/bin'].join(delimiter));
    const shell = ['/Users/u/.local/bin', '/opt/homebrew/bin', '/usr/bin'].join(delimiter);
    expect(withToolDirectories(shell, '/Users/u', 'darwin')).toBe([shell, '/usr/local/bin'].join(delimiter));
    expect(withToolDirectories(undefined, '/home/u', 'linux')).toBe(['/usr/local/bin', '/home/u/.local/bin'].join(delimiter));
  });
});
