import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { BridgeMoveAllocation } from '../src/import/bridge/journal';
import { MoveFileSafetyError, moveFileSafely, type MoveFileDeps, type MoveFileIntent } from '../src/import/bridge/move-file';

const roots: string[] = [];
const bytes = 'synthetic plist bytes\n';
const sha256 = createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(reverse = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'bridge-move-'));
  roots.push(root);
  const original = join(root, 'launch');
  const staging = join(root, 'stage');
  await mkdir(original); await mkdir(staging);
  const src = join(reverse ? staging : original, 'bridge.plist');
  const dst = join(reverse ? original : staging, 'bridge.plist');
  const txId = '11111111-1111-4111-8111-111111111111';
  const intent: MoveFileIntent = { src, dst, sha256, txId, operation: { sequence: 0,
    from: reverse ? 'stage' : 'original', to: reverse ? 'original' : 'stage', allocations: [] } };
  return { root, intent, temporary: join(reverse ? original : staging, `.bridge.plist.vonvon-${txId}.tmp`) };
}
const absent = async (path: string) => expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
function acrossDevices(src: string): MoveFileDeps {
  return { persistAllocation: async () => undefined, rename: async (from, to) => {
    if (from === src) throw Object.assign(new Error('injected cross-device'), { code: 'EXDEV' });
    await rename(from, to);
  } };
}

it.each([
  ['absent', 'absent', 'missing'],
  ['good', 'absent', 'moved'],
  ['absent', 'good', 'moved'],
  ['good', 'good', 'moved'],
  ['good', 'other', 'conflict'],
  ['other', 'good', 'conflict'],
  ['other', 'absent', 'conflict'],
  ['absent', 'other', 'conflict'],
])('real filesystem state table: %s -> %s = %s', async (source, destination, kind) => {
  const { intent } = await fixture();
  if (source !== 'absent') await writeFile(intent.src, source === 'good' ? bytes : 'FOREIGN-SOURCE');
  if (destination !== 'absent') await writeFile(intent.dst, destination === 'good' ? bytes : 'FOREIGN-DEST');
  const beforeSource = await readFile(intent.src).catch(() => undefined);
  const beforeDestination = await readFile(intent.dst).catch(() => undefined);
  expect(await moveFileSafely(intent)).toEqual({ kind });
  if (kind === 'moved') {
    await absent(intent.src);
    expect(await readFile(intent.dst, 'utf8')).toBe(bytes);
  } else {
    expect(await readFile(intent.src).catch(() => undefined)).toEqual(beforeSource);
    expect(await readFile(intent.dst).catch(() => undefined)).toEqual(beforeDestination);
  }
});

it.each([false, true])('EXDEV copies then publishes real bytes in reverse=%s', async reverse => {
  const { root, intent, temporary } = await fixture(reverse);
  await writeFile(intent.src, bytes);
  let copied = false;
  const deps = acrossDevices(intent.src);
  deps.copyToHandle = async (from, to) => {
    await to.writeFile(await from.readFile());
    expect(await readFile(intent.src, 'utf8')).toBe(bytes);
    expect(await to.stat()).toMatchObject({ size: Buffer.byteLength(bytes) });
    await absent(intent.dst);
    copied = true;
  };
  expect(await moveFileSafely(intent, deps)).toEqual({ kind: 'moved' });
  expect(copied).toBe(true);
  expect(await readFile(intent.dst, 'utf8')).toBe(bytes);
  await absent(intent.src); await absent(temporary);
  expect((await readdir(root)).sort()).toEqual(['launch', 'stage']);
});

it.each([false, true])('real publish interruption converges in reverse=%s', async reverse => {
  const { intent, temporary } = await fixture(reverse);
  await writeFile(intent.src, bytes);
  const crash = new Error('crash-after:exdev-publish');
  await expect(moveFileSafely(intent, {
    ...acrossDevices(intent.src),
    fault: point => { if (point === 'crash-after:exdev-publish') throw crash; },
  })).rejects.toBe(crash);
  expect(await readFile(intent.src, 'utf8')).toBe(bytes);
  expect(await readFile(intent.dst, 'utf8')).toBe(bytes);
  await absent(temporary);
  expect(await moveFileSafely(intent)).toEqual({ kind: 'moved' });
  await absent(intent.src);
  expect(await readFile(intent.dst, 'utf8')).toBe(bytes);
});

