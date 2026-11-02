import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  memoryEventSchema, memorySnapshotSchema,
  MEMORY_TEXT_MAX,
  type MemoryActorRole, type MemoryBranch, type MemoryEvent, type MemoryEventKind, type MemoryItem, type MemoryItemScope, type MemorySource,
} from '@vonvon/protocol';
import { isDead } from '../config/data-access';
import { syncDirectory } from '../config/bot-namespace';
import { holdMemoryDirectory, libraryLocation, projectDirectory, type LibraryLocation } from '../project/library';
import { writeFileAtomic } from '../server/atomic-file';
import { isMakeRoomCandidate } from './memory-authority';
import {
  branchKey, findBranch, freshBranches, normalizeBranchName, orderBranches, pruneBranches, resolveBranch,
} from './memory-branches';
import { findSecretShape } from './memory-secret-shape';

/**
 * 记忆条目库（记忆设计 §2.4、§3.6、§3.7）：一份记忆（一个项目的、一个 bot 的、私聊里一个人的）一个目录，里面是
 * `events.jsonl`（事件先行，追加）、`memory.json`（快照，tmp + rename）、`usage.json`（使用统计，尽力写）、
 * `integrity.json`（快照的 sha256）。每次写：拿 `'memory'` 内核互斥 → 读快照并重放快照之后的事件 → 改 → 追加事件
 * → 写快照。所以事件和快照之间被杀，下一次读到的状态也一样。P2 不接线，工具、隐藏块和桌面端（P4a 起）调它。
 */

export const PROJECT_MEMORY_LIMIT = 100;
export const BOT_MEMORY_LIMIT = 50;
export const DM_MEMORY_LIMIT = 50;
/** 已归档的条目超过这个数，最老的物理删除 */
export const ARCHIVED_MAX = 500;
/** `memory-full` 带回去的腾位候选条数 */
export const MAKE_ROOM_CANDIDATES = 5;
/** 彻底删除后事件里留的占位 */
export const PURGED_TEXT = '（已彻底删除）';
const DUPLICATE_DISTANCE = 0.1;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_LOG_BYTES = 64 * 1024 * 1024;

export class MemoryCorruptError extends Error {}

export interface MemoryActor { openId?: string; role: MemoryActorRole }

/** 一份记忆放在哪：`lockDir` 上拿 `'memory'` 互斥，`dir` 里是四个文件 */
export interface MemoryLocation {
  /** `p_<projectId>` | `b` | `d_<openId>`，条目 id 和事件 id 的前缀 */
  storeId: string;
  scope: MemoryItemScope;
  lockDir: string;
  dir: string;
  limit: number;
}

export function projectMemoryLocation(projectId: string, options: { library?: LibraryLocation; limit?: number } = {}): MemoryLocation {
  const dir = projectDirectory(projectId, options.library ?? libraryLocation());
  return { storeId: `p_${projectId}`, scope: { kind: 'project', projectId }, lockDir: dir, dir, limit: options.limit ?? PROJECT_MEMORY_LIMIT };
}
/** `botDirectory` 是 `bots/<appId>/`：互斥拿在它上面，文件在它下面的 `memory/` */
export function botMemoryLocation(botDirectory: string, options: { limit?: number } = {}): MemoryLocation {
  return { storeId: 'b', scope: { kind: 'bot' }, lockDir: botDirectory, dir: join(botDirectory, 'memory'), limit: options.limit ?? BOT_MEMORY_LIMIT };
}
const OPEN_ID = /^[A-Za-z0-9_-]{1,100}$/;
export function dmMemoryLocation(botDirectory: string, openId: string, options: { limit?: number } = {}): MemoryLocation {
  if (!OPEN_ID.test(openId)) throw new Error('open_id 无效');
  const dir = join(botDirectory, 'memory', 'dm', openId);
  return { storeId: `d_${openId}`, scope: { kind: 'dm', openId }, lockDir: dir, dir, limit: options.limit ?? DM_MEMORY_LIMIT };
}

export interface MemoryUsageEntry { lastUsedAt: number; useCount: number }

interface State {
  branches: MemoryBranch[];
  items: Map<string, MemoryItem>;
  lastEventId: string | undefined;
  importedHashes: Set<string>;
}

export interface MemoryView {
  items: MemoryItem[];
  branches: MemoryBranch[];
  limit: number;
  /** active entries, what the limit counts */
  used: number;
  lastEventId?: string;
  /** false: memory.json is not the file the daemon last wrote; trusted entries are not to be injected */
  verified: boolean;
  problems: string[];
}

// ---- results ---------------------------------------------------------------------------------------------------

export type StoreRefusal = 'memory-full' | 'looks-like-secret' | 'duplicate' | 'bad-args' | 'not-found' | 'archived' | 'fixed-branch' | 'no-such-branch' | 'branch-conflict' | 'not-undoable';
export type Refused = { ok: false; reason: StoreRefusal; message: string; candidates?: MemoryItem[]; itemId?: string; usage?: { used: number; limit: number } };
export type Conflict = { ok: false; reason: 'conflict'; message: string; current?: MemoryItem };
export type ItemResult = { ok: true; item: MemoryItem; branchApplied: string; newBranch?: true; usage: { used: number; limit: number } } | Refused | Conflict;
export type BranchResult = { ok: true; branches: MemoryBranch[]; moved: number } | Refused | Conflict;

