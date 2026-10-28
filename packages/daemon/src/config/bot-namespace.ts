import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path';
import { z } from 'zod';
import { admitNamespaceReservation } from './directories';

export const ObjectSchema = z.strictObject({ dev: z.string().regex(/^(0|[1-9]\d*)$/), ino: z.string().regex(/^(0|[1-9]\d*)$/) });
const PathSchema = z.string().min(1).refine(value => isAbsolute(value) && !value.includes('\0'));
export const SafeAppIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const directoryFields = { parent: PathSchema, namespaceRoot: PathSchema, parentIdentity: ObjectSchema };
export const DirectoryClaimSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...directoryFields, state: z.literal('reserved') }),
  z.strictObject({ ...directoryFields, state: z.literal('ready'), object: ObjectSchema }),
]);
export type DirectoryClaim = z.infer<typeof DirectoryClaimSchema>;
const fields = {
  version: z.literal(1), appId: SafeAppIdSchema, tenant: z.enum(['feishu', 'lark']),
  handle: z.string().min(1).max(128).regex(/^[a-z0-9一-龥][a-z0-9一-龥-]*$/), ...directoryFields,
};
export const AllocationSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...fields, state: z.literal('reserved') }),
  z.strictObject({ ...fields, state: z.literal('ready'), object: ObjectSchema }),
]);
export type Allocation = z.infer<typeof AllocationSchema>;
export type ObjectIdentity = z.infer<typeof ObjectSchema>;

export function parseAllocations(raw: unknown): Record<string, Allocation> | undefined {
  if (raw === undefined) return undefined;
  const parsed = z.record(z.string(), AllocationSchema).safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data).length > 4096) throw new Error('Invalid bot allocation ledger');
  const handles = new Set<string>();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key !== value.appId || dirname(value.namespaceRoot) !== value.parent || handles.has(value.handle)) {
      throw new Error('Invalid bot allocation ledger');
    }
    handles.add(value.handle);
  }
  return parsed.data;
}

export async function syncDirectory(path: string): Promise<void> {
  // Node cannot fsync directories on Windows. Individual files are still synced before rename.
  if (process.platform === 'win32') return;
  const file = await open(path, 'r');
  let failed = false;
  try { await file.sync(); }
  catch (error) { failed = true; throw error; }
  finally { try { await file.close(); } catch (error) { if (!failed) throw error; } }
}

/**
 * Creates the missing tail of `path`. Top-level system directories are never created or inferred from a failed attempt.
 * Only a directory made here, and the parent it was made in, are synced (s36c2d): an existing ancestor can be
 * execute-only (a 0711 `/home`), and syncing it again makes nothing more durable.
 */
export async function ensureDurableDirectory(path: string, validate?: () => Promise<void>): Promise<void> {
  const absolute = await prospectiveCanonical(path);
  const root = parse(absolute).root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  const [anchor, ...descendants] = components;
  if (anchor === undefined) return;
  let cursor = join(root, anchor);
  await directoryIdentity(cursor);
  for (const component of descendants) {
    await validate?.();
    const parent = cursor;
    cursor = join(parent, component);
    let created = false;
    try { await lstat(cursor); }
    catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      try { await mkdir(cursor, { mode: 0o700 }); created = true; }
      catch (mkdirError) { if (!hasCode(mkdirError, 'EEXIST')) throw mkdirError; }
    }
    await directoryIdentity(cursor);
    if (await realpath(cursor) !== cursor) throw new Error('Directory changed during allocation');
    if (created) { await syncDirectory(cursor); await syncDirectory(parent); }
  }
  await validate?.();
}

async function prospectiveCanonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    try { await lstat(path); throw new Error('Invalid directory ancestor'); }
    catch (entryError) { if (!hasCode(entryError, 'ENOENT')) throw entryError; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await prospectiveCanonical(parent), basename(path));
  }
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
export async function directoryIdentity(path: string): Promise<ObjectIdentity> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid namespace directory');
  return { dev: entry.dev.toString(), ino: entry.ino.toString() };
}
export function sameObject(a: ObjectIdentity, b: ObjectIdentity): boolean { return a.dev === b.dev && a.ino === b.ino; }
const folded = (name: string): string => name.normalize('NFKC').toLowerCase();
function componentFor(handle: string): string {
  let value = handle.normalize('NFC').replace(/[\/\\\x00-\x1f\x7f]/g, '-').replace(/^\.+$/, '').trim() || 'bot';
  while (Buffer.byteLength(value) > 120) value = Array.from(value).slice(0, -1).join('');
  return value;
}

export async function planAllocation(input: { appId: string; tenant: 'feishu' | 'lark'; handle: string; parent: string; dataDir: string }, allocations: Record<string, Allocation>): Promise<Allocation> {
  return { version: 1, appId: input.appId, tenant: input.tenant, handle: input.handle,
    ...await planDirectory({ name: input.handle, parent: input.parent, dataDir: input.dataDir, selection: { kind: 'unique', key: input.appId } }, Object.values(allocations)) };
}