it('copy failure and failure after actual copy preserve source and no partial destination', async () => {
  const { intent, temporary } = await fixture();
  await writeFile(intent.src, bytes);
  const failed = new Error('copy fault');
  await expect(moveFileSafely(intent, {
    ...acrossDevices(intent.src), copyToHandle: async () => { throw failed; },
  })).rejects.toBe(failed);
  await absent(intent.dst); await absent(temporary);
  expect(await readdir(dirname(intent.dst))).toEqual([]);
  await expect(moveFileSafely(intent, {
    ...acrossDevices(intent.src), copyToHandle: async (from, to) => {
      await to.writeFile((await from.readFile()).subarray(0, 4)); throw failed;
    },
  })).rejects.toBe(failed);
  expect(await readFile(intent.src, 'utf8')).toBe(bytes);
  await absent(intent.dst); await absent(temporary);
  expect(await readdir(dirname(intent.dst))).toEqual([]);
});

it('unlink failure after publish leaves both originals for the next real recovery', async () => {
  const { intent } = await fixture();
  await writeFile(intent.src, bytes);
  await expect(moveFileSafely(intent, {
    ...acrossDevices(intent.src), unlink: async () => { throw new Error('unlink fault'); },
  })).rejects.toThrow('unlink fault');
  expect(await readFile(intent.src, 'utf8')).toBe(bytes);
  expect(await readFile(intent.dst, 'utf8')).toBe(bytes);
  expect(await moveFileSafely(intent)).toEqual({ kind: 'moved' });
  await absent(intent.src);
});

it('preserves foreign exact temporaries even when bytes match, and retains unrelated names', async () => {
  const { intent, temporary } = await fixture();
  const unrelated = `${temporary}-foreign`;
  await writeFile(intent.src, bytes); await writeFile(temporary, 'FOREIGN'); await writeFile(unrelated, 'OTHER');
  expect(await moveFileSafely(intent)).toEqual({ kind: 'conflict' });
  expect(await readFile(temporary, 'utf8')).toBe('FOREIGN');
  expect(await readFile(intent.src, 'utf8')).toBe(bytes);
  await writeFile(temporary, bytes);
  expect(await moveFileSafely(intent)).toEqual({ kind: 'conflict' });
  expect(await readFile(temporary, 'utf8')).toBe(bytes);
  expect(await readFile(intent.src, 'utf8')).toBe(bytes);
  expect(await readFile(unrelated, 'utf8')).toBe('OTHER');
});

it.each(['src', 'dst', 'temporary', 'ancestor', 'directory', 'fifo', 'hardlink'])('rejects unsafe %s without touching the referent', async kind => {
  const { root, intent, temporary } = await fixture();
  const protectedFile = join(root, 'protected'); await writeFile(protectedFile, bytes);
  await writeFile(intent.src, bytes);
  if (kind === 'ancestor') {
    await symlink(join(root, 'stage'), join(root, 'alias'));
    intent.dst = join(root, 'alias', 'bridge.plist');
  } else if (kind === 'directory') {
    await mkdir(intent.dst);
  } else if (kind === 'fifo') {
    execFileSync('mkfifo', [intent.dst]);
  } else if (kind === 'hardlink') {
    await link(protectedFile, intent.dst);
  } else {
    const path = kind === 'src' ? intent.src : kind === 'dst' ? intent.dst : temporary;
    if (kind === 'src') await rm(path);
    await symlink(protectedFile, path);
  }
  await expect(moveFileSafely(intent)).rejects.toThrow();
  expect(await readFile(protectedFile, 'utf8')).toBe(bytes);
  if (kind !== 'src') expect(await readFile(intent.src, 'utf8')).toBe(bytes);
});

it.each([
  { sha256: 'bad' }, { sha256: `${sha256}\n` }, { txId: '../foreign' },
  { txId: 'foreign\n' }, { src: 'relative' },
])('rejects malformed intent before writing: %j', async change => {
  const { intent } = await fixture();
  await writeFile(intent.src, bytes);
  await expect(moveFileSafely({ ...intent, ...change })).rejects.toBeInstanceOf(MoveFileSafetyError);
  expect(await readFile(intent.src, 'utf8')).toBe(bytes);
  await absent(intent.dst);
});

