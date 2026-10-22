import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import { inspectLocalPath, readLocalText } from './bounded-local-files';

const identifier = z.string().min(1).max(128).refine(value => !/[^A-Za-z0-9_-]/.test(value));
const txId = z.string().uuid();
const absolutePath = z.string().min(1).refine(value => !value.includes('\0') && isAbsolute(value) && normalize(value) === value);
const hash = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const identity = z.object({ dev: integer, ino: integer }).strict();
const file = z.string().max(4096).refine(value => {
  if (value.includes('\0') || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return ['config.json', 'projects.json', 'sessions.json', 'comment-instructions.md'].includes(value)
    || value.startsWith('outbound-files/') || /^\.vonvon-import-[a-f0-9-]{36}$/.test(value);
});
export const BridgeMoveAllocationSchema = z.object({
  txId, sequence: integer, from: z.enum(['original', 'stage']), to: z.enum(['stage', 'original', 'backup']),
  sha256: hash, parent: identity, nonce: z.string().uuid(), inode: identity.nullable(),
}).strict();
export type BridgeMoveAllocation = z.infer<typeof BridgeMoveAllocationSchema>;
const intent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move-plist'), from: z.enum(['original', 'stage']),
    to: z.enum(['stage', 'original', 'backup']), sha256: hash,
    allocations: z.array(BridgeMoveAllocationSchema).max(128).default([]) }).strict(),
  z.object({ kind: z.literal('write-file'), appId: identifier, file, sha256: hash }).strict(),
  z.object({ kind: z.literal('create-secret'), appId: identifier, id: z.string(),
    iv: z.string().length(24).regex(/^[a-f0-9]{24}$/) }).strict(),
  z.object({ kind: z.literal('register-bot'), appId: identifier, registrationId: z.string().uuid(), handle: z.string().optional() }).strict(),
  z.object({ kind: z.literal('move-bot'), appId: identifier }).strict(),
  z.object({ kind: z.literal('hook'), target: z.enum(['claude', 'codex']), before: hash, after: hash, mode: integer }).strict(),
  z.object({ kind: z.literal('marker'), target: z.enum(['bridge', 'done']), sha256: hash }).strict(),
  z.object({ kind: z.literal('start-bot'), appId: identifier }).strict(),
  z.object({ kind: z.literal('late-plist'), sha256: hash }).strict(),
  z.object({ kind: z.literal('service'), operation: z.enum(['bootout', 'bootstrap']) }).strict(),
  z.object({ kind: z.literal('stage-directory'), appId: identifier.nullable() }).strict(),
]);
const terminal = ['rolled-back', 'rollback-failed', 'done'] as const;
export const BridgeImportJournalSchema = z.object({
  version: z.literal(1), txId, hostPid: integer.positive(), startedAt: integer.positive(),
  bridgeDir: absolutePath, plistFile: absolutePath, uid: integer,
  reservedAppIds: z.array(identifier).min(1).max(128), acquiredLocks: z.array(identifier).max(128),
  before: z.object({
    plist: z.discriminatedUnion('present', [z.object({ present: z.literal(false) }).strict(),
      z.object({ present: z.literal(true), sha256: hash }).strict()]),
    serviceLoaded: z.boolean(),
    holders: z.array(z.object({ appId: identifier, pid: integer.positive().nullable(),
      startedAt: integer.positive().nullable() }).strict()).max(128),
  }).strict(),
  stageDir: absolutePath, stageIdentity: identity.nullable(),
  intents: z.array(z.object({ sequence: integer, completed: z.boolean(), action: intent }).strict()).max(8192),
  step: z.enum(['checking', 'stopping', 'locking', 'staging', 'staged', 'codex', 'hooks', 'moving', 'starting', 'finishing', 'rolling-back', ...terminal, 'refused']),
  bots: z.array(z.object({appId: identifier, name: z.string()}).strict()).optional(),
  notes: z.array(z.object({kind: z.string(), message: z.string(), appId: identifier.optional(), chatId: z.string().optional()}).strict()).optional(),
  cleanupPending: z.boolean(), outcome: z.enum(terminal).nullable(),
  error: z.object({ code: z.string().min(1).max(128), message: z.string().max(1024) }).strict().optional(),
}).strict().superRefine((journal, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Invalid bridge import ownership' });
  const reserved = new Set(journal.reservedAppIds);
  if (reserved.size !== journal.reservedAppIds.length || new Set(journal.acquiredLocks).size !== journal.acquiredLocks.length) fail();
  if (journal.acquiredLocks.some(id => !reserved.has(id))) fail();
  if (journal.before.holders.length !== reserved.size || new Set(journal.before.holders.map(item => item.appId)).size !== reserved.size
    || journal.before.holders.some(item => !reserved.has(item.appId) || (item.pid === null && item.startedAt !== null))) fail();
  if ((journal.outcome !== null && journal.outcome !== journal.step)
    || (terminal.some(step => step === journal.step) && journal.outcome !== journal.step)
    || (journal.step === 'rolling-back' && !journal.cleanupPending)
    || (journal.step === 'done' && journal.cleanupPending)) fail();
  const nonces = new Set<string>();
  journal.intents.forEach(({ sequence, action }, index) => {
    if (sequence !== index || ('appId' in action && action.appId !== null && !reserved.has(action.appId))) fail();
    if (action.kind === 'write-file' && action.file.startsWith('.vonvon-import-')
      && action.file !== `.vonvon-import-${journal.txId}`) fail();
    if (action.kind === 'create-secret' && action.id !== `app-${action.appId}`) fail();
    if (action.kind === 'move-plist' && (!journal.before.plist.present
      || action.sha256 !== journal.before.plist.sha256)) fail();
    if (action.kind === 'move-plist') for (const allocation of action.allocations) {
      if (allocation.txId !== journal.txId || allocation.sequence !== sequence || allocation.from !== action.from
        || allocation.to !== action.to || allocation.sha256 !== action.sha256 || nonces.has(allocation.nonce)) fail();
      nonces.add(allocation.nonce);
    }
    if (action.kind === 'move-plist' && !((action.from === 'original' && action.to === 'stage')
      || (action.from === 'stage' && (action.to === 'original' || action.to === 'backup')))) fail();
  });
});
export type BridgeImportJournal = z.infer<typeof BridgeImportJournalSchema>;
export type BridgeImportIntent = BridgeImportJournal['intents'][number];
export function withBridgeMoveAllocation(journal: BridgeImportJournal, value: BridgeMoveAllocation): BridgeImportJournal {
  const allocation = BridgeMoveAllocationSchema.parse(value), item = journal.intents[allocation.sequence];
  if (item?.action.kind !== 'move-plist') throw new Error('Invalid bridge move allocation owner');
  const existing = item.action.allocations.findIndex(entry => entry.nonce === allocation.nonce);
  const allocations = [...item.action.allocations];
  if (existing < 0) allocations.push(allocation); else allocations[existing] = allocation;
  if (!sameIntentAction(item.action, { ...item.action, allocations })) throw new Error('Bridge move allocation ownership changed');
  const intents = journal.intents.map(entry => entry.sequence === allocation.sequence
    ? { ...entry, action: { ...item.action, allocations } } : entry);
  return BridgeImportJournalSchema.parse({ ...journal, intents });
}
function sameIntentAction(before: BridgeImportIntent['action'], after: BridgeImportIntent['action']): boolean {
  if (before.kind === 'register-bot' && after.kind === 'register-bot') {
    return before.appId === after.appId && before.registrationId === after.registrationId && (before.handle === undefined || before.handle === after.handle);
  }
  if (before.kind !== 'move-plist' || after.kind !== 'move-plist') return JSON.stringify(before) === JSON.stringify(after);
  const { allocations: oldAllocations, ...oldAction } = before, { allocations, ...action } = after;
  return JSON.stringify(oldAction) === JSON.stringify(action) && allocations.slice(oldAllocations.length).every(entry => entry.inode === null)
    && oldAllocations.every((old, index) => {
      const next = allocations[index];
      if (!next) return false;
      const { inode: oldInode, ...oldFacts } = old, { inode, ...facts } = next;
      return JSON.stringify(oldFacts) === JSON.stringify(facts) && (oldInode === null || JSON.stringify(oldInode) === JSON.stringify(inode));
    });
}
export interface BridgeJournalPaths { appDir: string; bridgeDir: string; plistFile: string }
const maxBytes = 1024 * 1024;

