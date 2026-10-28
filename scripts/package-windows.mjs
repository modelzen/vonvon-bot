import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkedProductVersion, repositoryRoot } from './product-version.mjs';

const releaseName = version => `Vonvon-Bot-${version}-windows-x64`;
const installerName = version => `Vonvon-Bot-Setup-${version}-x64.exe`;

export function peMachine(bytes) {
  if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Missing PE DOS header');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') {
    throw new Error('Missing PE signature');
  }
  return bytes.readUInt16LE(offset + 4);
}

function metadataField(yaml, key) {
  const matches = [...yaml.matchAll(new RegExp(`^${key}:\\s*([^\\r\\n]+)\\s*$`, 'gm'))];
  if (matches.length !== 1) throw new Error(`Expected one ${key} in latest.yml`);
  return matches[0][1].trim().replace(/^['"]|['"]$/g, '');
}

export function verifyLatestYml(yaml, { version, installerName, installerSize, installerSha512 }) {
  if (metadataField(yaml, 'version') !== version) throw new Error('latest.yml version mismatch');
  if (metadataField(yaml, 'path') !== installerName) throw new Error('latest.yml installer path mismatch');
  if (metadataField(yaml, 'sha512') !== installerSha512) throw new Error('latest.yml installer digest mismatch');
  const urls = [...yaml.matchAll(/^\s+- url:\s*([^\r\n]+)\s*$/gm)];
  if (urls.length !== 1 || urls[0][1].trim().replace(/^['"]|['"]$/g, '') !== installerName) {
    throw new Error('latest.yml files must contain exactly the installer');
  }
  const fileMetadata = yaml.slice(urls[0].index + urls[0][0].length).split(/\r?\n(?=\s*- url:|\w+:)/, 1)[0];
  const sha = fileMetadata.match(/^\s+sha512:\s*([^\r\n]+)\s*$/m)?.[1]?.trim();
  const size = fileMetadata.match(/^\s+size:\s*(\d+)\s*$/m)?.[1];
  if (sha !== installerSha512 || Number(size) !== installerSize) throw new Error('latest.yml file metadata mismatch');
}

export function validateWindowsInventory(inventory, { version, sourceSha } = {}) {
  if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory)) throw new Error('Invalid Windows inventory');
  if (!/^\d+\.\d+\.\d+$/.test(inventory.version) || (version && inventory.version !== version)) throw new Error('Inventory version mismatch');
  if (!/^[0-9a-f]{40}$/i.test(inventory.sourceSha) || /^0+$/.test(inventory.sourceSha) ||
      (sourceSha && inventory.sourceSha.toLowerCase() !== sourceSha.toLowerCase())) throw new Error('Inventory source SHA mismatch');
  if (inventory.architecture !== 'x64' || inventory.signed !== false || inventory.updatesEnabled !== false) throw new Error('Inventory must describe an unsigned x64 build with updates disabled');
  const base = releaseName(inventory.version);
  const expected = [
    ['installer', installerName(inventory.version)], ['zip', `${base}.zip`],
    ['blockmap', `${installerName(inventory.version)}.blockmap`], ['feed', 'latest.yml'],
  ];
  if (!Array.isArray(inventory.artifacts) || inventory.artifacts.length !== expected.length) throw new Error('Incomplete Windows artifact inventory');
  for (const [index, [kind, file]] of expected.entries()) {
    const artifact = inventory.artifacts[index];
    if (artifact?.kind !== kind || artifact.file !== file || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 ||
        !/^[0-9a-f]{64}$/.test(artifact.sha256) || !/^[A-Za-z0-9+/]{86}==$/.test(artifact.sha512)) {
      throw new Error(`Invalid Windows artifact evidence: ${kind}`);
    }
  }
  return inventory;
}

export async function verifyWindowsArtifacts(out, { version, sourceSha } = {}) {
  const inventory = validateWindowsInventory(JSON.parse(await readFile(join(out, 'windows-release-inventory.json'), 'utf8')), { version, sourceSha });
  for (const artifact of inventory.artifacts) {
    const actual = await fileEvidence(join(out, artifact.file));
    if (JSON.stringify(actual) !== JSON.stringify({ file: artifact.file, bytes: artifact.bytes, sha256: artifact.sha256, sha512: artifact.sha512 })) {
      throw new Error(`Artifact content mismatch: ${artifact.file}`);
    }
  }
  const installer = inventory.artifacts[0];
  verifyLatestYml(await readFile(join(out, 'latest.yml'), 'utf8'), {
    version: inventory.version, installerName: installer.file, installerSize: installer.bytes, installerSha512: installer.sha512,
  });
  peMachine(await readFile(join(out, installer.file)));
  return inventory;
}

async function fileEvidence(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`Missing or invalid release file: ${path}`);
  const bytes = await readFile(path);
  return {
    file: basename(path), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha512: createHash('sha512').update(bytes).digest('base64'),
  };
}

export async function createWindowsInventory({ out, version, sourceSha, unpackedExe, zipExe }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
  if (!/^[0-9a-f]{40}$/i.test(sourceSha) || /^0+$/.test(sourceSha)) throw new Error('Invalid source SHA');
  const base = releaseName(version);
  const names = { installer: installerName(version), zip: `${base}.zip`, blockmap: `${installerName(version)}.blockmap`, feed: 'latest.yml' };
  const artifacts = [];
  for (const [kind, name] of Object.entries(names)) artifacts.push({ kind, ...await fileEvidence(join(out, name)) });
  const installerEvidence = artifacts.find(artifact => artifact.kind === 'installer');
  const [unpacked, zipped, installer, yaml] = await Promise.all([
    readFile(unpackedExe), readFile(zipExe), readFile(join(out, names.installer)), readFile(join(out, names.feed), 'utf8'),
  ]);
  if (peMachine(unpacked) !== 0x8664 || peMachine(zipped) !== 0x8664) {
    throw new Error('Packaged application PE architecture is not x64');
  }
  peMachine(installer); // NSIS bootstrapper may be x86; the application payload must be x64.
  verifyLatestYml(yaml, {
    version, installerName: names.installer, installerSize: installerEvidence.bytes,
    installerSha512: installerEvidence.sha512,
  });
  const inventory = { sourceSha: sourceSha.toLowerCase(), version, architecture: 'x64', signed: false, updatesEnabled: false, artifacts };
  validateWindowsInventory(inventory, { version, sourceSha });
  await writeFile(join(out, 'windows-release-inventory.json'), JSON.stringify(inventory, null, 2) + '\n', { flag: 'wx' });
  return inventory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out, sourceSha, unpackedExe, zipExe] = process.argv.slice(2);
  if ([out, sourceSha, unpackedExe, zipExe].some(value => !value)) throw new Error('Usage: node scripts/package-windows.mjs <output-dir> <source-sha> <unpacked-exe> <zip-exe>');
  const version = await checkedProductVersion(repositoryRoot);
  const inventory = await createWindowsInventory({ out, version, sourceSha, unpackedExe, zipExe });
  process.stdout.write(`Verified ${inventory.artifacts.length} Windows release files for ${version} at ${inventory.sourceSha}\n`);
}