export interface AddInput {
  text: string;
  /** 缺省或归一化后为空进"其他" */
  branch?: string;
  /** 移层时只进已有的分支，没有同名的进"其他" */
  existingOnly?: boolean;
  source: MemorySource;
  trust: 'trusted' | 'untrusted';
  actor: MemoryActor;
  /** 缺省 `add`；移层时是 `promote` / `move` */
  eventKind?: Extract<MemoryEventKind, 'add' | 'promote' | 'move'>;
  /** 提交点前同步调一次（工具的 commit guard 接这里）：抛错就不写。拿到互斥、查完上限和重复之后、写事件之前 */
  beforeCommit?: () => void;
}
export interface EditInput {
  itemId: string;
  revision: number;
  text?: string;
  branch?: string;
  actor: MemoryActor;
  beforeCommit?: () => void;
}
export interface ItemChange { itemId: string; revision: number; actor: MemoryActor; beforeCommit?: () => void }

export interface ImportEntry {
  text: string;
  branch: string;
  source: MemorySource;
  trust: 'trusted' | 'untrusted';
  /** 不管还有没有空位都按已归档放进去 */
  archived?: boolean;
}
export interface ImportResult { added: number; archived: number; skipped: number; rejected: number }

export interface MemoryStoreOptions {
  now?: () => number;
  /** 测试用：模拟事件和快照之间被杀 */
  afterEvents?: () => void | Promise<void>;
  /** 测试用：快照 tmp 写好、改名之前 */
  beforeSnapshotRename?: () => void | Promise<void>;
}

// ---- small helpers ---------------------------------------------------------------------------------------------

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function randomBase32(length: number): string {
  let out = '';
  for (const byte of randomBytes(length)) out += BASE32[byte % 32];
  return out;
}
const codePoints = (value: string): number => Array.from(value).length;
const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

function levenshtein(a: readonly string[], b: readonly string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = row;
  }
  return previous[b.length]!;
}
const squash = (text: string): string[] => Array.from(text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''));
/** 去空白标点后编辑距离 ≤ 10% */
export function similarMemoryText(a: string, b: string): boolean {
  const left = squash(a); const right = squash(b);
  const longest = Math.max(left.length, right.length);
  if (!longest) return true;
  return levenshtein(left, right) / longest <= DUPLICATE_DISTANCE;
}

async function readRegular(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let file: FileHandle;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new MemoryCorruptError(`记忆文件无效：${path}`);
    return await file.readFile();
  } finally { await file.close(); }
}

async function writeFileDurably(path: string, content: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  let failed = false;
  try { await file.writeFile(content, 'utf8'); await file.sync(); }
  catch (error) { failed = true; throw error; }
  finally { try { await file.close(); } catch (error) { if (!failed) throw error; } }
}

// ---- events: applying them is the one place state changes -----------------------------------------------------------

function activeBranchNames(items: Iterable<MemoryItem>): Set<string> {
  const names = new Set<string>();
  for (const item of items) if (item.state === 'active') names.add(item.branch);
  return names;
}

/**
 * 事件对状态的全部改动。活的写入先造好事件、再调它，重放也只调它，所以快照和重放不会分叉。
 * 事件自己带完整的条目（`after`）或名字和条目 id（改名、合并），不依赖当时的别的状态。
 */
function applyEvent(state: State, event: MemoryEvent): void {
  const moved = (ids: readonly string[], branch: string): void => {
    for (const id of ids) {
      const item = state.items.get(id);
      if (item) state.items.set(id, { ...item, branch, revision: item.revision + 1, updatedAt: event.at });
    }
  };
  const info = event.branches;
  switch (event.kind) {
    case 'branch_rename': {
      if (!info?.to) break;
      const entry = findBranch(state.branches, info.from);
      if (entry) state.branches = state.branches.map(branch => branch === entry ? { ...branch, name: info.to! } : branch);
      moved(info.itemIds, info.to);
      break;
    }
    case 'branch_merge': {
      if (!info?.into) break;
      state.branches = state.branches.filter(branch => branchKey(branch.name) !== branchKey(info.from));
      moved(info.itemIds, info.into);
      break;
    }
    case 'branch_unmerge': {
      if (info?.entry && !findBranch(state.branches, info.entry.name)) state.branches = [...state.branches, info.entry];
      if (info) moved(info.itemIds, info.from);
      break;
    }
    case 'purge': {
      if (event.itemId) state.items.delete(event.itemId);
      break;
    }
    default: {
      const after = event.after;
      if (!after) break;
      state.items.set(after.id, after);
      if (after.source.importHash) state.importedHashes.add(after.source.importHash);
      // 条目在的分支一定在表里；重放时事件的 `newBranch` 只是说明，不靠它
      if (after.state === 'active' && !findBranch(state.branches, after.branch)) {
        state.branches = [...state.branches, { name: after.branch, fixed: false, createdAt: event.at, createdBy: event.actor.openId ?? event.actor.role }];
      }
    }
  }
  state.lastEventId = event.eventId;
  state.branches = pruneBranches(state.branches, activeBranchNames(state.items.values()));
}

function scrubItem(item: MemoryItem | null | undefined): MemoryItem | null | undefined {
  if (!item) return item;
  const { why: _why, ...source } = item.source;
  return { ...item, text: PURGED_TEXT, source };
}
function scrubEvent(event: MemoryEvent, ids: ReadonlySet<string>): MemoryEvent {
  if (!event.itemId || !ids.has(event.itemId)) return event;
  return { ...event, before: scrubItem(event.before), after: scrubItem(event.after) };
}

// ---- the store -------------------------------------------------------------------------------------------------

interface Transaction {
  readonly state: State;
  readonly now: number;
  readonly location: MemoryLocation;
  emit(input: Omit<MemoryEvent, 'eventId' | 'at'>): MemoryEvent;
  scrub(itemId: string): void;
  readonly events: MemoryEvent[];
}

