import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, cp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecipeFiles, recipeFileTargets } from './build-recipe-files.mjs';
import { stageDaemon } from './stage-daemon.mjs';
import { fileEntries, sha256, validateTree } from './package-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// The lockfile pins npm (the desktop app ships it), and `npm run` puts it first on PATH.
// Use that copy explicitly, so the tarball and its manifest do not depend on how this script starts.
const npmCli = join(root, 'node_modules/npm/bin/npm-cli.js');
const npm = (npmArgs, options) => execFileSync(process.execPath, [npmCli, ...npmArgs], options);
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out') throw new Error('usage: pack-vonvon-bot.mjs --out <dir>');
const out = resolve(args[1]);
const repo = await realpath(root);
let existing = out;
while (true) {
  try { existing = await realpath(existing); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; existing = dirname(existing); }
}
if (existing === repo || existing.startsWith(repo + sep)) throw new Error('output must be outside repository');
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('repository must be clean');
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const source = join(root, 'packages/daemon');
const daemon = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const lockBytes = await readFile(join(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes);
for (const path of ['packages/ui/dist/index.html', 'packages/protocol/dist/index.js', 'packages/client/dist/index.js', 'packages/daemon/dist/cli.js']) await readFile(join(root, path));
const temporary = await mkdtemp(join(tmpdir(), 'vonvon-package-'));
try {
  const stage = join(temporary, 'stage');
  await stageDaemon(stage, {
    name: 'vonvon-bot', version: daemon.version, type: 'module',
    bin: { vonvon: 'bin/vonvon.mjs' },
    engines: daemon.engines, license: daemon.license, author: daemon.author,
    dependencies: daemon.dependencies,
    bundleDependencies: Object.keys(daemon.dependencies),
  });
  for (const target of recipeFileTargets) buildRecipeFiles(join(stage, 'dist'), target, true);
  await mkdir(join(stage, 'ui'), { recursive: true });
  await cp(join(root, 'packages/ui/dist'), join(stage, 'ui/dist'), { recursive: true });
  const preview = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: stage, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }));
  if (!Array.isArray(preview) || preview.length !== 1 || !Array.isArray(preview[0].files)) {
    throw new Error('npm pack did not return a file inventory');
  }
  const selected = new Set(preview[0].files.map(file => file.path));
  for (const entry of await fileEntries(stage)) {
    if (!selected.has(entry.path)) await rm(join(stage, entry.path));
    else await chmod(join(stage, entry.path), parseInt(entry.mode, 8));
  }
  await validateTree(stage, lock);
  const manifest = {
    schema: 1, package: 'vonvon-bot', version: daemon.version, sourceHead,
    lockfileSha256: sha256(lockBytes),
    node: process.version,
    npm: npm(['--version'], { encoding: 'utf8' }).trim(),
    esbuild: JSON.parse(await readFile(join(root, 'node_modules/esbuild/package.json'), 'utf8')).version,
    files: await fileEntries(stage),
  };
  await writeFile(join(stage, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await chmod(join(stage, 'build-manifest.json'), 0o644);
  await mkdir(out, { recursive: true });
  const output = npm(['pack', '--ignore-scripts', '--pack-destination', out], { cwd: stage, encoding: 'utf8' }).trim().split('\n').at(-1);
  const tarball = join(out, output);
  await writeFile(`${tarball}.manifest.json`, JSON.stringify({ ...manifest, tarballSha256: sha256(await readFile(tarball)) }, null, 2) + '\n');
  process.stdout.write(`${tarball}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
