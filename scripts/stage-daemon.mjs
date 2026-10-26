import { build } from 'esbuild';
import { access, cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
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

function runtimeFile(source, path, name) {
  const local = relative(source, path);
  if (!local) return true;
  const first = local.split(sep)[0];
  if (['test', 'tests', '__tests__', 'examples', 'docs'].includes(first)) return false;
  if (/\.d\.(?:ts|mts|cts)$|\.map$/.test(local)) return false;
  if (name === '@vonvon/client' || name === '@vonvon/protocol') {
    return first === 'dist' || first === 'package.json' || /^(?:LICENSE|NOTICE)(?:[.-]|$)/i.test(first);
  }
  return true;
}

export async function stageDependencies(from, destination, options = {}) {
  const { ancestors = new Map(), includePeers = false, compact = false, copies = new Map() } = options;
  const metadata = options.metadata ?? JSON.parse(await readFile(join(from, 'package.json'), 'utf8'));
  const dependencies = { ...(includePeers ? metadata.peerDependencies : {}), ...metadata.dependencies, ...metadata.optionalDependencies };
  for (const name of Object.keys(dependencies)) {
    let dependency;
    try { dependency = await packageRoot(name, from); }
    catch (error) {
      if (name in (metadata.optionalDependencies ?? {}) || metadata.peerDependenciesMeta?.[name]?.optional) continue;
      throw error;
    }
    if (ancestors.get(name) === dependency) continue;
    const target = join(destination, 'node_modules', name);
    const peers = includePeers || name === '@anthropic-ai/claude-agent-sdk';
    const next = { ancestors: new Map(ancestors).set(name, dependency), includePeers: peers, compact, copies };
    const prior = compact && copies.get(dependency);
    if (prior) {
      if (target !== prior.target) {
        await mkdir(dirname(target), { recursive: true });
        try { await symlink(relative(dirname(target), prior.target), target); }
        catch (error) {
          if (error.code !== 'EEXIST' || await realpath(target) !== await realpath(prior.target)) throw error;
        }
      }
      // A package first reached outside the SDK graph may later need its peers.
      if (peers && !prior.peers) {
        prior.peers = true;
        await stageDependencies(dependency, prior.target, next);
      }
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    if (compact) copies.set(dependency, { target, peers });
    await cp(dependency, target, {
      recursive: true, dereference: true,
      filter: path => !['node_modules', '.git'].includes(basename(path)) && (!compact || runtimeFile(dependency, path, name)),
    });
    await stageDependencies(dependency, target, next);
  }
}

export async function stageDaemon(destination, metadata, options = {}) {
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
  await stageDependencies(source, destination, { ...options, metadata });
}
