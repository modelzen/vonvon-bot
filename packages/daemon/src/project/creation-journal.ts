/**
 * Not wired into v1 (s36c2d): no code calls this module. It is s36c2c4a's retained creation-operation record; the
 * creation entries and recovery that would use it (s36c2c4b, s36c2c4c) moved to after v1 (owner 2026-10-18, product.md
 * section 10), and s36d1 creates groups without it. Nothing reads or writes `creation-operations/` until a later slice
 * wires it in.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { permissionSchema } from '@vonvon/protocol';
import { paths } from '../config/paths';
import { acquireMutex, closeMutex, type Mutex } from '../config/data-access';
import { ensureDurableDirectory, SafeAppIdSchema, syncDirectory } from '../config/bot-namespace';

const text = z.string().min(1).max(256).regex(/^[^\x00-\x1f]+$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const absolute = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !/[\x00-\x1f]/.test(value));
const account = { appId: SafeAppIdSchema, tenant: z.enum(['feishu', 'lark']) };
const keySchema = z.strictObject({ ...account, id: z.string().regex(/^[\w-]{16,80}$/).brand<'CreationOperationId'>() });
const botSchema = z.strictObject({ ...account, createdAt: timestamp, registrationId: text.optional() });
const inputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).regex(/^[^/\\\x00-\x1f]+$/).refine(value => value !== '.' && value !== '..'),
  workspace: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('default'), root: absolute }),
    z.strictObject({ kind: z.literal('existing'), path: absolute }),
  ]),
  kind: z.enum(['single', 'multi']), noMention: z.boolean(), backend: text,
  // s31c: retained only for old evidence/signatures; new prepares always capture false.
  mode: z.enum(permissionSchema.options), network: z.boolean(),
});
const snapshotSchema = z.strictObject({
  version: z.literal(1), id: keySchema.shape.id, bot: botSchema, operatorOpenId: text, input: inputSchema,
  createdAt: timestamp, signature: z.string().regex(/^create\/v1:[a-f0-9]{64}$/), remoteUuid: z.string().regex(/^[a-f0-9]{48}$/),
});
const known = { dispatchedAt: timestamp, chatId: z.string().regex(/^oc_[\w-]{1,200}$/).brand<'CreationGroupId'>(), evidence: z.enum(['response', 'operator-selection']) };
const phaseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared') }),
  z.strictObject({ kind: z.literal('unknown'), dispatchedAt: timestamp }),
  z.strictObject({ kind: z.literal('known'), ...known }),
  z.strictObject({ kind: z.literal('published'), ...known }),
]);
const recordSchema = z.strictObject({ snapshot: snapshotSchema, phase: phaseSchema });
const changeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepare'), bot: botSchema, operatorOpenId: text, input: inputSchema }),
  z.strictObject({ kind: z.literal('dispatch'), at: timestamp }),
  z.strictObject({ kind: z.literal('know'), chatId: known.chatId, evidence: known.evidence }),
  z.strictObject({ kind: z.literal('publish') }),
]);
type Key = z.infer<typeof keySchema>;
type Snapshot = z.infer<typeof snapshotSchema>;
export type CreationRecord = z.infer<typeof recordSchema>;
type Change = z.infer<typeof changeSchema>;
const MAX_BYTES = 64 * 1024;
const MAX_OPERATIONS = 4096;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const operationKey = (key: Key): string => digest([key.appId, key.tenant, key.id]);
function signature(value: Pick<Snapshot, 'bot' | 'operatorOpenId' | 'input'>): string {
  const { bot, operatorOpenId, input: i } = value;
  return `create/v1:${digest([bot.appId, bot.tenant, operatorOpenId, i.name, i.workspace.kind,
    i.workspace.kind === 'default' ? i.workspace.root : i.workspace.path, i.kind, i.noMention, i.backend, i.mode, i.network])}`;
}
function validateRecord(raw: unknown, key: Key): CreationRecord {
  const value = recordSchema.parse(raw), s = value.snapshot;
  if (s.id !== key.id || s.bot.appId !== key.appId || s.bot.tenant !== key.tenant
    || s.signature !== signature(s) || s.remoteUuid !== operationKey(key).slice(0, 48)) throw new Error('Invalid creation operation evidence');
  return value;
}

function transition(current: CreationRecord | undefined, change: Change, key: Key): CreationRecord {
  if (change.kind === 'prepare') {
    if (change.bot.appId !== key.appId || change.bot.tenant !== key.tenant) throw new Error('Creation account mismatch');
    const captured = { bot: change.bot, operatorOpenId: change.operatorOpenId, input: { ...change.input, network: false } };
    if (current) {
      if (current.snapshot.signature !== signature(captured) || JSON.stringify(current.snapshot.bot) !== JSON.stringify(change.bot)) throw new Error('Creation operation input conflict');
      return current;
    }
    return { snapshot: { version: 1, id: key.id, ...captured, signature: signature(captured),
      remoteUuid: operationKey(key).slice(0, 48), createdAt: Date.now() }, phase: { kind: 'prepared' } };
  }
  if (!current) throw new Error('Creation operation has not been prepared');
  const phase = current.phase;
  switch (change.kind) {
    case 'dispatch':
      if (phase.kind !== 'prepared') throw new Error('Creation operation was already dispatched');
      return { ...current, phase: { kind: 'unknown', dispatchedAt: change.at } };
    case 'know':
      if (phase.kind === 'known' || phase.kind === 'published') {
        if (phase.chatId !== change.chatId || phase.evidence !== change.evidence) throw new Error('Creation group evidence conflict');
        return current;
      }
      if (phase.kind !== 'unknown') throw new Error('Creation operation has not been dispatched');
      return { ...current, phase: { kind: 'known', dispatchedAt: phase.dispatchedAt, chatId: change.chatId, evidence: change.evidence } };
    case 'publish':
      if (phase.kind === 'published') return current;
      if (phase.kind !== 'known') throw new Error('Creation group is unknown');
      return { ...current, phase: { ...phase, kind: 'published' } };
    default: { const unreachable: never = change; return unreachable; }
  }
}

async function directory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('Invalid creation journal directory');
  await syncDirectory(path);
  await syncDirectory(dirname(path));
}
async function release<T>(mutex: Mutex, work: () => Promise<T>): Promise<T> {
  let result: T;
  try { result = await work(); }
  catch (error) {
    try { await closeMutex(mutex); } catch (closeError) { throw new AggregateError([error, closeError], 'Creation operation and mutex release failed'); }
    throw error;
  }
  await closeMutex(mutex);
  return result;
}
async function locate(key: Key, dataRoot: string): Promise<string> {
  await ensureDurableDirectory(dataRoot);
  const root = join(await realpath(dataRoot), 'creation-operations');
  await directory(root);
  return release(await acquireMutex(root, 'creation', 30_000), async () => {
    const entries = await readdir(root, { withFileTypes: true });
    const operations = entries.filter(entry => entry.name !== '.locks');
    if (operations.some(entry => !/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory())) throw new Error('Invalid creation journal namespace');
    const name = operationKey(key);
    if (!operations.some(entry => entry.name === name) && operations.length >= MAX_OPERATIONS) throw new Error('Creation operation limit reached; retained evidence was not removed');
    const target = join(root, name);
    await directory(target);
    return target;
  });
}
async function readRecord(file: string, key: Key): Promise<CreationRecord | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error('Invalid creation journal file');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const next = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!next.bytesRead) break;
      offset += next.bytesRead;
    }
    if (offset > MAX_BYTES) throw new Error('Creation journal size limit reached');
    return validateRecord(JSON.parse(bytes.subarray(0, offset).toString('utf8')), key);
  } finally { await handle.close(); }
}
async function writeRecord(file: string, record: CreationRecord): Promise<void> {
  const bytes = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Creation journal size limit reached');
  const temporary = `${file}.tmp-${randomUUID()}`;
  let primaryError: unknown;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    let failed = false;
    try { await handle.writeFile(bytes); await handle.sync(); }
    catch (error) { failed = true; throw error; }
    finally { try { await handle.close(); } catch (error) { if (!failed) throw error; } }
    await rename(temporary, file);
    await syncDirectory(dirname(file));
  } catch (error) { primaryError = error; throw error; } finally {
    await unlink(temporary).catch(error => { if (primaryError === undefined && error.code !== 'ENOENT') throw error; });
  }
}

/** Internal creation-service storage. No remote calls or identity authorization.
 * Scope owns one retained operation through its callback, including queued writes.
 * Lock order: operation -> bots -> projects; those writers never enter here. */
