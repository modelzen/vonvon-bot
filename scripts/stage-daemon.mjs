import { build } from 'esbuild';
import { access, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../packages/daemon/', import.meta.url));
const assets = ['LICENSE.bridge', 'LICENSE.paseo', 'NOTICE', 'PROVENANCE.md', 'import-core.json'];

async function packageRoot(name, from) {
  const require = createRequire(join(from, 'package.json'));
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = join(search, name);
    try { await access(join(candidate, 'package.json')); return await realpath(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Cannot stage daemon dependency ${name} from ${from}. Run npm ci in this worktree.`);
}

async function stageDependencies(from, destination, ancestors = new Map()) {
  const metadata = JSON.parse(await readFile(join(from, 'package.json'), 'utf8'));
  const dependencies = { ...metadata.dependencies, ...metadata.optionalDependencies };
  for (const name of Object.keys(dependencies)) {
    let dependency;
    try { dependency = await packageRoot(name, from); }
    catch (error) { if (name in (metadata.optionalDependencies ?? {})) continue; throw error; }
    if (ancestors.get(name) === dependency) continue;
    const target = join(destination, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await cp(dependency, target, {
      recursive: true, dereference: true,
      filter: path => !['node_modules', '.git'].includes(basename(path)),
    });
    await stageDependencies(dependency, target, new Map(ancestors).set(name, dependency));
  }
}

export async function stageDaemon(destination, metadata) {
  await mkdir(join(destination, 'dist'), { recursive: true });
  await build({
    absWorkingDir: source,
    entryPoints: ['src/cli/index.ts'],
    outfile: join(destination, 'dist/cli.js'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: 'node22',
    format: 'esm',
  });
  await cp(join(source, 'bin'), join(destination, 'bin'), { recursive: true });
  await writeFile(join(destination, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
  for (const file of assets) await cp(join(source, file), join(destination, file));
  await stageDependencies(source, destination);
}
