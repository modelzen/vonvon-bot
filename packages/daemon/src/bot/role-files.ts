import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { botPaths } from '../config/paths';
import { log } from '../core/logger';
import { holdMemoryDirectory } from '../project/library';
import { createPersonalityFiles, PERSONALITY_SAFETY_BYTES, type PersonalityFile, type PersonalityFiles } from './personality-files';

/**
 * 角色设定（记忆设计 2.3）：`SOUL.md` 里的两段，身份与职责、其他说明。没有单独的"规矩"（D6），
 * `bots/<appId>/AGENTS.md` 迁移（步骤 R）以后不再读写。这里也是这个 bot 目录下 `SOUL.md` 的唯一写入口，
 * 旧读法要写它时也走 {@link withBotFiles}，同一把锁。
 */

export const IDENTITY_HEADING = '## 身份与职责';
export const NOTES_HEADING = '## 其他说明';
/** 身份与职责，保存时强制；身份行和决策模型都用这一段整段。 */
export const IDENTITY_MAX = 500;
/** 其他说明、以及每一段写入时的上限；总和另限。UTF-8 另受 PERSONALITY_SAFETY_BYTES 限制。 */
export const SECTION_MAX = 8_000;
export const TOTAL_MAX = 20_000;

export interface RoleText { identity: string; notes: string }
export interface ParsedRole extends RoleText {
  /** `SOUL.md` 里有没有这两个标题之一；没有就是旧文件，整份当其他说明 */
  headed: boolean;
}

const characters = (value: string): number => [...value].length;
const FENCE = /^\s*(```|~~~)/;
const edgeBlank = (value: string): string => value.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');

/**
 * 按两个标题拆 `SOUL.md`。标题只认单独一行，代码块里的不算；别的 `##` 行是它所在那段的正文。
 * 第一个标题前面的文字并到其他说明最前面，保存时不丢。没有任何标题：原文原样是其他说明。
 */
export function parseRole(soul: string): ParsedRole {
  const lines = soul.split('\n');
  let section: 'pre' | 'identity' | 'notes' = 'pre';
  let seen = false;
  let fenced = false;
  const used = { identity: false, notes: false };
  const body: Record<'pre' | 'identity' | 'notes', string[]> = { pre: [], identity: [], notes: [] };
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = line.trimEnd();
    if (!fenced && heading === IDENTITY_HEADING && !used.identity) { section = 'identity'; used.identity = seen = true; continue; }
    if (!fenced && heading === NOTES_HEADING && !used.notes) { section = 'notes'; used.notes = seen = true; continue; }
    body[section].push(line);
  }
  if (!seen) return { identity: '', notes: soul, headed: false };
  const pre = edgeBlank(body.pre.join('\n'));
  const notes = edgeBlank(body.notes.join('\n'));
  return { identity: edgeBlank(body.identity.join('\n')), notes: [pre, notes].filter(Boolean).join('\n\n'), headed: true };
}

/** 带两个标题的 `SOUL.md`；两段都为空也写标题，下次读回来还是空。 */
export function composeRole(role: RoleText): string {
  return `${IDENTITY_HEADING}\n${edgeBlank(role.identity)}\n\n${NOTES_HEADING}\n${edgeBlank(role.notes)}\n`;
}

const headingLine = (value: string): boolean => value.split('\n').some(line => { const text = line.trimEnd(); return text === IDENTITY_HEADING || text === NOTES_HEADING; });

/**
 * 保存前的检查，返回要告诉主人的话。超长的旧文件能读、能显示，只对这次改动了的那一段执行上限：
 * 主人第一次编辑时才要求精简（2.3）。
 */
export function roleProblem(next: RoleText, previous?: RoleText): string | undefined {
  for (const value of [next.identity, next.notes]) {
    if (headingLine(value)) return `内容里不能有单独一行「${IDENTITY_HEADING}」或「${NOTES_HEADING}」，它们是两段的分界`;
    if (Buffer.from(value).toString('utf8') !== value) return '内容里有无法保存的字符';
  }
  const identityChanged = next.identity !== previous?.identity;
  const notesChanged = next.notes !== previous?.notes;
  if (identityChanged && characters(next.identity) > IDENTITY_MAX) return `身份与职责最多 ${IDENTITY_MAX} 字，现在 ${characters(next.identity)} 字`;
  if (notesChanged && characters(next.notes) > SECTION_MAX) return `其他说明最多 ${SECTION_MAX} 字，现在 ${characters(next.notes)} 字`;
  if ((identityChanged || notesChanged) && characters(next.identity) + characters(next.notes) > TOTAL_MAX) return `两段加起来最多 ${TOTAL_MAX} 字`;
  if (Buffer.byteLength(composeRole(next)) > PERSONALITY_SAFETY_BYTES) return '角色设定太长，请精简';
  return undefined;
}

