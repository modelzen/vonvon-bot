import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sdkName = '@anthropic-ai/claude-agent-sdk';
const arches = ['arm64', 'x64'];
const packageName = arch => `${sdkName}-darwin-${arch}`;
const nativeRelative = arch => join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${arch}`);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function defaultExtract(archive, destination) {
  await exec('tar', ['-xzf', archive, '-C', destination], { timeout: 120_000 });
}
async function defaultInspectBinary(binary) {
  const { stdout } = await exec('/usr/bin/lipo', ['-archs', binary], { timeout: 30_000 });
  return stdout.trim();
}

async function validateNative(directory, arch, version, inspectBinary) {
  const metadata = await readJson(join(directory, 'package.json'));
  if (metadata.name !== packageName(arch) || metadata.version !== version) {
    throw new Error(`Claude ${arch} native package name/version does not match SDK ${version}`);
  }
  const binary = join(directory, 'claude');
  const stat = await lstat(binary);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Claude ${arch} native binary is missing or invalid`);
  const actual = (await inspectBinary(binary)).trim();
  const expected = arch === 'x64' ? 'x86_64' : 'arm64';
  if (actual !== expected) throw new Error(`Claude ${arch} native binary has wrong architecture: ${actual}`);
}

function lockedNative(lock, arch, version) {
  const name = packageName(arch);
  const record = lock.packages?.[`node_modules/${name}`];
  const url = record?.resolved && new URL(record.resolved);
  if (record?.version !== version || !url || url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org'
    || url.username || url.password || url.hash || url.search
    || !url.pathname.endsWith(`/${name.split('/')[1]}-${version}.tgz`)
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity ?? '')) {
    throw new Error(`Missing or invalid locked Claude ${arch} native package ${version}`);
  }
  return record;
}

/** Fill both optional native SDK packages before electron-builder creates its two architecture copies. */
export async function stageClaudeUniversal({ stage, root, lockFile = join(root, 'package-lock.json'), fetcher = fetch,
  extract = defaultExtract, inspectBinary = defaultInspectBinary } = {}) {
  const sdk = join(stage, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  const sdkMetadata = await readJson(join(sdk, 'package.json'));
  if (sdkMetadata.name !== sdkName || !/^\d+\.\d+\.\d+$/.test(sdkMetadata.version ?? '')) {
    throw new Error('Staged Claude SDK is missing or has an invalid version');
  }
  const lock = await readJson(lockFile);
  for (const arch of arches) {
    const record = lockedNative(lock, arch, sdkMetadata.version);
    if (sdkMetadata.optionalDependencies?.[packageName(arch)] !== sdkMetadata.version) {
      throw new Error(`Staged Claude SDK does not declare matching ${arch} native package`);
    }
    const target = join(stage, nativeRelative(arch));
    if (await exists(target)) {
      await validateNative(target, arch, sdkMetadata.version, inspectBinary);
      continue;
    }
    const candidates = [
      join(root, 'packages/daemon', nativeRelative(arch)),
      join(root, 'packages/daemon/node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${arch}`),
      join(root, 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${arch}`),
    ];
    let source;
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        await validateNative(candidate, arch, sdkMetadata.version, inspectBinary);
        source = candidate;
        break;
      }
    }
    let temporary;
    try {
      if (!source) {
        temporary = await mkdtemp(join(tmpdir(), `vonvon-claude-${arch}-`));
        const response = await fetcher(record.resolved, { redirect: 'error' });
        if (!response.ok) throw new Error(`Unable to fetch locked Claude ${arch} native package (${response.status})`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const actual = createHash('sha512').update(bytes).digest('base64');
        if (`sha512-${actual}` !== record.integrity) throw new Error(`Claude ${arch} native package integrity mismatch`);
        const archive = join(temporary, 'package.tgz');
        await writeFile(archive, bytes);
        await extract(archive, temporary);
        source = join(temporary, 'package');
        await validateNative(source, arch, sdkMetadata.version, inspectBinary);
      }
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, dereference: true });
      await validateNative(target, arch, sdkMetadata.version, inspectBinary);
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
}
