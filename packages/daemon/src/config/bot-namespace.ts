import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path';
import { z } from 'zod';
import { admitNamespaceReservation } from './directories';

const ObjectSchema = z.strictObject({ dev: z.string().regex(/^(0|[1-9]\d*)$/), ino: z.string().regex(/^(0|[1-9]\d*)$/) });
const PathSchema = z.string().min(1).refine(value => isAbsolute(value) && !value.includes('\0'));
export const SafeAppIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const fields = {
  version: z.literal(1), appId: SafeAppIdSchema, tenant: z.enum(['feishu', 'lark']),
  handle: z.string().min(1).max(128).regex(/^[a-z0-9一-龥][a-z0-9一-龥-]*$/), parent: PathSchema, namespaceRoot: PathSchema, parentIdentity: ObjectSchema,
};
export const AllocationSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...fields, state: z.literal('reserved') }),
  z.strictObject({ ...fields, state: z.literal('ready'), object: ObjectSchema }),
]);
export type Allocation = z.infer<typeof AllocationSchema>;
type ObjectIdentity = z.infer<typeof ObjectSchema>;

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
  const file = await open(path, 'r');
  let failed = false;
  try { await file.sync(); }
  catch (error) { failed = true; throw error; }
  finally { try { await file.close(); } catch (error) { if (!failed) throw error; } }
}

/** Top-level system directories are never created or inferred from a failed attempt. */
export async function ensureDurableDirectory(path: string, validate?: () => Promise<void>): Promise<void> {
  const absolute = await prospectiveCanonical(path);
  const root = parse(absolute).root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  const [anchor, ...descendants] = components;
  if (anchor === undefined) { await syncDirectory(root); return; }
  let cursor = join(root, anchor);
  await directoryIdentity(cursor);
  await syncDirectory(cursor);
  for (const component of descendants) {
    await validate?.();
    const parent = cursor;
    cursor = join(parent, component);
    try { await mkdir(cursor, { mode: 0o700 }); }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    await directoryIdentity(cursor);
    if (await realpath(cursor) !== cursor) throw new Error('Directory changed during allocation');
    await syncDirectory(cursor);
    await syncDirectory(parent);
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
async function directoryIdentity(path: string): Promise<ObjectIdentity> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid namespace directory');
  return { dev: entry.dev.toString(), ino: entry.ino.toString() };
}
function sameObject(a: ObjectIdentity, b: ObjectIdentity): boolean { return a.dev === b.dev && a.ino === b.ino; }
const folded = (name: string): string => name.normalize('NFKC').toLowerCase();
function componentFor(handle: string): string {
  let value = handle.normalize('NFC').replace(/[\/\\\x00-\x1f\x7f]/g, '-').replace(/^\.+$/, '').trim() || 'bot';
  while (Buffer.byteLength(value) > 120) value = Array.from(value).slice(0, -1).join('');
  return value;
}

export async function planAllocation(input: { appId: string; tenant: 'feishu' | 'lark'; handle: string; parent: string; dataDir: string }, allocations: Record<string, Allocation>): Promise<Allocation> {
  const base = componentFor(input.handle);
  const admitted = await admitNamespaceReservation({ parent: input.parent, component: base }, { dataDir: input.dataDir });
  const validate = async (): Promise<void> => {
    const checked = await admitNamespaceReservation({ parent: admitted.parent, component: base }, { dataDir: input.dataDir });
    if (checked.parent !== admitted.parent) throw new Error('Namespace parent changed');
  };
  await ensureDurableDirectory(admitted.parent, validate);
  const occupied = new Set((await readdir(admitted.parent)).map(folded));
  for (const claim of Object.values(allocations)) if (claim.parent === admitted.parent) occupied.add(folded(basename(claim.namespaceRoot)));
  const suffix = createHash('sha256').update(input.appId).digest('hex').slice(0, 8);
  for (let count = 0; count < 4096; count++) {
    const component = count === 0 ? base : `${base}-${suffix}${count === 1 ? '' : `-${count}`}`;
    if (occupied.has(folded(component))) continue;
    return { version: 1, appId: input.appId, tenant: input.tenant, handle: input.handle, state: 'reserved',
      parent: admitted.parent, namespaceRoot: join(admitted.parent, component), parentIdentity: await directoryIdentity(admitted.parent) };
  }
  throw new Error('Namespace collision limit reached');
}

async function validateParent(record: Allocation, dataDir: string): Promise<void> {
  const admitted = await admitNamespaceReservation({ parent: record.parent, component: basename(record.namespaceRoot) }, { dataDir });
  if (admitted.parent !== record.parent || admitted.path !== record.namespaceRoot
    || !sameObject(await directoryIdentity(record.parent), record.parentIdentity)) throw new Error('Namespace parent changed');
}
export async function materializeAllocation(record: Allocation, dataDir: string): Promise<Allocation> {
  await validateParent(record, dataDir);
  await ensureDurableDirectory(record.parent, () => validateParent(record, dataDir));
  if (record.state === 'reserved') {
    try { await lstat(record.namespaceRoot); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error;
      await mkdir(record.namespaceRoot, { mode: 0o700 });
      await syncDirectory(record.namespaceRoot);
      await ensureDurableDirectory(record.parent, () => validateParent(record, dataDir));
      await validateParent(record, dataDir);
      const canonical = await realpath(record.namespaceRoot);
      const admitted = await admitNamespaceReservation({ parent: record.parent, component: basename(canonical) }, { dataDir });
      if (admitted.path !== canonical) throw new Error('Namespace path changed');
      return { ...record, state: 'ready', namespaceRoot: canonical, object: await directoryIdentity(canonical) };
    }
    throw new Error('Reserved namespace already exists; recovery requires operator review');
  }
  if (await realpath(record.namespaceRoot) !== record.namespaceRoot
    || !sameObject(await directoryIdentity(record.namespaceRoot), record.object)) throw new Error('Namespace directory changed');
  await syncDirectory(record.namespaceRoot);
  await validateParent(record, dataDir);
  return record;
}
