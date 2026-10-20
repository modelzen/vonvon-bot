import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const metadata = async (root, path) => JSON.parse(await readFile(join(root, path), 'utf8'));

/** The Core release version is the product version; protocol/client versions are independent. */
export async function productVersion(root = repositoryRoot) {
  const daemon = await metadata(root, 'packages/daemon/package.json');
  if (!/^\d+\.\d+\.\d+$/.test(daemon.version)) throw new Error('Product version must be a three-part release version');
  return daemon.version;
}

export async function checkedProductVersion(root = repositoryRoot) {
  const version = await productVersion(root);
  const desktop = await metadata(root, 'packages/desktop/package.json');
  if (desktop.version !== version) throw new Error('Desktop/Core version mismatch; run npm run version:sync');
  return version;
}

export async function syncProductVersion(root = repositoryRoot) {
  const version = await productVersion(root);
  for (const file of ['packages/desktop/package.json', 'package-lock.json']) {
    const path = join(root, file);
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (file === 'package-lock.json') value.packages['packages/desktop'].version = version;
    else value.version = version;
    await writeFile(path, JSON.stringify(value, null, 2) + '\n');
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await syncProductVersion();
