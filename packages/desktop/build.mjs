import { build } from 'esbuild';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedProductVersion } from '../../scripts/product-version.mjs';
import { stageDaemon } from '../../scripts/stage-daemon.mjs';

const version = await checkedProductVersion();
const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const stage = join(root, 'stage');
const ui = join(root, '../ui/dist');
const daemonSource = join(root, '../daemon');
const daemonStage = join(stage, 'daemon');
const updateConfig = JSON.parse(await readFile(process.env.VONVON_DESKTOP_UPDATE_CONFIG || join(root, 'desktop-update.json'), 'utf8'));
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
  define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile(join(dist, 'update-config.json'), JSON.stringify(updateConfig) + '\n');
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'desktop'), { recursive: true });
await mkdir(join(stage, 'dist'), { recursive: true });
await mkdir(join(stage, 'assets'), { recursive: true });
await cp(join(dist, 'main.cjs'), join(stage, 'desktop/main.cjs'));
await cp(join(dist, 'preload.cjs'), join(stage, 'desktop/preload.cjs'));
await cp(join(dist, 'update-config.json'), join(stage, 'dist/update-config.json'));
await cp(ui, join(stage, 'ui'), { recursive: true });
await cp(join(root, 'assets/tray.png'), join(stage, 'assets/tray.png'));
await cp(join(root, 'assets/macos-icon.png'), join(stage, 'assets/macos-icon.png'));
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
const sdkPackage = '@anthropic-ai/claude-agent-sdk';
const sdkVersion = daemonMetadata.devDependencies[sdkPackage];
const sdkSource = dirname(createRequire(join(daemonSource, 'package.json')).resolve(sdkPackage));
const installedSdk = JSON.parse(await readFile(join(sdkSource, 'package.json'), 'utf8'));
if (installedSdk.version !== sdkVersion) throw new Error(`Installed Claude Agent SDK ${installedSdk.version} is not the pinned ${sdkVersion}. Run npm ci.`);
await stageDaemon(daemonStage, {
  name: daemonMetadata.name, version, type: 'module', bin: daemonMetadata.bin,
  license: daemonMetadata.license, author: daemonMetadata.author,
  dependencies: { ...daemonMetadata.dependencies, [sdkPackage]: sdkVersion },
  bundledBackends: ['claude-agent'],
}, { compact: true });
// A resolvable SDK alone is insufficient: the matching native runtime must also
// be present. Fail the build instead of offering an unusable built-in Provider.
const sdkRequire = createRequire(join(daemonStage, 'node_modules', sdkPackage, 'package.json'));
const runtimePackage = `${sdkPackage}-${process.platform}-${process.arch}`;
const runtimeRoot = (sdkRequire.resolve.paths(runtimePackage) ?? []).map(path => join(path, runtimePackage));
let runtimeFound = false;
for (const path of runtimeRoot) {
  try {
    const runtime = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    await access(join(path, 'claude'));
    if (runtime.version === sdkVersion) { runtimeFound = true; break; }
  } catch {}
}
if (!runtimeFound) throw new Error(`Missing staged Claude runtime ${runtimePackage}@${sdkVersion}. Run npm ci with optional dependencies.`);