function pathsFor(paths: BridgeJournalPaths) {
  absolutePath.parse(paths.appDir); absolutePath.parse(paths.bridgeDir); absolutePath.parse(paths.plistFile);
  return { directory: join(paths.appDir, 'import', 'bridge'), file: join(paths.appDir, 'import', 'bridge', 'journal.json') };
}
export function parseBridgeImportJournal(value: unknown, paths: BridgeJournalPaths): BridgeImportJournal {
  const journal = BridgeImportJournalSchema.parse(value), location = pathsFor(paths);
  if (journal.bridgeDir !== paths.bridgeDir || journal.plistFile !== paths.plistFile || journal.stageDir !== join(location.directory, journal.txId)) {
    throw new Error('Invalid bridge import journal scope');
  }
  return journal;
}
/** Identity is evidence for the recovery owner, never an instruction to delete an arbitrary path. */
export function ownsBridgeImportStage(journal: BridgeImportJournal, metadata: Stats): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink() && journal.stageIdentity !== null
    && metadata.dev === journal.stageIdentity.dev && metadata.ino === journal.stageIdentity.ino;
}
async function inspectJournal(paths: BridgeJournalPaths) {
  const location = pathsFor(paths), metadata = await inspectLocalPath(paths.appDir, location.file);
  if (metadata && (!metadata.isFile() || metadata.nlink !== 1)) throw new Error('Unsafe bridge import journal');
  return { ...location, metadata };
}
export async function readBridgeImportJournal(paths: BridgeJournalPaths): Promise<BridgeImportJournal | undefined> {
  const location = await inspectJournal(paths);
  const text = await readLocalText(paths.appDir, location.file, undefined, maxBytes);
  const after = (await inspectJournal(paths)).metadata, before = location.metadata;
  if (!before && !after && text === undefined) return undefined;
  if (!before || !after || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || text === undefined) {
    throw new Error('Bridge import journal changed while reading');
  }
  try { return parseBridgeImportJournal(JSON.parse(text), paths); }
  catch { throw new Error('Invalid bridge import journal'); }
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Caller owns the bots mutex / single transaction; this module does not create a second owner. */
export async function writeBridgeImportJournal(paths: BridgeJournalPaths, value: BridgeImportJournal): Promise<void> {
  const journal = parseBridgeImportJournal(value, paths), content = `${JSON.stringify(journal)}\n`;
  if (Buffer.byteLength(content) > maxBytes) throw new Error('Bridge import journal size limit exceeded');
  const location = await inspectJournal(paths);
  const previous = await readBridgeImportJournal(paths);
  if (journal.intents.slice(previous?.txId === journal.txId ? previous.intents.length : 0).some(item =>
    item.action.kind === 'move-plist' && item.action.allocations.some(entry => entry.inode !== null))) {
    throw new Error('Bridge move allocation must reserve before inode receipt');
  }
  if (previous?.txId === journal.txId) {
    const immutable = ['hostPid', 'startedAt', 'bridgeDir', 'plistFile', 'uid', 'reservedAppIds', 'before', 'stageDir'] as const;
    if (immutable.some(field => JSON.stringify(previous[field]) !== JSON.stringify(journal[field]))
      || (previous.stageIdentity !== null && JSON.stringify(previous.stageIdentity) !== JSON.stringify(journal.stageIdentity))
      || (previous.outcome !== null && previous.outcome !== journal.outcome
        && !(previous.outcome !== 'done' && journal.step === 'rolling-back' && journal.cleanupPending && journal.outcome === null))
      || previous.intents.some((item, index) => {
        const next = journal.intents[index];
        return !next || !sameIntentAction(item.action, next.action) || (item.completed && !next.completed);
      })) throw new Error('Bridge import journal ownership changed');
  }
  if (previous && previous.txId !== journal.txId) {
    if (previous.cleanupPending || previous.outcome === null) throw new Error('Bridge import journal belongs to another transaction');
    const archive = join(location.directory, `journal-${previous.txId}.json`);
    if (await inspectLocalPath(paths.appDir, archive)) throw new Error('Bridge import journal archive already exists');
    await rename(location.file, archive);
    await syncDirectory(location.directory);
  }
  for (const directory of [paths.appDir, join(paths.appDir, 'import'), location.directory]) {
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    const metadata = await inspectLocalPath(paths.appDir, directory);
    if (!metadata?.isDirectory()) throw new Error('Unsafe bridge import journal directory');
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }
  const temporary = join(location.directory, `.journal-${journal.txId}-${randomUUID()}.tmp`);
  let owned: Stats | undefined, primaryError: unknown;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { owned = await handle.stat(); await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await inspectJournal(paths);
    const current = await inspectLocalPath(paths.appDir, temporary);
    const bytes = await readLocalText(paths.appDir, temporary, undefined, maxBytes);
    const checked = await inspectLocalPath(paths.appDir, temporary);
    if (!owned || !current?.isFile() || current.nlink !== 1 || current.dev !== owned.dev || current.ino !== owned.ino
      || !checked?.isFile() || checked.dev !== current.dev || checked.ino !== current.ino || checked.nlink !== 1
      || bytes === undefined || createHash('sha256').update(bytes).digest('hex') !== createHash('sha256').update(content).digest('hex')) {
      throw new Error('Bridge import journal temporary ownership changed');
    }
    await rename(temporary, location.file);
    await syncDirectory(location.directory);
  } catch (error) { primaryError = error; throw error; }
  finally {
    try {
      const current = await inspectLocalPath(paths.appDir, temporary);
      if (owned && current?.isFile() && current.dev === owned.dev && current.ino === owned.ino) await unlink(temporary);
    } catch (error) { if (primaryError === undefined) throw error; }
  }
}