/** 新 bot 的"身份与职责"草稿，只用飞书应用名；只在编辑器里显示，主人点保存才写进文件（2.3）。 */
export function roleDraft(botName: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const name = (botName ?? '').replace(/[\u0000-\u001f\u007f-\u009f「」]/g, ' ').replace(/\s+/g, ' ').trim();
  return name ? `我是「${[...name].slice(0, 60).join('')}」，团队里的 AI 助手。我负责：` : '';
}

// ---- 文件和锁 ----

const MAX_CHARACTERS = PERSONALITY_SAFETY_BYTES;
const chains = new Map<string, Promise<unknown>>();

/** `bots/<appId>/`, from the bot's explicit paths (never the process-global ones). */
export function botRoot(appId: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(appId)) throw new Error('无效 Bot 标识');
  const paths = botPaths(appId);
  return paths.dir ?? dirname(paths.configFile);
}
/** The personality files of one bot's directory; undefined when the directory is not there (and `create` is off). */
export async function botFiles(appId: string, create = false): Promise<PersonalityFiles | undefined> {
  const root = botRoot(appId);
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Bot 个性目录不是安全目录');
  // The size policy is enforced here (limits above), not by the file layer: a merged legacy file may exceed it.
  return createPersonalityFiles(await realpath(root), { maxCharacters: MAX_CHARACTERS, execution: 'daemon-exclusive' });
}
export async function readText(files: PersonalityFiles | undefined, target: PersonalityFile): Promise<string> {
  if (!files) return '';
  const read = await files.read(target);
  if (read.kind === 'error') throw new Error(`无法读取个性与记忆：${read.file}（${read.reason}）`);
  return read.kind === 'present' ? read.snapshot.content : '';
}
/** Waits for the earlier operation on this bot (in this process), then holds its `memory` mutex (other processes). */
export async function waitForBotFiles(appId: string): Promise<void> { await chains.get(appId)?.catch(() => undefined); }
export function withBotFiles<T>(appId: string, operation: () => Promise<T>): Promise<T> {
  const root = botRoot(appId);
  const previous = chains.get(appId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => holdMemoryDirectory(root, operation));
  chains.set(appId, run);
  return run.finally(() => { if (chains.get(appId) === run) chains.delete(appId); });
}

// ---- memory/ 下的小文件：完整性、迁移标记、角色事件 ----

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

async function memoryDir(appId: string, create: boolean): Promise<string | undefined> {
  const dir = join(await realpath(botRoot(appId)), 'memory');
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('memory 目录不是安全目录');
  return dir;
}
async function readState(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error('状态文件无效');
      text = await file.readFile('utf8');
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('状态文件格式无效');
  return parsed;
}
/** tmp + rename, other keys of the file (another slice's) kept. */
async function patchState(path: string, change: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const next = { ...change(await readState(path)), version: 1 };
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(tmp, path);
  } catch (error) { await unlink(tmp).catch(() => undefined); throw error; }
}
/** Records the hash of a `SOUL.md` this daemon just wrote (integrity.json). */
export async function recordSoulHash(appId: string, content: string): Promise<void> {
  const dir = (await memoryDir(appId, true))!;
  await patchState(join(dir, 'integrity.json'), current => ({
    ...current, files: { ...(isRecord(current.files) ? current.files : {}), 'SOUL.md': { sha256: sha256(content), at: Date.now() } },
  }));
}