export async function withCreationJournal<T>(input: z.input<typeof keySchema>, work: (journal: {
  read(): CreationRecord | undefined;
  change(input: z.input<typeof changeSchema>): Promise<CreationRecord>;
}) => Promise<T>, dataRoot = paths.appDir): Promise<T> {
  const key = keySchema.parse(input), root = resolve(dataRoot);
  const target = await locate(key, root);
  return release(await acquireMutex(target, 'creation', 30_000), async () => {
    const file = join(target, 'operation.json');
    let current = await readRecord(file, key), active = true, writeFailed = false;
    let writes: Promise<void> = Promise.resolve();
    try {
      return await work({
        read() {
          if (writeFailed) throw new Error('Creation journal write failed; reopen before continuing');
          return structuredClone(current);
        },
        change(input) {
          if (!active) return Promise.reject(new Error('Creation journal scope has ended'));
          const captured = changeSchema.parse(input);
          const result = writes.then(async () => {
            if (writeFailed) throw new Error('Creation journal write failed; reopen before continuing');
            const next = validateRecord(transition(current, captured, key), key);
            if (JSON.stringify(next) !== JSON.stringify(current)) {
              try { await writeRecord(file, next); } catch (error) { writeFailed = true; throw error; }
            }
            current = next;
            return structuredClone(next);
          });
          writes = result.then(() => undefined, () => undefined);
          return result;
        },
      });
    } finally { active = false; await writes; }
  });
}