export async function planDirectory(input: { name: string; parent: string; dataDir: string; selection: { kind: 'fixed' } | { kind: 'unique'; key: string } }, claims: readonly DirectoryClaim[]): Promise<Extract<DirectoryClaim, { state: 'reserved' }>> {
  const base = componentFor(input.name);
  const admitted = await admitNamespaceReservation({ parent: input.parent, component: base }, { dataDir: input.dataDir });
  const validate = async (): Promise<void> => {
    const checked = await admitNamespaceReservation({ parent: admitted.parent, component: base }, { dataDir: input.dataDir });
    if (checked.parent !== admitted.parent) throw new Error('Namespace parent changed');
  };
  await ensureDurableDirectory(admitted.parent, validate);
  const occupied = new Set((await readdir(admitted.parent)).map(folded));
  for (const claim of claims) if (claim.parent === admitted.parent) occupied.add(folded(basename(claim.namespaceRoot)));
  const suffix = input.selection.kind === 'unique' ? createHash('sha256').update(input.selection.key).digest('hex').slice(0, 8) : '';
  for (let count = 0; count < (input.selection.kind === 'fixed' ? 1 : 4096); count++) {
    const component = count === 0 ? base : `${base}-${suffix}${count === 1 ? '' : `-${count}`}`;
    if (occupied.has(folded(component))) continue;
    return { state: 'reserved',
      parent: admitted.parent, namespaceRoot: join(admitted.parent, component), parentIdentity: await directoryIdentity(admitted.parent) };
  }
  throw new Error('Namespace collision limit reached');
}

async function validateParent(record: DirectoryClaim, dataDir: string): Promise<void> {
  // A parent replaced by a link says so before the admission follows it somewhere else (s36c2d review).
  await directoryIdentity(record.parent);
  const admitted = await admitNamespaceReservation({ parent: record.parent, component: basename(record.namespaceRoot) }, { dataDir });
  if (admitted.parent !== record.parent || admitted.path !== record.namespaceRoot
    || !sameObject(await directoryIdentity(record.parent), record.parentIdentity)) throw new Error('Namespace parent changed');
}
export async function materializeAllocation(record: Allocation, dataDir: string): Promise<Extract<Allocation, { state: 'ready' }>> {
  return { ...record, ...await materializeDirectory(record, dataDir) };
}
/**
 * The directory of a record, made on first use. A ready one that is gone is made again once its parent checks out
 * (s36c2d): nothing is in it to take over. One that is there with another inode refuses: a migration or a restore
 * from backup, which `vonvon bot repair-dir` records again ({@link recordCurrent}).
 */
export async function materializeDirectory(record: DirectoryClaim, dataDir: string): Promise<Extract<DirectoryClaim, { state: 'ready' }>> {
  await validateParent(record, dataDir);
  let entry: Stats | undefined;
  try { entry = await lstat(record.namespaceRoot); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  if (!entry) {
    await mkdir(record.namespaceRoot, { mode: 0o700 });
    await syncDirectory(record.namespaceRoot);
    await syncDirectory(record.parent);
    await validateParent(record, dataDir);
    const canonical = await realpath(record.namespaceRoot);
    const admitted = await admitNamespaceReservation({ parent: record.parent, component: basename(canonical) }, { dataDir });
    if (admitted.path !== canonical) throw new Error('Namespace path changed');
    return { ...record, state: 'ready', namespaceRoot: canonical, object: await directoryIdentity(canonical) };
  }
  if (record.state === 'reserved') throw new Error('Reserved namespace already exists; recovery requires operator review');
  // A link in its place, even a dangling one, is a link, not a missing directory (s36c2d review).
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Invalid namespace directory');
  await verifyDirectory(record, dataDir);
  return record;
}
/** A ready record still names the directory it made, under the same parent. Nothing is made or changed. */
export async function verifyDirectory(record: Extract<DirectoryClaim, { state: 'ready' }>, dataDir: string): Promise<void> {
  if (await realpath(record.namespaceRoot) !== record.namespaceRoot
    || !sameObject(await directoryIdentity(record.namespaceRoot), record.object)) throw new Error('Namespace directory changed');
  await validateParent(record, dataDir);
}

/**
 * Make a deleted projects root (a bot allocation's parent) again, one level only, and only on the device it was on:
 * its own parent must be there, on the device the root was recorded on (s36c2d). A root that was a volume's mount
 * point, or in a volume whose mount point's folder is left behind, is on another device than that folder, so an
 * unplugged volume is never made on the disk below. Undefined when the root is there.
 */
export async function restoreParent(record: DirectoryClaim, dataDir: string): Promise<ObjectIdentity | undefined> {
  try { await lstat(record.parent); return undefined; }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  if ((await directoryIdentity(dirname(record.parent))).dev !== record.parentIdentity.dev) throw new Error('Namespace volume missing');
  await mkdir(record.parent, { mode: 0o700 });
  if (await realpath(record.parent) !== record.parent) throw new Error('Namespace parent changed');
  const admitted = await admitNamespaceReservation({ parent: record.parent, component: basename(record.namespaceRoot) }, { dataDir });
  if (admitted.parent !== record.parent || admitted.path !== record.namespaceRoot) throw new Error('Namespace parent changed');
  await syncDirectory(record.parent);
  await syncDirectory(dirname(record.parent));
  return directoryIdentity(record.parent);
}

/**
 * `vonvon bot repair-dir`: take the directory at the recorded path as this record's, under `parentIdentity`, after a
 * migration or a restore changed the inodes (s36c2d). The path itself must not have changed. A reserved record whose
 * directory is there becomes ready: the owner ran this after looking. A missing one keeps its record and is made on use.
 */
export async function recordCurrent<T extends DirectoryClaim>(record: T, parentIdentity: ObjectIdentity, dataDir: string): Promise<{ record: T; present: boolean }> {
  const admitted = await admitNamespaceReservation({ parent: record.parent, component: basename(record.namespaceRoot) }, { dataDir });
  if (admitted.parent !== record.parent || admitted.path !== record.namespaceRoot) throw new Error('Namespace path changed');
  try { await lstat(record.namespaceRoot); }
  catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    return { record: { ...record, parentIdentity }, present: false };
  }
  if (await realpath(record.namespaceRoot) !== record.namespaceRoot) throw new Error('Namespace path changed');
  return { record: { ...record, parentIdentity, state: 'ready', object: await directoryIdentity(record.namespaceRoot) }, present: true };
}
