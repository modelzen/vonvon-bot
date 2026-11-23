import { build } from 'esbuild';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedProductVersion } from '../../scripts/product-version.mjs';
import { stageDaemon } from '../../scripts/stage-daemon.mjs';
import { normalizeWindowsPublicKey } from './src/windows-update-manifest.mjs';
import { assertNoBundledClaude } from '../../scripts/desktop-backend-policy.mjs';
import { buildWindowsCli } from '../../scripts/build-windows-cli.mjs';

const version = await checkedProductVersion();
const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const stage = join(root, 'stage');
const ui = join(root, '../ui/dist');
const daemonSource = join(root, '../daemon');
const daemonStage = join(stage, 'daemon');
const updateConfig = JSON.parse(await readFile(process.env.VONVON_DESKTOP_UPDATE_CONFIG || join(root, 'desktop-update.json'), 'utf8'));
const windowsUpdateConfig = JSON.parse(await readFile(process.env.VONVON_WINDOWS_UPDATE_CONFIG || join(root,'windows-update.json'),'utf8'));
if (!windowsUpdateConfig || Object.keys(windowsUpdateConfig).length !== 1 || !windowsUpdateConfig.publicKey) throw new Error('Windows update configuration must contain only publicKey');
windowsUpdateConfig.publicKey = normalizeWindowsPublicKey(windowsUpdateConfig.publicKey);
const keys = updateConfig !== null && typeof updateConfig === 'object' && !Array.isArray(updateConfig)
  ? Object.keys(updateConfig)
  : null;
if (keys === null || (keys.length !== 0 && (
  keys.length !== 2 || !keys.includes('manifestURL') || !keys.includes('teamIdentifier') ||
  typeof updateConfig.manifestURL !== 'string' ||
  typeof updateConfig.teamIdentifier !== 'string' ||
  !/^[A-Z0-9]{10}$/.test(updateConfig.teamIdentifier)
))) {
  throw new Error('desktop-update.json must be {} or contain only manifestURL and teamIdentifier');
}
if (keys.length === 2) {
  let url;
  try { url = new URL(updateConfig.manifestURL); } catch {}
  if (url?.protocol !== 'https:' || url.username || url.password) {
    throw new Error('desktop-update.json manifestURL must be HTTPS without credentials');
  }
}
await access(join(ui, 'index.html'));
await access(join(root, 'assets/tray.png'));
await access(join(root, 'assets/macos-icon.png'));
await mkdir(dist, { recursive: true });
const windowsCli = join(dist, 'cli');
const windowsCliSha256 = process.platform === 'win32' ? await buildWindowsCli(windowsCli) : undefined;
await build({
  absWorkingDir: root,
  entryPoints: { main: 'src/main.ts', preload: 'src/preload.ts' },
  outdir: dist,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  define: {
    __VONVON_ACCOUNT_WEB_ORIGIN__: JSON.stringify(process.env.VONVON_ACCOUNT_WEB_ORIGIN) ?? 'undefined',
    __VONVON_ACCOUNT_API_ORIGIN__: JSON.stringify(process.env.VONVON_ACCOUNT_API_ORIGIN) ?? 'undefined',
    'process.env.NODE_ENV': '"production"',
    __VONVON_WINDOWS_CLI_SHA256__: JSON.stringify(windowsCliSha256) ?? 'undefined',
  },
});
await writeFile(join(dist, 'update-config.json'), JSON.stringify(updateConfig) + '\n');
await writeFile(join(dist, 'windows-update-config.json'), JSON.stringify(windowsUpdateConfig) + '\n');
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'desktop'), { recursive: true });
await mkdir(join(stage, 'dist'), { recursive: true });
await mkdir(join(stage, 'assets'), { recursive: true });
if (windowsCliSha256) await cp(windowsCli, join(stage, 'cli'), { recursive: true });
await cp(join(dist, 'main.cjs'), join(stage, 'desktop/main.cjs'));
await cp(join(dist, 'preload.cjs'), join(stage, 'desktop/preload.cjs'));
await cp(join(dist, 'update-config.json'), join(stage, 'dist/update-config.json'));
await cp(join(dist, 'windows-update-config.json'), join(stage, 'dist/windows-update-config.json'));
await cp(ui, join(stage, 'ui'), { recursive: true });
await cp(join(root, 'assets/tray.png'), join(stage, 'assets/tray.png'));
await cp(join(root, 'assets/macos-icon.png'), join(stage, 'assets/macos-icon.png'));
await cp(join(root, 'assets/windows-icon.ico'), join(stage, 'assets/windows-icon.ico'));
await writeFile(join(stage, 'package.json'), JSON.stringify({
  name: 'vonvon-bot-desktop',
  version,
  license: 'UNLICENSED',
  private: true,
  main: 'desktop/main.cjs',
  description: 'Vonvon Bot desktop',
  author: 'modelzen',
}, null, 2) + '\n');

// The daemon runs Resources/npm/bin/npm-cli.js with Electron in Node mode, so a Mac without Node can still install.
const pinnedNpm = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).devDependencies.npm;
const npmSource = dirname(createRequire(join(root, 'package.json')).resolve('npm/package.json'));
const npmVersion = JSON.parse(await readFile(join(npmSource, 'package.json'), 'utf8')).version;
if (npmVersion !== pinnedNpm) throw new Error(`Installed npm ${npmVersion} is not the pinned ${pinnedNpm}. Run npm ci.`);
await cp(npmSource, join(stage, 'npm'), { recursive: true, dereference: true });

const daemonMetadata = JSON.parse(await readFile(join(daemonSource, 'package.json'), 'utf8'));
// Windows packages use real copies so building does not require symlink privileges.
await stageDaemon(daemonStage, {
  name: daemonMetadata.name, version, type: 'module', bin: daemonMetadata.bin,
  license: daemonMetadata.license, author: daemonMetadata.author,
  dependencies: daemonMetadata.dependencies,
}, { compact: process.platform !== 'win32', hoist: process.platform === 'win32' });
await assertNoBundledClaude(daemonStage);