const chains = new Map<string, Promise<unknown>>();
function serially<T>(key: string, run: () => Promise<T>): Promise<T> {
  const result = (chains.get(key) ?? Promise.resolve()).then(run);
  const tail = result.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return result;
}

const TEMPORARY = /^(?:memory\.json|integrity\.json|events\.jsonl)\.tmp-(\d+)-[0-9a-f-]{36}$/;

export class MemoryStore {
  private readonly now: () => number;

  constructor(readonly location: MemoryLocation, private readonly options: MemoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  private file(name: string): string { return join(this.location.dir, name); }

  // -- reading --------------------------------------------------------------------------------------------------

  private async readSnapshot(): Promise<{ state: State; raw: Buffer | undefined; problems: string[] }> {
    const raw = await readRegular(this.file('memory.json'), MAX_SNAPSHOT_BYTES);
    const state: State = { branches: freshBranches(this.location.scope.kind, 0), items: new Map(), lastEventId: undefined, importedHashes: new Set() };
    const problems: string[] = [];
    if (!raw) return { state, raw, problems };
    let parsed;
    try { parsed = memorySnapshotSchema.safeParse(JSON.parse(raw.toString('utf8'))); }
    catch { throw new MemoryCorruptError('memory.json 不是有效的 JSON'); }
    if (!parsed.success) throw new MemoryCorruptError('memory.json 格式无效');
    const data = parsed.data;
    state.branches = orderBranches(data.branches);
    state.lastEventId = data.lastEventId;
    for (const hash of data.importedHashes ?? []) state.importedHashes.add(hash);
    for (const item of data.items) {
      // 每条校验 scope 等于所在目录；对不上的不进库，列在 problems 里
      if (!sameScope(item.scope, this.location.scope) || !item.id.startsWith(`${this.location.storeId}:`)) { problems.push(`条目 ${item.id} 不属于这份记忆，已忽略`); continue; }
      state.items.set(item.id, item);
    }
    return { state, raw, problems };
  }

  /** The log; a last line that was cut off by a kill is dropped, and `validBytes` says where the good part ends. */
  private async readEvents(): Promise<{ events: MemoryEvent[]; validBytes: number; torn: boolean }> {
    const raw = await readRegular(this.file('events.jsonl'), MAX_EVENT_LOG_BYTES);
    if (!raw) return { events: [], validBytes: 0, torn: false };
    const events: MemoryEvent[] = [];
    let offset = 0;
    let validBytes = 0;
    while (offset < raw.length) {
      const end = raw.indexOf(0x0a, offset);
      const line = raw.subarray(offset, end === -1 ? raw.length : end).toString('utf8');
      if (line.trim()) {
        let parsed;
        try { parsed = memoryEventSchema.safeParse(JSON.parse(line)); } catch { parsed = undefined; }
        if (!parsed?.success) {
          if (end === -1) return { events, validBytes, torn: true };
          throw new MemoryCorruptError('events.jsonl 里有无法解析的行');
        }
        events.push(parsed.data);
      }
      offset = end === -1 ? raw.length : end + 1;
      validBytes = offset;
    }
    return { events, validBytes, torn: false };
  }

  private async load(): Promise<{ state: State; replayed: number; problems: string[]; raw: Buffer | undefined; log: Awaited<ReturnType<MemoryStore['readEvents']>> }> {
    const { state, raw, problems } = await this.readSnapshot();
    const log = await this.readEvents();
    let from = 0;
    if (state.lastEventId !== undefined) {
      const index = log.events.findIndex(event => event.eventId === state.lastEventId);
      if (index === -1) throw new MemoryCorruptError('memory.json 记的最后一个事件不在 events.jsonl 里');
      from = index + 1;
    }
    const tail = log.events.slice(from);
    for (const event of tail) applyEvent(state, event);
    return { state, replayed: tail.length, problems, raw, log };
  }

  private async verify(raw: Buffer | undefined): Promise<{ verified: boolean; problems: string[] }> {
    if (!raw) return { verified: true, problems: [] };
    const record = await readRegular(this.file('integrity.json'), 64 * 1024).catch(() => undefined);
    let known: string[] = [];
    let flagged = false;
    try {
      const parsed = record ? JSON.parse(record.toString('utf8')) as { sha256?: unknown; previous?: unknown; unverified?: unknown } : undefined;
      known = [parsed?.sha256, parsed?.previous].filter((value): value is string => typeof value === 'string');
      flagged = parsed?.unverified === true;
    } catch { /* 当作没有记录 */ }
    if (!known.length) return { verified: false, problems: ['缺少完整性记录，memory.json 可能被外部改过'] };
    // 一次写入发现文件对不上，就把记录标成"未确认"，一直带到主人确认（reseal）为止：普通写入不能把外部改动洗成可信
    if (flagged) return { verified: false, problems: ['memory.json 被外部改过，主人确认之前可信条目不注入'] };
    // 记录里有上一份的 hash：快照改名和记录写入之间被杀时，两种都是我们写的
    return known.includes(sha256(raw)) ? { verified: true, problems: [] } : { verified: false, problems: ['memory.json 被外部改过'] };
  }

  /** Lock-free: the snapshot, plus the events after it. */
  async read(): Promise<MemoryView> {
    let { state, problems, raw } = await this.load();
    let integrity = await this.verify(raw);
    // 没加锁读：快照和记录之间正好有别人写完两次，就对不上。重读一次再下结论
    if (!integrity.verified) {
      ({ state, problems, raw } = await this.load());
      integrity = await this.verify(raw);
    }
    return this.view(state, [...problems, ...integrity.problems], integrity.verified);
  }

  async get(itemId: string): Promise<MemoryItem | undefined> {
    return (await this.load()).state.items.get(itemId);
  }

  private view(state: State, problems: string[] = [], verified = true): MemoryView {
    const items = [...state.items.values()];
    return {
      items, branches: orderBranches(state.branches), limit: this.location.limit,
      used: items.filter(item => item.state === 'active').length,
      ...(state.lastEventId ? { lastEventId: state.lastEventId } : {}), verified, problems,
    };
  }

  async events(itemId?: string): Promise<MemoryEvent[]> {
    const { events } = await this.readEvents();
    return itemId ? events.filter(event => event.itemId === itemId || event.branches?.itemIds.includes(itemId)) : events;
  }

  // -- usage (best effort, outside the lock, not part of revisions, events or integrity) ------------------------------------

  async readUsage(): Promise<Record<string, MemoryUsageEntry>> {
    try {
      const raw = await readRegular(this.file('usage.json'), MAX_SNAPSHOT_BYTES);
      const value = raw ? JSON.parse(raw.toString('utf8')) as unknown : {};
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, MemoryUsageEntry> : {};
    } catch { return {}; }
  }
  async recordUsage(itemIds: readonly string[]): Promise<void> {
    if (!itemIds.length) return;
    try {
      await serially(`usage:${this.location.dir}`, async () => {
        const usage = await this.readUsage();
        const at = this.now();
        for (const id of itemIds) usage[id] = { lastUsedAt: at, useCount: (usage[id]?.useCount ?? 0) + 1 };
        await writeFileAtomic(this.file('usage.json'), `${JSON.stringify(usage)}\n`);
      });
    } catch { /* 使用统计丢了不影响记忆 */ }
  }

  // -- writing --------------------------------------------------------------------------------------------------

  private transact<T>(operation: (tx: Transaction) => T | Promise<T>, options: { reseal?: boolean } = {}): Promise<T> {
    return serially(this.location.lockDir, () => holdMemoryDirectory(this.location.lockDir, async () => {
      await mkdir(this.location.dir, { recursive: true, mode: 0o700 });
      await this.sweepTemporaries();
      const loaded = await this.load();
      const pre = await this.verify(loaded.raw);
      const events: MemoryEvent[] = [];
      const scrubbed = new Set<string>();
      const now = this.now();
      const storeId = this.location.storeId;
      const tx: Transaction = {
        state: loaded.state, now, location: this.location, events,
        emit: input => {
          const event = memoryEventSchema.parse({ ...input, eventId: `${storeId}:e_${now.toString(36)}${randomBase32(6)}`, at: now });
          applyEvent(loaded.state, event);
          events.push(event);
          return event;
        },
        scrub: itemId => { scrubbed.add(itemId); },
      };
      const result = await operation(tx);
      // A tail replayed from the log is written back too, so the snapshot catches up.
      if (events.length || loaded.replayed || loaded.log.torn) await this.persist(loaded.state, events, scrubbed, loaded.log, loaded.raw, !pre.verified && !options.reseal);
      return result;
    }));
  }

  private async sweepTemporaries(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.location.dir); } catch { return; }
    for (const name of names) {
      const match = TEMPORARY.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      let gone = false;
      try { gone = pid !== process.pid && isDead(pid); } catch { gone = false; }
      if (gone) await unlink(this.file(name)).catch(() => undefined);
    }
  }

  private async persist(state: State, events: MemoryEvent[], scrubbed: ReadonlySet<string>, log: { events: MemoryEvent[]; validBytes: number; torn: boolean }, previousRaw: Buffer | undefined, unverified = false): Promise<void> {
    const eventsPath = this.file('events.jsonl');
    const lines = events.map(event => `${JSON.stringify(event)}\n`).join('');
    if (scrubbed.size) {
      // 彻底删除：原文从事件里换成占位，整份重写（tmp + rename），新事件一起带上
      const kept = [...log.events, ...events].map(event => scrubEvent(event, scrubbed));
      const tmp = `${eventsPath}.tmp-${process.pid}-${randomUUID()}`;
      let renamed = false;
      try {
        await writeFileDurably(tmp, kept.map(event => `${JSON.stringify(event)}\n`).join(''));
        await rename(tmp, eventsPath);
        renamed = true;
      } finally { if (!renamed) await unlink(tmp).catch(() => undefined); }
    } else if (lines || log.torn) {
      const file = await open(eventsPath, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1) throw new MemoryCorruptError('events.jsonl 不是普通文件');
        if (log.torn) await file.truncate(log.validBytes);
        if (lines) await file.writeFile(lines, 'utf8');
        await file.sync();
      } finally { await file.close(); }
    }
    await this.options.afterEvents?.();
    const body = `${JSON.stringify({
      version: 1, ...(state.lastEventId ? { lastEventId: state.lastEventId } : {}),
      branches: state.branches, items: [...state.items.values()], importedHashes: [...state.importedHashes],
    }, null, 2)}\n`;
    const stamp = `${process.pid}-${randomUUID()}`;
    const snapshotTmp = `${this.file('memory.json')}.tmp-${stamp}`;
    let renamed = false;
    try {
      await writeFileDurably(snapshotTmp, body);
      // The record names the new file and the one it replaces: a kill between this and the rename leaves either one valid.
      const integrityTmp = `${this.file('integrity.json')}.tmp-${stamp}`;
      try {
        await writeFileDurably(integrityTmp, `${JSON.stringify({ sha256: sha256(body), ...(previousRaw ? { previous: sha256(previousRaw) } : {}), at: this.now(), ...(unverified ? { unverified: true } : {}) })}\n`);
        await rename(integrityTmp, this.file('integrity.json'));
      } catch (error) { await unlink(integrityTmp).catch(() => undefined); throw error; }
      await this.options.beforeSnapshotRename?.();
      await rename(snapshotTmp, this.file('memory.json'));
      renamed = true;
      await syncDirectory(this.location.dir);
    } finally { if (!renamed) await unlink(snapshotTmp).catch(() => undefined); }
  }

  private usageOf(state: State): { used: number; limit: number } {
    return { used: [...state.items.values()].filter(item => item.state === 'active').length, limit: this.location.limit };
  }

  private async fullRefusal(state: State): Promise<Refused> {
    const usage = await this.readUsage();
    const candidates = [...state.items.values()].filter(isMakeRoomCandidate)
      .sort((a, b) => (usage[a.id]?.lastUsedAt ?? 0) - (usage[b.id]?.lastUsedAt ?? 0) || a.createdAt - b.createdAt)
      .slice(0, MAKE_ROOM_CANDIDATES);
    return { ok: false, reason: 'memory-full', message: `记忆满了（${this.location.limit} 条）`, candidates, usage: this.usageOf(state) };
  }

  private checkText(text: string): Refused | undefined {
    if (!text.trim() || codePoints(text) > MEMORY_TEXT_MAX) return { ok: false, reason: 'bad-args', message: `记忆要 1 到 ${MEMORY_TEXT_MAX} 字` };
    const secret = findSecretShape(text);
    if (secret) return { ok: false, reason: 'looks-like-secret', message: '像密钥，没记' };
    return undefined;
  }

  private newItemId(state: State): string {
    for (;;) {
      const id = `${this.location.storeId}:${randomBase32(6)}`;
      if (!state.items.has(id)) return id;
    }
  }

  /** 归档的超过 500 条，最老的物理删除：条目消失，事件里的原文换成占位 */
  private trimArchived(tx: Transaction, actor: MemoryActor): void {
    const archived = [...tx.state.items.values()].filter(item => item.state === 'archived').sort((a, b) => a.updatedAt - b.updatedAt);
    for (const item of archived.slice(0, Math.max(0, archived.length - ARCHIVED_MAX))) {
      tx.scrub(item.id);
      tx.emit({ kind: 'purge', itemId: item.id, actor, reason: 'cap' });
    }
  }

  add(input: AddInput): Promise<ItemResult> {
    return this.transact(async tx => {
      const text = input.text.trim();
      const bad = this.checkText(text);
      if (bad) return bad;
      const { state } = tx;
      const messageId = input.source.messageId;
      if (messageId && (input.source.via === 'tool' || input.source.via === 'hidden_block')) {
        const twin = [...state.items.values()].find(item => item.state === 'active' && item.source.messageId === messageId
          && (item.source.via === 'tool' || item.source.via === 'hidden_block') && similarMemoryText(item.text, text));
        if (twin) return { ok: false, reason: 'duplicate', message: '已经记着了', itemId: twin.id };
      }
      if (this.usageOf(state).used >= this.location.limit) return this.fullRefusal(state);
      const resolved = resolveBranch(state.branches, input.branch, { existingOnly: input.existingOnly ?? false });
      input.beforeCommit?.();
      const item: MemoryItem = {
        id: this.newItemId(state), scope: this.location.scope, text, branch: resolved.name, state: 'active', trust: input.trust,
        source: input.source, createdAt: tx.now, updatedAt: tx.now, revision: 1,
      };
      tx.emit({ kind: input.eventKind ?? 'add', itemId: item.id, before: null, after: item, actor: input.actor, ...(resolved.newBranch ? { newBranch: true } : {}) });
      return { ok: true, item, branchApplied: resolved.name, ...(resolved.newBranch ? { newBranch: true as const } : {}), usage: this.usageOf(state) };
    });
  }

  /** The target of a change to one item: undefined means go on; otherwise the refusal or conflict to return. */
  private target(tx: Transaction, itemId: string, revision: number, options: { allowArchived?: boolean } = {}): MemoryItem | Refused | Conflict {
    const item = tx.state.items.get(itemId);
    if (!item) return { ok: false, reason: 'not-found', message: '没有这条记忆' };
    if (item.revision !== revision) return { ok: false, reason: 'conflict', message: '这条记忆已经被别处改过了', current: item };
    if (item.state === 'archived' && !options.allowArchived) return { ok: false, reason: 'archived', message: '这条记忆已归档' };
    return item;
  }

  edit(input: EditInput): Promise<ItemResult> {
    return this.transact(tx => {
      if (input.text === undefined && input.branch === undefined) return { ok: false, reason: 'bad-args', message: '没有要改的内容' } satisfies Refused;
      const found = this.target(tx, input.itemId, input.revision);
      if (!('id' in found)) return found;
      const text = input.text === undefined ? found.text : input.text.trim();
      if (input.text !== undefined) { const bad = this.checkText(text); if (bad) return bad; }
      const resolved = input.branch === undefined ? { name: found.branch, newBranch: false } : resolveBranch(tx.state.branches, input.branch);
      if (text === found.text && resolved.name === found.branch) return { ok: true, item: found, branchApplied: found.branch, usage: this.usageOf(tx.state) };
      input.beforeCommit?.();
      // 非主人、非桌面端改了文本，原来的"可信"不再成立
      const manager = input.actor.role === 'owner' || input.actor.role === 'admin' || input.actor.role === 'desktop' || input.actor.role === 'cli';
      const trust = text !== found.text && !manager ? 'untrusted' : found.trust;
      const after: MemoryItem = {
        ...found, text, branch: resolved.name, trust, updatedAt: tx.now, revision: found.revision + 1,
        lastEditedBy: { ...(input.actor.openId ? { actorOpenId: input.actor.openId } : {}), actorRole: input.actor.role, at: tx.now },
      };
      tx.emit({ kind: 'edit', itemId: found.id, before: found, after, actor: input.actor, ...(resolved.newBranch ? { newBranch: true } : {}) });
      return { ok: true, item: after, branchApplied: resolved.name, ...(resolved.newBranch ? { newBranch: true as const } : {}), usage: this.usageOf(tx.state) };
    });
  }

  private setState(tx: Transaction, found: MemoryItem, kind: 'archive' | 'restore', actor: MemoryActor, extra: Partial<Pick<MemoryEvent, 'reason' | 'undoOf'>> = {}): ItemResult | Promise<ItemResult> {
    const restoring = kind === 'restore';
    if (restoring && this.usageOf(tx.state).used >= this.location.limit) return this.fullRefusal(tx.state);
    // 恢复时分支重新判断：原来的分支还在就回去，没有就重开或进"其他"
    const resolved = restoring ? resolveBranch(tx.state.branches, found.branch) : { name: found.branch, newBranch: false };
    const after: MemoryItem = {
      ...found, state: restoring ? 'active' : 'archived', branch: resolved.name, updatedAt: tx.now, revision: found.revision + 1,
      lastEditedBy: { ...(actor.openId ? { actorOpenId: actor.openId } : {}), actorRole: actor.role, at: tx.now },
    };
    tx.emit({ kind, itemId: found.id, before: found, after, actor, ...extra, ...(resolved.newBranch ? { newBranch: true } : {}) });
    if (!restoring) this.trimArchived(tx, actor);
    return { ok: true, item: after, branchApplied: resolved.name, ...(resolved.newBranch ? { newBranch: true as const } : {}), usage: this.usageOf(tx.state) };
  }

  archive(input: ItemChange & { reason?: 'make-room' }): Promise<ItemResult> {
    return this.transact(tx => {
      const found = this.target(tx, input.itemId, input.revision);
      if (!('id' in found)) return found;
      input.beforeCommit?.();
      return this.setState(tx, found, 'archive', input.actor, input.reason ? { reason: input.reason } : {});
    });
  }

  restore(input: ItemChange): Promise<ItemResult> {
    return this.transact(tx => {
      const found = this.target(tx, input.itemId, input.revision, { allowArchived: true });
      if (!('id' in found)) return found;
      if (found.state === 'active') return { ok: false, reason: 'bad-args', message: '这条记忆没有归档' } satisfies Refused;
      return this.setState(tx, found, 'restore', input.actor);
    });
  }

  /** 点成可信（只有主人）。已经可信的原样返回 */
  confirm(input: ItemChange): Promise<ItemResult> {
    return this.transact(tx => {
      const found = this.target(tx, input.itemId, input.revision);
      if (!('id' in found)) return found;
      if (found.trust === 'trusted') return { ok: true, item: found, branchApplied: found.branch, usage: this.usageOf(tx.state) };
      const after: MemoryItem = { ...found, trust: 'trusted', updatedAt: tx.now, revision: found.revision + 1, lastEditedBy: { ...(input.actor.openId ? { actorOpenId: input.actor.openId } : {}), actorRole: input.actor.role, at: tx.now } };
      tx.emit({ kind: 'confirm', itemId: found.id, before: found, after, actor: input.actor });
      return { ok: true, item: after, branchApplied: after.branch, usage: this.usageOf(tx.state) };
    });
  }

  /** 彻底删除：条目消失，它在 events.jsonl 里的原文换成占位。不核对 revision（主人在桌面端一键做） */
  purge(input: { itemId: string; actor: MemoryActor }): Promise<{ ok: true } | Refused> {
    return this.transact(tx => {
      if (!tx.state.items.has(input.itemId)) return { ok: false, reason: 'not-found', message: '没有这条记忆' } satisfies Refused;
      tx.scrub(input.itemId);
      tx.emit({ kind: 'purge', itemId: input.itemId, actor: input.actor });
      return { ok: true as const };
    });
  }

  /** 主人确认外部改过的 memory.json：照现在的内容重写快照和完整性记录 */
  reseal(): Promise<void> {
    return this.transact(async tx => {
      // an empty change still writes the snapshot and its record
      tx.emit({ kind: 'edit', actor: { role: 'desktop' } });
    }, { reseal: true });
  }

  // -- branches ---------------------------------------------------------------------------------------------------

  private itemsOf(tx: Transaction, branch: string): MemoryItem[] {
    return [...tx.state.items.values()].filter(item => branchKey(item.branch) === branchKey(branch));
  }
  private revisionsAfter(items: readonly MemoryItem[]): Record<string, number> {
    return Object.fromEntries(items.map(item => [item.id, item.revision + 1]));
  }

  /** 固定分支不能改名；撞上已有的名字报 conflict，让主人改用合并 */
  branchRename(input: { from: string; to: string; actor: MemoryActor }): Promise<BranchResult> {
    return this.transact(tx => {
      const entry = findBranch(tx.state.branches, input.from);
      if (!entry) return { ok: false, reason: 'no-such-branch', message: '没有这个分支' } satisfies Refused;
      if (entry.fixed) return { ok: false, reason: 'fixed-branch', message: '固定分支不能改名' } satisfies Refused;
      const to = normalizeBranchName(input.to);
      const other = findBranch(tx.state.branches, to);
      if (other && other !== entry) return { ok: false, reason: 'conflict', message: `已经有叫「${to}」的分支，要合并请用合并` } satisfies Conflict;
      if (to === entry.name) return { ok: true, branches: orderBranches(tx.state.branches), moved: 0 };
      const items = this.itemsOf(tx, entry.name);
      tx.emit({ kind: 'branch_rename', actor: input.actor, branches: { from: entry.name, to, itemIds: items.map(item => item.id), revisions: this.revisionsAfter(items) } });
      return { ok: true, branches: orderBranches(tx.state.branches), moved: items.length };
    });
  }

  /** 固定分支不能当 `from`（别的分支可以并进固定分支）。一个事件记下挪过去的全部条目，撤销时整批挪回 */
  branchMerge(input: { from: string; into: string; actor: MemoryActor }): Promise<BranchResult> {
    return this.transact(tx => {
      const from = findBranch(tx.state.branches, input.from);
      const into = findBranch(tx.state.branches, input.into);
      if (!from || !into) return { ok: false, reason: 'no-such-branch', message: '没有这个分支' } satisfies Refused;
      if (from.fixed) return { ok: false, reason: 'fixed-branch', message: '固定分支不能并到别的分支里' } satisfies Refused;
      if (from === into) return { ok: false, reason: 'bad-args', message: '不能并到自己里' } satisfies Refused;
      const items = this.itemsOf(tx, from.name);
      tx.emit({ kind: 'branch_merge', actor: input.actor, branches: { from: from.name, into: into.name, itemIds: items.map(item => item.id), revisions: this.revisionsAfter(items), entry: from } });
      return { ok: true, branches: orderBranches(tx.state.branches), moved: items.length };
    });
  }

  /**
   * 删除分支（网页的"删除分支"）：一次事务里把分支的 active 条目全部归档，每条一个 `archive` 事件，撤销时逐条撤；
   * 分支空了照常去掉。`expected` 是调用方看到的条数，对不上什么都不改
   */
  branchDelete(input: { name: string; expected?: number; actor: MemoryActor }): Promise<BranchResult> {
    return this.transact(async tx => {
      const entry = findBranch(tx.state.branches, input.name);
      if (!entry) return { ok: false, reason: 'no-such-branch', message: '没有这个分支' } satisfies Refused;
      if (entry.fixed) return { ok: false, reason: 'fixed-branch', message: '固定分支不能删' } satisfies Refused;
      const items = this.itemsOf(tx, entry.name).filter(item => item.state === 'active');
      if (input.expected !== undefined && input.expected !== items.length) return { ok: false, reason: 'conflict', message: '分支里的条目刚变过，重新看一次再删' } satisfies Conflict;
      for (const item of items) await this.setState(tx, item, 'archive', input.actor);
      return { ok: true, branches: orderBranches(tx.state.branches), moved: items.length };
    });
  }

  // -- undo ------------------------------------------------------------------------------------------------------

  /** 撤销：找到事件，核对条目 `revision === after.revision`，应用逆操作并追加新事件 */
  undo(input: { eventId: string; actor: MemoryActor }): Promise<ItemResult | BranchResult> {
    return this.transact(async tx => {
      const { events } = await this.readEvents();
      const event = events.find(candidate => candidate.eventId === input.eventId);
      if (!event) return { ok: false, reason: 'not-found', message: '没有这个事件' } satisfies Refused;
      const undoOf = { undoOf: event.eventId, reason: 'undo' as const };
      if (event.branches) return this.undoBranches(tx, event, input.actor, undoOf);
      if (event.kind === 'purge' || !event.itemId || !event.after) return { ok: false, reason: 'not-undoable', message: '彻底删除不能撤销' } satisfies Refused;
      const item = tx.state.items.get(event.itemId);
      if (!item) return { ok: false, reason: 'not-found', message: '条目已经不在了' } satisfies Refused;
      if (item.revision !== event.after.revision) return { ok: false, reason: 'conflict', message: '这条记忆之后又被改过，不能直接撤销', current: item } satisfies Conflict;
      switch (event.kind) {
        case 'add': case 'promote': case 'move':
          return item.state === 'active' ? this.setState(tx, item, 'archive', input.actor, undoOf) : { ok: false, reason: 'archived', message: '这条记忆已归档' } satisfies Refused;
        case 'archive': return this.setState(tx, item, 'restore', input.actor, undoOf);
        case 'restore': return this.setState(tx, item, 'archive', input.actor, undoOf);
        default: {
          const before = event.before;
          if (!before) return { ok: false, reason: 'not-undoable', message: '这个事件不能撤销' } satisfies Refused;
          const resolved = resolveBranch(tx.state.branches, before.branch);
          const after: MemoryItem = {
            ...item, text: before.text, branch: resolved.name, trust: before.trust, updatedAt: tx.now, revision: item.revision + 1,
            lastEditedBy: { ...(input.actor.openId ? { actorOpenId: input.actor.openId } : {}), actorRole: input.actor.role, at: tx.now },
          };
          tx.emit({ kind: 'edit', itemId: item.id, before: item, after, actor: input.actor, ...undoOf, ...(resolved.newBranch ? { newBranch: true } : {}) });
          return { ok: true, item: after, branchApplied: resolved.name, ...(resolved.newBranch ? { newBranch: true as const } : {}), usage: this.usageOf(tx.state) };
        }
      }
    });
  }

  private undoBranches(tx: Transaction, event: MemoryEvent, actor: MemoryActor, undoOf: { undoOf: string; reason: 'undo' }): BranchResult {
    const info = event.branches!;
    const stale = info.itemIds.filter(id => tx.state.items.get(id)?.revision !== info.revisions?.[id]);
    if (stale.length) return { ok: false, reason: 'conflict', message: '这批条目之后又被改过，不能整批撤销' };
    if (event.kind === 'branch_rename' && info.to) {
      const current = findBranch(tx.state.branches, info.to);
      const taken = findBranch(tx.state.branches, info.from);
      if (!current || (taken && taken !== current)) return { ok: false, reason: 'conflict', message: '分支名已经变了，不能撤销改名' };
      const items = info.itemIds.map(id => tx.state.items.get(id)!);
      tx.emit({ kind: 'branch_rename', actor, ...undoOf, branches: { from: info.to, to: info.from, itemIds: info.itemIds, revisions: this.revisionsAfter(items) } });
      return { ok: true, branches: orderBranches(tx.state.branches), moved: items.length };
    }
    if (event.kind === 'branch_merge' && info.into && info.entry) {
      const into = findBranch(tx.state.branches, info.into);
      const back = findBranch(tx.state.branches, info.from);
      if (!into) return { ok: false, reason: 'conflict', message: '并入的分支已经不在了，不能撤销合并' };
      if (back || tx.state.branches.length >= 12) return { ok: false, reason: 'conflict', message: `分支「${info.from}」的名字已被占用或分支已满，不能撤销合并` };
      const items = info.itemIds.map(id => tx.state.items.get(id)!);
      tx.emit({ kind: 'branch_unmerge', actor, ...undoOf, branches: { from: info.from, into: into.name, itemIds: info.itemIds, revisions: this.revisionsAfter(items), entry: info.entry } });
      return { ok: true, branches: orderBranches(tx.state.branches), moved: items.length };
    }
    return { ok: false, reason: 'not-undoable', message: '这个事件不能撤销' };
  }

  // -- import (7.1 step B calls it through memory-import.ts) ---------------------------------------------------------

  /**
   * 导入一批条目，一次拿锁、一次写快照。同一个 `importHash` 已经导过（含已被彻底删除的）就跳过；像密钥的、
   * 超长的拒收；有空位的放进去，超出上限的和 `archived` 的按已归档放，所以导入可以超额。
   */
  importItems(entries: readonly ImportEntry[], actor: MemoryActor): Promise<ImportResult> {
    return this.transact(tx => {
      const result: ImportResult = { added: 0, archived: 0, skipped: 0, rejected: 0 };
      for (const entry of entries) {
        const hash = entry.source.importHash;
        const text = entry.text.trim();
        if (hash && tx.state.importedHashes.has(hash)) { result.skipped++; continue; }
        if (this.checkText(text)) { result.rejected++; continue; }
        const archived = entry.archived === true || this.usageOf(tx.state).used >= this.location.limit;
        const resolved = resolveBranch(tx.state.branches, entry.branch);
        const item: MemoryItem = {
          id: this.newItemId(tx.state), scope: this.location.scope, text, branch: resolved.name, state: archived ? 'archived' : 'active',
          trust: entry.trust, source: entry.source, createdAt: tx.now, updatedAt: tx.now, revision: 1,
        };
        tx.emit({ kind: 'add', itemId: item.id, before: null, after: item, actor, ...(resolved.newBranch && !archived ? { newBranch: true } : {}) });
        result.added++;
        if (archived) result.archived++;
      }
      return result;
    });
  }

  // -- export ----------------------------------------------------------------------------------------------------

  /** 一个分支一份 markdown，只含有 active 条目的分支；不带 openId、messageId，也不带来源群 */
  async exportBranches(): Promise<{ branch: string; markdown: string }[]> {
    const { state } = await this.load();
    const files: { branch: string; markdown: string }[] = [];
    for (const branch of orderBranches(state.branches)) {
      const items = [...state.items.values()].filter(item => item.state === 'active' && branchKey(item.branch) === branchKey(branch.name));
      if (!items.length) continue;
      const lines = items.map(item => `- ${item.text.replace(/\r?\n/g, '\n  ')}`);
      files.push({ branch: branch.name, markdown: `# ${branch.name}\n\n${lines.join('\n')}\n` });
    }
    return files;
  }
}

