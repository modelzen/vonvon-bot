import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const requiredFiles = ['package.json', 'bin/vonvon.mjs', 'dist/cli.js', 'ui/dist/index.html', 'LICENSE.bridge', 'LICENSE.paseo', 'NOTICE', 'PROVENANCE.md', 'import-core.json'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const allowlist = JSON.parse(await readFile(fileURLToPath(new URL('./vonvon-bot-install-scripts.json', import.meta.url)), 'utf8'));

export async function listFiles(root, sub = '') {
  const result = [];
  for (const item of await readdir(join(root, sub), { withFileTypes: true })) {
    const relative = sub ? `${sub}/${item.name}` : item.name;
    const info = await lstat(join(root, relative));
    if (info.isSymbolicLink()) throw new Error(`symlink refused: ${relative}`);
    if (info.isDirectory()) result.push(...await listFiles(root, relative));
    else if (info.isFile()) result.push(relative);
    else throw new Error(`non-file refused: ${relative}`);
  }
  return result.sort();
}

export async function fileEntries(root) {
  return Promise.all((await listFiles(root)).filter(path => path !== 'build-manifest.json').map(async path => ({
    path,
    sha256: sha256(await readFile(join(root, path))),
    mode: ((await lstat(join(root, path))).mode & 0o777).toString(8).padStart(3, '0'),
  })));
}

function packageName(path) {
  const parts = path.split('/');
  return parts[parts.length - 1] === 'package.json' ? parts.slice(0, -1).join('/') : path;
}

export async function validateTree(root, lock) {
  const files = await listFiles(root);
  for (const required of requiredFiles) if (!files.includes(required)) throw new Error(`missing file: ${required}`);
  for (const path of files) if (path.endsWith('.node')) throw new Error(`native module refused: ${path}`);
  for (const path of files.filter(path => path === 'package.json' || path.endsWith('/package.json'))) {
    const metadata = JSON.parse(await readFile(join(root, path), 'utf8'));
    if (['os', 'cpu', 'gypfile'].some(field => field in metadata)) throw new Error(`platform metadata refused: ${path}`);
    const directory = packageName(path);
    for (const [name, range] of Object.entries(metadata.dependencies ?? {})) {
      let current = directory;
      let found = false;
      while (true) {
        const candidate = posix.join(current, 'node_modules', name, 'package.json');
        if (files.includes(candidate)) { found = true; break; }
        if (!current) break;
        current = posix.dirname(current);
        if (current === '.') current = '';
      }
      if (!found) throw new Error(`dependency ${name}@${range} unresolved from ${path}`);
    }
    for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
      const script = metadata.scripts?.[lifecycle];
      if (script === undefined) continue;
      const match = allowlist.find(item => {
        const record = lock?.packages?.[item.lockPath];
        return item.name === metadata.name && item.version === metadata.version && item.lifecycle === lifecycle && item.script === script
          && (!lock || (item.lockPath.endsWith(`node_modules/${item.name}`) && record?.version === item.version
            && (record.name === undefined || record.name === item.name) && record.integrity === item.integrity));
      });
      if (!match) throw new Error(`install script refused: ${path} ${lifecycle}`);
      for (const [file, hash] of Object.entries(match.files)) {
        const target = posix.join(directory, file);
        if (!files.includes(target) || sha256(await readFile(join(root, target))) !== hash) throw new Error(`install script hash mismatch: ${target}`);
      }
    }
  }
  return files;
}

export async function validateManifest(root, manifest, head) {
  if (manifest.schema !== 1 || manifest.sourceHead !== head) throw new Error('manifest schema or head mismatch');
  const version = /^(?:v)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (typeof manifest.lockfileSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.lockfileSha256)
    || ['node', 'npm', 'esbuild'].some(field => typeof manifest[field] !== 'string' || !version.test(manifest[field]))) throw new Error('manifest provenance metadata mismatch');
  const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  if (!nonempty(packageMetadata.engines?.node) || !nonempty(packageMetadata.license) || !nonempty(packageMetadata.author)) throw new Error('package metadata mismatch');
  if (manifest.package !== 'vonvon-bot' || manifest.version !== packageMetadata.version || packageMetadata.name !== 'vonvon-bot' || packageMetadata.type !== 'module' || packageMetadata.private !== undefined || packageMetadata.scripts !== undefined || packageMetadata.devDependencies !== undefined || JSON.stringify(packageMetadata.bin) !== JSON.stringify({ vonvon: 'bin/vonvon.mjs' }) || JSON.stringify(packageMetadata.bundleDependencies) !== JSON.stringify(Object.keys(packageMetadata.dependencies ?? {}))) throw new Error('package metadata mismatch');
  await validateTree(root);
  const actual = await fileEntries(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('manifest file hash, mode, or inventory mismatch');
  return { package: manifest.package, version: manifest.version, sourceHead: head, files: actual.length };
}