export type RoleActor = { role: 'desktop' | 'cli' | 'import'; openId?: string };
/** 事件的形状照 2.4（store 'b'），自己的文件，P2 的条目库合起来以后再并。 */
interface RoleEvent {
  eventId: string; at: number; kind: 'role_edit' | 'role_import';
  before: RoleText | null; after: RoleText;
  actor: { actorRole: RoleActor['role']; actorOpenId?: string };
  reason?: string;
}
async function appendEvent(appId: string, event: Omit<RoleEvent, 'eventId' | 'at'>): Promise<void> {
  const dir = (await memoryDir(appId, true))!;
  const full: RoleEvent = { eventId: `b:e_${randomUUID().replace(/-/g, '').slice(0, 12)}`, at: Date.now(), ...event };
  const file = await open(join(dir, 'role-events.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(`${JSON.stringify(full)}\n`, 'utf8'); await file.sync(); } finally { await file.close(); }
}
/** The file is the truth and the event only its history: a failed append is logged, never fails a committed save. */
async function recordChange(appId: string, content: string, event: Omit<RoleEvent, 'eventId' | 'at'>): Promise<void> {
  try { await appendEvent(appId, event); }
  catch (error) { log.fail('role', error, { phase: 'event', botId: appId }); }
  await recordSoulHash(appId, content);
}

// ---- 读写 ----

export type RoleIntegrity = 'ok' | 'untracked' | 'changed';
export interface RoleView extends ParsedRole {
  /** 旧文件或合并来的文字超过写入上限：能打开，提示精简 */
  oversized: boolean;
  /** `SOUL.md` 和 daemon 上次写完记下的 hash 对不对得上（只是告警，2.3） */
  integrity: RoleIntegrity;
  /** 步骤 R 把旧 AGENTS.md 并进了其他说明，编辑器要提示（主人第一次保存后不再提示） */
  mergedNotice: boolean;
}

async function integrityOf(appId: string, content: string | undefined): Promise<RoleIntegrity> {
  const dir = await memoryDir(appId, false);
  const files = dir ? (await readState(join(dir, 'integrity.json'))).files : undefined;
  const entry = isRecord(files) && isRecord(files['SOUL.md']) ? files['SOUL.md'].sha256 : undefined;
  if (typeof entry !== 'string') return 'untracked';
  return content !== undefined && sha256(content) === entry ? 'ok' : 'changed';
}
async function roleState(appId: string): Promise<Record<string, unknown>> {
  const dir = await memoryDir(appId, false);
  const role = dir ? (await readState(join(dir, 'import-state.json'))).role : undefined;
  return isRecord(role) ? role : {};
}
function describe(soul: string): Pick<RoleView, keyof ParsedRole | 'oversized'> {
  const parsed = parseRole(soul);
  return { ...parsed, oversized: characters(parsed.identity) > IDENTITY_MAX || characters(parsed.notes) > SECTION_MAX || characters(parsed.identity) + characters(parsed.notes) > TOTAL_MAX };
}

export async function readRole(appId: string): Promise<RoleView> {
  await waitForBotFiles(appId);
  const files = await botFiles(appId);
  const read = await files?.read({ kind: 'bot-soul' });
  if (read?.kind === 'error') throw new Error(`无法读取个性与记忆：${read.file}（${read.reason}）`);
  const content = read?.kind === 'present' ? read.snapshot.content : undefined;
  const state = files ? await roleState(appId) : {};
  return {
    ...describe(content ?? ''),
    integrity: files ? await integrityOf(appId, content) : 'untracked',
    mergedNotice: state.merged === true && state.noticed !== true,
  };
}

/** The whole `SOUL.md`, as the old readers take it; never AGENTS.md. */
export async function readSoulText(appId: string): Promise<string> { return readText(await botFiles(appId), { kind: 'bot-soul' }); }

/**
 * 读—检查—写，同一把锁。`update` 拿到现在的两段、给出新的两段；`beforeCommit` 在落盘前调用（版本核对、过期检查）。
 * 写完记 hash 和事件。内容没变就不写。
 */
export function updateRole(
  appId: string,
  update: (current: RoleText) => RoleText | Promise<RoleText>,
  options: { beforeCommit?: () => void; actor?: RoleActor } = {},
): Promise<RoleView> {
  return withBotFiles(appId, async () => {
    const files = (await botFiles(appId, true))!;
    const old = await readText(files, { kind: 'bot-soul' });
    const current = parseRole(old);
    const next = await update({ identity: current.identity, notes: current.notes });
    const problem = roleProblem(next, current);
    if (problem) throw new Error(problem);
    const content = composeRole(next);
    options.beforeCommit?.();
    if (content !== old) {
      const result = await files.write({ kind: 'bot-soul' }, content);
      if (result.kind !== 'committed') throw new Error(`无法保存个性与记忆：${result.reason}`);
      const actor = options.actor ?? { role: 'desktop' };
      await recordChange(appId, content, {
        kind: 'role_edit', before: { identity: current.identity, notes: current.notes }, after: next,
        actor: { actorRole: actor.role, ...(actor.openId ? { actorOpenId: actor.openId } : {}) },
      });
    }
    const dir = (await memoryDir(appId, true))!;
    const state = await roleState(appId);
    if (state.merged === true && state.noticed !== true) {
      await patchState(join(dir, 'import-state.json'), all => ({ ...all, role: { ...(isRecord(all.role) ? all.role : {}), noticed: true } }));
    }
    return { ...describe(content), integrity: 'ok', mergedNotice: false };
  });
}

// ---- 迁移步骤 R（7.1） ----

export type RoleMigration = 'marked' | 'empty' | 'merged' | 'already-in';
const squash = (value: string): string => value.replace(/\s+/g, '');

async function backup(dir: string, name: 'SOUL.md' | 'AGENTS.md', content: string): Promise<void> {
  const originals = join(dir, 'originals');
  await mkdir(originals, { recursive: true, mode: 0o700 });
  const stat = await lstat(originals);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('originals 目录不是安全目录');
  try {
    const file = await open(join(originals, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

/**
 * 步骤 R：`bots/<appId>/AGENTS.md` 里有、`SOUL.md` 里没有的内容，一次性并进其他说明末尾，原样备份到
 * `memory/originals/`，把 AGENTS.md 清空，写标记。标记在 `memory/import-state.json` 的 `role`；每一步都能被杀了重来：
 * 备份不覆盖，已经并进去的不再加，清空和写标记重复做无妨。有标记的 bot 不读 AGENTS.md。
 */
export function migrateRoleFiles(appId: string): Promise<RoleMigration> {
  return withBotFiles(appId, async () => {
    const files = (await botFiles(appId, true))!;
    const dir = (await memoryDir(appId, true))!;
    const statePath = join(dir, 'import-state.json');
    if (typeof (await roleState(appId)).at === 'number') return 'marked';
    const agents = await readText(files, { kind: 'bot-agents' });
    const mark = (merged: boolean) => patchState(statePath, current => ({ ...current, role: { at: Date.now(), merged } }));
    if (!agents.trim()) {
      // 被杀在清空之后、写标记之前：备份还在，就是并过的。
      const kept = await backupText(dir, 'AGENTS.md');
      await mark(Boolean(kept?.trim()));
      return kept?.trim() ? 'merged' : 'empty';
    }
    const soul = await readText(files, { kind: 'bot-soul' });
    await backup(dir, 'SOUL.md', soul);
    await backup(dir, 'AGENTS.md', agents);
    let outcome: RoleMigration = 'already-in';
    if (!squash(soul).includes(squash(agents))) {
      const parsed = parseRole(soul);
      const addition = agents.trim();
      const merged = !soul.trim() ? addition
        : parsed.headed ? composeRole({ identity: parsed.identity, notes: [parsed.notes, addition].filter(Boolean).join('\n\n') })
        : `${soul.replace(/\s+$/, '')}\n\n${addition}\n`;
      const written = await files.write({ kind: 'bot-soul' }, merged);
      if (written.kind !== 'committed') throw new Error(`无法保存个性与记忆：${written.reason}`);
      await recordChange(appId, merged, { kind: 'role_import', before: { identity: parsed.identity, notes: parsed.notes }, after: parseRole(merged), actor: { actorRole: 'import' }, reason: 'AGENTS.md 并入其他说明' });
      outcome = 'merged';
    }
    const cleared = await files.write({ kind: 'bot-agents' }, '');
    if (cleared.kind !== 'committed') throw new Error(`无法清空 AGENTS.md：${cleared.reason}`);
    await mark(true);
    return outcome;
  });
}

async function backupText(dir: string, name: string): Promise<string | undefined> {
  try {
    const file = await open(join(dir, 'originals', name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { return await file.readFile('utf8'); } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
