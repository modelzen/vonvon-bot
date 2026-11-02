import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type Tools = {
  writeTarGz: (root: string, entries: Array<{ path: string; mode: string }>, out: string, mtime: number) => Promise<void>;
  writeZip: (root: string, entries: Array<{ path: string; mode: string }>, out: string, mtime: number) => Promise<void>;
  tarHeader: (path: string, size: number, mode: number, mtime: number) => Buffer;
};
/** scripts/build-server.mjs, the writer the real packages come from. */
export const buildTools = async (): Promise<Tools> => await import(new URL('../../../../scripts/build-server.mjs', import.meta.url).href) as Tools;

/** A minimal release tree under `parent`: what the update checks for, and a Node that is a shell script. */
export async function releaseTree(parent: string, version: string, files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(parent, `tree-${version}-`));
  const tree: Record<string, string> = {
    'standalone.json': JSON.stringify({ v: 1, version }),
    'app/package.json': JSON.stringify({ name: '@vonvon/daemon', version }),
    'app/bin/vonvon.mjs': 'export {};\n',
    'node/bin/node': '#!/bin/sh\nexit 0\n',
    'node/node.exe': 'MZ',
    ...files,
  };
  for (const [path, content] of Object.entries(tree)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await chmod(join(root, 'node/bin/node'), 0o755);
  return root;
}

/** Packs `version` as tar.gz (or zip) under `parent`; returns the archive with its bytes, sha512 and size. */
export async function packRelease(parent: string, version: string, zip = false): Promise<{ root: string; archive: string; bytes: Buffer; sha512: string; size: number }> {
  const tools = await buildTools();
  const root = await releaseTree(parent, version);
  const entries = ['app/bin/vonvon.mjs', 'app/package.json', 'node/bin/node', 'node/node.exe', 'standalone.json']
    .map(path => ({ path, mode: path === 'node/bin/node' ? '755' : '644' }));
  const archive = `${root}.${zip ? 'zip' : 'tar.gz'}`;
  await (zip ? tools.writeZip : tools.writeTarGz)(root, entries, archive, 1_700_000_000);
  const bytes = await readFile(archive);
  return { root, archive, bytes, sha512: createHash('sha512').update(bytes).digest('hex'), size: bytes.length };
}