// Replacing a copied temporary is not ours to clean, even if the exact name is unchanged.
it('preserves a replacement inode when cleaning up a failed current copy', async () => {
  const { root, intent } = await fixture();
  let temporary = '';
  const foreign = join(root, 'foreign');
  await writeFile(intent.src, bytes); await writeFile(foreign, 'FOREIGN');
  await expect(moveFileSafely(intent, {
    ...acrossDevices(intent.src),
    persistAllocation: async allocation => { temporary = join(dirname(intent.dst),
      `.bridge.plist.vonvon-${intent.txId}-${allocation.sequence}-${allocation.nonce}.tmp`); },
    fault: async point => {
      if (point === 'after-copy') { await rename(foreign, temporary); throw new Error('fault'); }
    },
  })).rejects.toThrow('fault');
  expect(await readFile(temporary, 'utf8')).toBe('FOREIGN');
  expect(await readFile(intent.src, 'utf8')).toBe(bytes);
  await absent(intent.dst);
});

it.each([false, true])('accepts absent source parents with destination present=%s', async destinationPresent => {
  const { intent } = await fixture();
  await rmdir(dirname(intent.src));
  if (destinationPresent) await writeFile(intent.dst, bytes);
  else await rmdir(dirname(intent.dst));
  expect(await moveFileSafely(intent)).toEqual({ kind: destinationPresent ? 'moved' : 'missing' });
  await absent(dirname(intent.src));
  if (destinationPresent) expect(await readFile(intent.dst, 'utf8')).toBe(bytes);
  else await absent(dirname(intent.dst));
});

it('preserves unknown partial bytes without a durable allocation receipt', async () => {
  const { intent, temporary } = await fixture();
  await writeFile(intent.src, bytes); await writeFile(temporary, 'partial');
  expect(await moveFileSafely(intent)).toEqual({ kind: 'conflict' });
  expect(await readFile(intent.src, 'utf8')).toBe(bytes);
  expect(await readFile(temporary, 'utf8')).toBe('partial');
  await absent(intent.dst);
});

it.each([true, false])('rejects invalid allocation sequence/direction before reserving: %s', async badSequence => {
  const { intent } = await fixture(); await writeFile(intent.src, bytes);
  await expect(moveFileSafely({ ...intent, operation: { sequence: badSequence ? -1 : 0,
    from: 'original', to: badSequence ? 'stage' : 'original', allocations: [] } }, acrossDevices(intent.src))).rejects.toThrow();
  expect(await readFile(intent.src, 'utf8')).toBe(bytes);
  expect(await readdir(dirname(intent.dst))).toEqual([]);
});

it.each(['nonzero', 'foreign-inode', 'symlink', 'callback-replace'])('preserves unknown new receipt slots: %s', async kind => {
  const { root, intent } = await fixture(); await writeFile(intent.src, bytes);
  const parent = await lstat(dirname(intent.dst));
  const nonce = '22222222-2222-4222-8222-222222222222';
  const temporary = join(dirname(intent.dst), `.bridge.plist.vonvon-${intent.txId}-0-${nonce}.tmp`);
  const foreign = join(root, 'foreign'); await writeFile(foreign, 'FOREIGN', { mode: 0o600 });
  await writeFile(temporary, kind === 'nonzero' ? 'partial' : '', { mode: 0o600 });
  const metadata = await lstat(temporary);
  const allocation: BridgeMoveAllocation = { txId: intent.txId, sequence: 0, from: 'original', to: 'stage', sha256,
    parent: { dev: parent.dev, ino: parent.ino }, nonce,
    inode: kind === 'foreign-inode' ? { dev: metadata.dev, ino: metadata.ino } : null };
  if (kind === 'foreign-inode') await rename(foreign, temporary);
  if (kind === 'symlink') { await rm(temporary); await symlink(foreign, temporary); }
  const run = () => moveFileSafely({ ...intent, operation: { sequence: 0, from: 'original', to: 'stage', allocations: [allocation] } }, {
    persistAllocation: async () => { if (kind === 'callback-replace') await rename(foreign, temporary); },
  });
  if (kind === 'symlink') await expect(run()).rejects.toThrow();
  else expect(await run()).toEqual({ kind: 'conflict' });
  expect(await readFile(intent.src, 'utf8')).toBe(bytes); await absent(intent.dst);
  expect(await readFile(temporary, 'utf8')).toBe(kind === 'nonzero' ? 'partial' : 'FOREIGN');
  if (kind === 'symlink') expect((await lstat(temporary)).isSymbolicLink()).toBe(true);
});
