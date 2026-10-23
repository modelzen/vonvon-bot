import { createHash } from 'node:crypto';
import { MEMORY_TEXT_MAX, type MemorySource } from '@vonvon/protocol';
import type { ImportEntry, ImportResult, MemoryStore } from './memory-store';

/**
 * 旧记忆的导入函数（记忆设计 §7.1 步骤 B 的第 2、3、4 步）。P2 只带函数和测试，不接线：host 的迁移（P4a）按行调它。
 * 拆分、哈希去重、旧本群记忆进"背景"、`shared.md` 进"其他"（全部已归档，待主人挑选）。
 */

const LIST_ITEM = /^\s*(?:[-*]\s+|\d+[.)]\s+|\d+、\s*)/;
export const SPLIT_NOTE = '（原文较长，已拆分）';

/** 一段按句号切：每段不超过 `max` 码点，切不开的硬截断。返回的第二项是有没有切过或截过 */
function fitChunk(text: string, max: number): { pieces: string[]; trimmed: boolean } {
  if (Array.from(text).length <= max) return { pieces: [text], trimmed: false };
  const pieces: string[] = [];
  let current = '';
  const push = (): void => { if (current.trim()) pieces.push(current.trim()); current = ''; };
  // sentences keep their closing mark
  const sentences = text.match(/[^。！？!?；;]+(?:[。！？!?；;]+|$)/gu) ?? [text];
  for (const sentence of sentences) {
    if (Array.from(current + sentence).length > max) push();
    if (Array.from(sentence).length > max) {
      pieces.push(Array.from(sentence).slice(0, max).join('').trim());
      continue;
    }
    current += sentence;
  }
  push();
  return { pieces: pieces.filter(Boolean), trimmed: true };
}

/**
 * 按空行分段，再按 `- ` / `* ` / `1. ` 列表项拆；列表项后面缩进的续行并进上一项。每条 ≤ 500 字，超的按句号切，
 * 还超的截断；发生过切或截，第一条前面加"（原文较长，已拆分）"。
 */
export function splitLegacyMemory(text: string): string[] {
  const chunks: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    let list: string[] | undefined;
    let plain: string[] = [];
    const flushPlain = (): void => { if (plain.join('\n').trim()) chunks.push(plain.join('\n').trim()); plain = []; };
    for (const line of paragraph.split('\n')) {
      if (LIST_ITEM.test(line)) { flushPlain(); (list ??= []).push(line.replace(LIST_ITEM, '').trim()); }
      else if (list && /^\s+\S/.test(line)) list[list.length - 1] += ` ${line.trim()}`;
      else if (line.trim()) { if (list) { chunks.push(...list); list = undefined; } plain.push(line); }
    }
    flushPlain();
    if (list) chunks.push(...list);
  }
  let trimmed = false;
  const fitted: string[] = [];
  for (const chunk of chunks.map(chunk => chunk.trim()).filter(Boolean)) {
    const result = fitChunk(chunk, MEMORY_TEXT_MAX);
    trimmed ||= result.trimmed;
    fitted.push(...result.pieces);
  }
  if (trimmed && fitted[0] !== undefined) {
    const head = fitted[0];
    fitted[0] = `${SPLIT_NOTE}${Array.from(head).slice(0, MEMORY_TEXT_MAX - Array.from(SPLIT_NOTE).length).join('')}`;
  }
  return fitted;
}

const hashOf = (importFile: string, text: string): string => createHash('sha256').update(`${importFile}\0${text}`).digest('hex');

interface LegacyInput {
  /** 从哪个旧文件来，写进每条的 `importFile`，侧栏显示 */
  importFile: string;
  text: string;
  botId: string;
}

async function importLegacy(store: MemoryStore, input: LegacyInput, plan: { branch: string; trust: 'trusted' | 'untrusted'; archived: boolean; role: 'desktop' | 'import'; chatId?: string }): Promise<ImportResult> {
  const entries: ImportEntry[] = splitLegacyMemory(input.text).map(text => {
    const source: MemorySource = {
      via: 'import', botId: input.botId, actorRole: plan.role, ...(plan.chatId ? { chatId: plan.chatId } : {}),
      importFile: input.importFile, importHash: hashOf(input.importFile, text),
    };
    return { text, branch: plan.branch, source, trust: plan.trust, archived: plan.archived };
  });
  return store.importItems(entries, { role: plan.role });
}

/**
 * 旧的本群记忆（`profile.memory`）→ 项目记忆的"背景"，桌面端写的所以可信，出处是原来的群；超过上限的按已归档放进去。
 * 群目录里的旧 `memory/group.md` 用同一个函数，`trusted: false`、`role: 'import'`（可能是完全访问档的 agent 写的）。
 */
export function importGroupMemory(store: MemoryStore, input: LegacyInput & { chatId: string; trusted: boolean }): Promise<ImportResult> {
  return importLegacy(store, input, { branch: '背景', trust: input.trusted ? 'trusted' : 'untrusted', archived: false, role: input.trusted ? 'desktop' : 'import', chatId: input.chatId });
}

/** 旧的 bot 级 `memory/shared.md` → Bot 记忆的"其他"，全部已归档、待挑选：里面很可能混着项目细节，不能直接当跨项目的合作方式 */
export function importSharedMemory(store: MemoryStore, input: LegacyInput): Promise<ImportResult> {
  return importLegacy(store, input, { branch: '其他', trust: 'untrusted', archived: true, role: 'import' });
}
