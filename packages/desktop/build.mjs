import { build } from 'esbuild';
import { access, cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const stage = join(root, 'stage');
const ui = join(root, '../ui/dist');
const daemonSource = join(root, '../daemon');
const daemonStage = join(stage, 'daemon');
const updateConfig = JSON.parse(await readFile(join(root, 'desktop-update.json'), 'utf8'));
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
await writeFile(join(stage, 'package.json'), JSON.stringify({
  name: 'vonvon-bot-desktop',
  version: '0.1.0',
  private: true,
  main: 'desktop/main.cjs',
  description: 'Vonvon Bot desktop',
  author: 'modelzen',
}, null, 2) + '\n');

await mkdir(join(daemonStage, 'dist'), { recursive: true });
await build({
  absWorkingDir: daemonSource,
  entryPoints: ['src/cli/index.ts'],
  outfile: join(daemonStage, 'dist/cli.js'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node22',
  format: 'esm',
});
await cp(join(daemonSource, 'bin'), join(daemonStage, 'bin'), { recursive: true });
const daemonMetadata = JSON.parse(await readFile(join(daemonSource, 'package.json'), 'utf8'));
await writeFile(join(daemonStage, 'package.json'), JSON.stringify({
  name: daemonMetadata.name, version: daemonMetadata.version, type: 'module', bin: daemonMetadata.bin,
  dependencies: daemonMetadata.dependencies,
}, null, 2) + '\n');
for (const file of ['LICENSE.bridge', 'LICENSE.paseo', 'NOTICE', 'PROVENANCE.md', 'import-core.json']) {
  await cp(join(daemonSource, file), join(daemonStage, file));
}

async function packageRoot(name, from) {
  const require = createRequire(join(from, 'package.json'));
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = join(search, name);
    try { await access(join(candidate, 'package.json')); return await realpath(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Cannot stage daemon dependency ${name} from ${from}. Run npm ci in this worktree.`);
}

async function stageDependencies(source, destination, ancestors = new Map()) {
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const dependencies = { ...metadata.dependencies, ...metadata.optionalDependencies };
  for (const name of Object.keys(dependencies)) {
    let dependency;
    try { dependency = await packageRoot(name, source); }
    catch (error) { if (name in (metadata.optionalDependencies ?? {})) continue; throw error; }
    if (ancestors.get(name) === dependency) continue;
    const target = join(destination, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await cp(dependency, target, {
      recursive: true, dereference: true,
      filter: path => !['node_modules', '.git'].includes(basename(path)),
    });
    const next = new Map(ancestors).set(name, dependency);
    await stageDependencies(dependency, target, next);
  }
}
await stageDependencies(daemonSource, daemonStage);