function sameScope(a: MemoryItemScope, b: MemoryItemScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'project' && b.kind === 'project') return a.projectId === b.projectId;
  if (a.kind === 'dm' && b.kind === 'dm') return a.openId === b.openId;
  return true;
}

/**
 * 移层：项目 → Bot（`promoted`，只有主人）、Bot → 项目（`moved`）。两份记忆各有各的互斥，锁序不让同时拿两把，
 * 所以先在目标里加、再归档来源，不是一个原子操作：加成功、归档失败时把目标里刚加的撤掉。
 * 来源里的出处（谁说的、哪个群）原样带过去，`via` 记成 `promoted` / `moved`，`fromItemId` 指回原条目。
 */
export async function transferItem(input: {
  from: MemoryStore; to: MemoryStore; itemId: string; revision: number; via: 'promoted' | 'moved'; branch?: string; actor: MemoryActor;
}): Promise<ItemResult> {
  const item = await input.from.get(input.itemId);
  if (!item) return { ok: false, reason: 'not-found', message: '没有这条记忆' };
  if (item.revision !== input.revision) return { ok: false, reason: 'conflict', message: '这条记忆已经被别处改过了', current: item };
  if (item.state !== 'active') return { ok: false, reason: 'archived', message: '这条记忆已归档' };
  const added = await input.to.add({
    text: item.text, branch: input.branch ?? item.branch, existingOnly: true, actor: input.actor,
    // 主人把它挪进 Bot 记忆，就是主人认可的；挪回项目保持原来的信任
    trust: input.via === 'promoted' ? 'trusted' : item.trust,
    source: { ...item.source, via: input.via, fromItemId: item.id },
    eventKind: input.via === 'promoted' ? 'promote' : 'move',
  });
  if (!added.ok) return added;
  const archived = await input.from.archive({ itemId: item.id, revision: item.revision, actor: input.actor });
  if (archived.ok) return added;
  await input.to.archive({ itemId: added.item.id, revision: added.item.revision, actor: input.actor }).catch((error: unknown) => { void messageOf(error); });
  return archived;
}
