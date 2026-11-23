import { build } from 'esbuild';
import { access, cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildWindowsSupervisor } from './build-windows-supervisor.mjs';

const source = fileURLToPath(new URL('../packages/daemon/', import.meta.url));
const assets = ['LICENSE.bridge', 'LICENSE.paseo', 'NOTICE', 'PROVENANCE.md', 'import-core.json'];
/** Our own workspace packages: bundled into dist/cli.js, never shipped as readable files (devices 7.1). */
export const bundledWorkspaces = ['@vonvon/client', '@vonvon/protocol'];
const packageOf = specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

async function packageRoot(name, from) {
  const require = createRequire(join(from, 'package.json'));
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = join(search, name);
    try { await access(join(candidate, 'package.json')); return await realpath(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Cannot stage daemon dependency ${name} from ${from}. Run npm ci in this worktree.`);
}

/** A third-party package's runtime files: no tests, docs, declarations, source maps or TypeScript sources. Its `src/` stays, as some packages run from there. */
function runtimeFile(source, path) {
  const local = relative(source, path);
  if (!local) return true;
  if (['test', 'tests', '__tests__', 'examples', 'docs'].includes(local.split(sep)[0])) return false;
  return !/\.(?:[mc]?ts|map)$/.test(local);
}

/** The desktop and server layouts (compact, hoist) ship runtime files only; the npm package layout keeps whole packages. */
const copied = (from, runtimeOnly) => path => !['node_modules', '.git'].includes(basename(path)) && (!runtimeOnly || runtimeFile(from, path));

export async function stageDependencies(from, destination, options = {}) {
  if (options.hoist) return stageHoistedDependencies(from, destination, options);
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
    await cp(dependency, target, { recursive: true, dereference: true, filter: copied(dependency, compact) });
    await stageDependencies(dependency, target, next);
  }
}

// NSIS extraction uses Windows path limits. Repeating the complete dependency
// graph below every package can silently lose runtime files during installation.
// Hoist compatible physical packages without links; retain local copies where
// different dependency versions would otherwise shadow one another.
async function stageHoistedDependencies(from, destination, options) {
  const root = { from, target: destination, parent: undefined, metadata: options.metadata };
  const slots = new Map();
  const edges = [];
  const instances = new Map();
  const peerSources = new Set();
  function resolution(owner, name, proposedTarget, proposedSource) {
    for (let scope = owner; scope; scope = scope.parent) {
      const key = join(scope.target, 'node_modules', name);
      const found = key === proposedTarget ? proposedSource : slots.get(key)?.from;
      if (found) return found;
    }
  }
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const owner = queue[i];
    const metadata = owner.metadata ?? JSON.parse(await readFile(join(owner.from, 'package.json'), 'utf8'));
    // Relocation changes peer lookup too, even for packages outside the SDK graph.
    const dependencies = { ...metadata.peerDependencies, ...metadata.dependencies, ...metadata.optionalDependencies };
    for (const name of Object.keys(dependencies)) {
      let dependency;
      try { dependency = await packageRoot(name, owner.from); }
      catch (error) {
        if (name in (metadata.optionalDependencies ?? {}) || metadata.peerDependenciesMeta?.[name]?.optional) continue;
        throw error;
      }
      if (name in (metadata.peerDependencies ?? {})) peerSources.add(dependency);
      const priorInstances = instances.get(dependency);
      if (peerSources.has(dependency) && priorInstances?.size &&
          (priorInstances.size > 1 || resolution(owner, name) !== dependency)) {
        throw new Error(`Cannot preserve peer instance for ${name}; refusing an incompatible Windows dependency layout`);
      }
      const scopes = [];
      for (let scope = owner; scope; scope = scope.parent) scopes.push(scope);
      const placements = [];
      let existing;
      for (const scope of scopes) {
        const key = join(scope.target, 'node_modules', name);
        const slot = slots.get(key);
        if (slot) { existing = slot; break; }
        placements.push(scope);
      }
      if (existing?.from === dependency) {
        edges.push({ owner, name, from: dependency });
        continue;
      }
      // A later sibling may need a different version. Do not hoist it into an
      // intermediate scope that would shadow a dependency already using root.
      const placement = placements.reverse().find(scope => {
        const target = join(scope.target, 'node_modules', name);
        return edges.every(edge => edge.name !== name || resolution(edge.owner, name, target, dependency) === edge.from);
      });
      if (!placement) throw new Error(`Conflicting staged dependency ${name} in ${owner.target}`);
      const target = join(placement.target, 'node_modules', name);
      const node = { from: dependency, target, parent: placement };
      slots.set(target, node);
      if (!instances.has(dependency)) instances.set(dependency, new Set());
      instances.get(dependency).add(target);
      edges.push({ owner, name, from: dependency });
      await mkdir(dirname(target), { recursive: true });
      await cp(dependency, target, { recursive: true, dereference: true, filter: copied(dependency, true) });
      queue.push(node);
    }
  }
}

/** The source file behind a workspace import: its export's `./dist/<x>.js` read back to `src/<x>.ts`, so a stale dist is never shipped. */
async function workspaceSource(specifier, root) {
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const target = metadata.exports?.[`.${specifier.slice(packageOf(specifier).length)}`]?.import;
  const match = typeof target === 'string' ? /^\.\/dist\/([\w/-]+)\.js$/.exec(target) : null;
  if (!match) throw new Error(`Cannot map ${specifier} to its TypeScript source`);
  const file = join(root, 'src', `${match[1]}.ts`);
  await access(file);
  return file;
}

/**
 * Decides, during bundling, what dist/cli.js imports at run time. The daemon's own bare imports stay external; our
 * workspace packages are bundled from source. A bare import inside bundled code stays external only when it is a
 * runtime dependency that resolves to the same directory the daemon ships; otherwise it is bundled too, so protocol's
 * zod 3 is never replaced by the daemon's zod 4.
 */
function runtimePlugin(runtime, decisions) {
  return {
    name: 'vonvon-runtime-imports',
    setup(esbuild) {
      const bundledRoots = [];
      const inBundled = file => bundledRoots.some(root => file === root || file.startsWith(root + sep));
      esbuild.onResolve({ filter: /^[^./]/ }, async args => {
        // `@/` is the daemon's tsconfig path alias, which esbuild resolves to source.
        if (args.kind === 'entry-point' || isBuiltin(args.path) || args.path.startsWith('node:') || args.path.startsWith('@/')) return undefined;
        const name = packageOf(args.path);
        const own = async () => realpath(await packageRoot(name, args.resolveDir));
        if (bundledWorkspaces.includes(name)) {
          const root = await own();
          bundledRoots.push(root);
          return { path: await workspaceSource(args.path, root) };
        }
        if (!inBundled(await realpath(args.importer))) return { path: args.path, external: true };
        const shipped = runtime.has(name) ? await realpath(await packageRoot(name, source)).catch(() => undefined) : undefined;
        const resolved = await own();
        if (shipped === resolved) return { path: args.path, external: true };
        bundledRoots.push(resolved);
        decisions.add(name);
        return undefined;
      });
    },
  };
}

export async function stageDaemon(destination, metadata, options = {}) {
  const withoutBundled = names => names?.filter(name => !bundledWorkspaces.includes(name));
  const dependencies = Object.fromEntries(Object.entries(metadata.dependencies ?? {}).filter(([name]) => !bundledWorkspaces.includes(name)));
  const runtimeMetadata = { ...metadata, dependencies, ...(metadata.bundleDependencies ? { bundleDependencies: withoutBundled(metadata.bundleDependencies) } : {}) };
  const runtime = new Set(Object.keys({ ...dependencies, ...runtimeMetadata.optionalDependencies }));
  const bundled = new Set();
  await mkdir(join(destination, 'dist'), { recursive: true });
  const supervisorHash = process.platform === 'win32' ? await buildWindowsSupervisor(join(destination, 'dist')) : undefined;
  const result = await build({
    absWorkingDir: source,
    entryPoints: ['src/cli/index.ts'],
    outfile: join(destination, 'dist/cli.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Source protection (devices 7.1); names stay, so error names and stack frames remain readable.
    minify: true,
    keepNames: true,
    sourcemap: false,
    metafile: true,
    plugins: [runtimePlugin(runtime, bundled)],
    define: {
      __VONVON_SUPERVISOR_SHA256__: supervisorHash ? JSON.stringify(supervisorHash) : 'undefined',
      __VONVON_ACCOUNT_API_ORIGIN__: JSON.stringify(process.env.VONVON_ACCOUNT_API_ORIGIN) ?? 'undefined',
    },
  });
  const external = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const item of output.imports) {
      if (!item.external || isBuiltin(item.path) || item.path.startsWith('node:')) continue;
      const name = packageOf(item.path);
      if (!runtime.has(name)) throw new Error(`dist/cli.js imports ${item.path}, which is not a runtime dependency of the staged daemon`);
      external.add(name);
    }
  }
  await cp(join(source, 'bin'), join(destination, 'bin'), { recursive: true });
  await writeFile(join(destination, 'package.json'), JSON.stringify(runtimeMetadata, null, 2) + '\n');
  for (const file of assets) await cp(join(source, file), join(destination, file));
  await stageDependencies(source, destination, { ...options, metadata: runtimeMetadata });
  return { external: [...external].sort(), bundled: [...bundled].sort() };
}
