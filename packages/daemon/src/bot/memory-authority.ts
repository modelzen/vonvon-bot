import type { MemoryActorRole, MemoryDowngrade, MemoryItem, MemoryItemScope } from '@vonvon/protocol';

/**
 * 记忆写入的权限表（记忆设计 §3.2）。全是纯函数：输入是 daemon 这一轮知道的事实，输出是放行、降级或拒绝，
 * 模型只能给 `scope` 建议。add / edit / forget / move 共用同一张表，所以放在一处。P2 不接线，工具和隐藏块（P5a）调它。
 */

/** 这一轮的事实，daemon 在 commit guard 里现取（`agent/entry/registry.ts` 的 openTurn facts） */
export interface MemoryTurn {
  kind: 'human' | 'wake' | 'initiative' | 'retry' | 'bot';
  /** 这一轮被插话过（noteSteer） */
  steered: boolean;
  role: 'owner' | 'admin' | 'member' | 'bot';
  /** 触发人；非人触发时没有 */
  openId?: string;
  place: 'group' | 'dm' | 'comment';
  chatId?: string;
  /** 提交时这一轮仍在进行，且就是授权那一轮（`auth.active && grant.turn===auth`） */
  active: boolean;
  /** 触发消息是主人/管理员本人手打的 text/post，不是合并转发、卡片、附件（`typedCandidate`） */
  typed: boolean;
  /** 触发消息正文，已去掉引用、转发、记录块 */
  triggerText?: string;
  /** 这一轮已经写进 Bot 记忆的条数 */
  botWrites: number;
}

export type RequestedScope = 'project' | 'bot' | 'dm' | { project: string };
export interface MemoryPlace {
  /** 本群绑定的项目；私聊里没有 */
  chatProjectId?: string;
  /** 这个 bot 有绑定的全部项目，私聊里指定 `{project}` 时用 */
  botProjectIds?: readonly string[];
}

export type MemoryRefusalReason = 'not-allowed-here' | 'no-project';
/** What the tools and a Bot session's command line say for a refusal of this table (memory-writer, devices-4b 4.5a). */
export const decisionMessages = {
  'not-allowed-here': '这里不能记。',
  'no-project': '这个群还没有绑定项目，记不了。',
  'out-of-scope': '这条记忆不在这里，动不了。',
  'not-yours': '这条记忆不是你记的，动不了。',
} as const;
export type AddDecision =
  | { allow: true; scope: MemoryItemScope; trust: 'trusted' | 'untrusted'; actorRole: MemoryActorRole; actorOpenId?: string; downgraded?: MemoryDowngrade }
  | { allow: false; reason: MemoryRefusalReason };

const isHuman = (turn: MemoryTurn): boolean => turn.kind === 'human' && !turn.steered;
const isManager = (turn: MemoryTurn): boolean => turn.role === 'owner' || turn.role === 'admin';

/** 谁写的、可不可信：主人/管理员亲自说的可信，群友说的待确认，非人触发或被插话的算 bot 自己记的、待确认 */
export function actorOf(turn: MemoryTurn): { actorRole: MemoryActorRole; actorOpenId?: string; trust: 'trusted' | 'untrusted' } {
  if (!isHuman(turn) || turn.role === 'bot') return { actorRole: 'bot', trust: 'untrusted' };
  const actorOpenId = turn.openId;
  return {
    actorRole: turn.role, ...(actorOpenId ? { actorOpenId } : {}),
    trust: isManager(turn) ? 'trusted' : 'untrusted',
  };
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** 汉字等取二元组（单字成段就取单字），ASCII 取词；其他符号不算 */
export function memoryTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  let run: string[] = [];
  const flush = (): void => {
    if (run.length === 1) tokens.add(run[0]!);
    for (let index = 0; index + 1 < run.length; index++) tokens.add(run[index]! + run[index + 1]!);
    run = [];
  };
  for (const part of text.toLowerCase().split(/([a-z0-9]+)/)) {
    if (/^[a-z0-9]+$/.test(part)) { flush(); tokens.add(part); continue; }
    for (const char of part) {
      if (CJK.test(char)) run.push(char);
      else flush();
    }
    flush();
  }
  return tokens;
}

/** 阈值是推的，P5a 用测试样本再定 */
export const IN_MESSAGE_RATIO = 0.5;
/** 条目的二元组 + ASCII 词有 ≥ 50% 出现在触发消息正文里 */
export function textInMessage(entry: string, message: string | undefined): boolean {
  if (!message) return false;
  const wanted = memoryTokens(entry);
  if (!wanted.size) return false;
  const have = memoryTokens(message);
  let hit = 0;
  for (const token of wanted) if (have.has(token)) hit++;
  return hit / wanted.size >= IN_MESSAGE_RATIO;
}

/**
 * 写 Bot 记忆的门：全部满足才放行，返回 undefined；不满足返回第一条没过的原因（记进 `source.downgraded`）。
 * 位置和"这一轮还在进行"由调用方先判（那两条不是降级而是拒绝）。`text` 缺省时不核对出处（删、改分支不带新文本）。
 */
export function botWriteGate(turn: MemoryTurn, text?: string): MemoryDowngrade | undefined {
  if (turn.kind !== 'human') return 'not-human-turn';
  if (turn.steered) return 'steered';
  if (!isManager(turn)) return 'member';
  if (!turn.typed) return 'not-typed';
  if (text !== undefined && !textInMessage(text, turn.triggerText)) return 'not-in-message';
  if (turn.botWrites >= 1) return 'quota';
  return undefined;
}

/** 项目记忆落在哪个项目：显式 `{project}` 必须是本群（私聊：本 bot）绑定的；缺省是本群绑定的项目 */
function targetProject(turn: MemoryTurn, place: MemoryPlace, requested: RequestedScope | undefined): string | MemoryRefusalReason {
  if (typeof requested === 'object') {
    const allowed = turn.place === 'dm' ? (place.botProjectIds ?? []) : place.chatProjectId ? [place.chatProjectId] : [];
    return allowed.includes(requested.project) ? requested.project : 'not-allowed-here';
  }
  if (turn.place === 'group') return place.chatProjectId ?? 'no-project';
  const only = place.botProjectIds?.length === 1 ? place.botProjectIds[0] : undefined;
  return only ?? 'no-project';
}

export interface AddInput {
  turn: MemoryTurn;
  place: MemoryPlace;
  via: 'tool' | 'hidden_block' | 'ui' | 'cli';
  text: string;
  scope?: RequestedScope;
}

/** `memory_add` 和 `<vonvon-remember>` 共用：落到哪一层、谁写的、可不可信。隐藏块永远写不了 Bot 范围 */
export function decideAdd(input: AddInput): AddDecision {
  const { turn, place, via, text } = input;
  if (!turn.active || turn.place === 'comment') return { allow: false, reason: 'not-allowed-here' };
  const who = actorOf(turn);
  const written = { trust: who.trust, actorRole: who.actorRole, ...(who.actorOpenId ? { actorOpenId: who.actorOpenId } : {}) };
  const requested = input.scope;
  if (requested === 'dm') {
    return turn.place === 'dm' && turn.openId ? { allow: true, scope: { kind: 'dm', openId: turn.openId }, ...written } : { allow: false, reason: 'not-allowed-here' };
  }
  let downgraded: MemoryDowngrade | undefined;
  if (requested === 'bot' && via === 'tool') {
    downgraded = botWriteGate(turn, text);
    if (!downgraded) return { allow: true, scope: { kind: 'bot' }, ...written };
  }
  const project = targetProject(turn, place, requested === 'bot' ? undefined : requested);
  if (project === 'no-project' || project === 'not-allowed-here') return { allow: false, reason: project };
  return { allow: true, scope: { kind: 'project', projectId: project }, ...written, ...(downgraded ? { downgraded } : {}) };
}

export type EditDecision =
  | { allow: true; actor: { actorRole: MemoryActorRole; actorOpenId?: string } }
  | { allow: false; reason: 'not-allowed-here' | 'out-of-scope' | 'not-yours'; downgraded?: MemoryDowngrade };

/** 私聊记忆只归私聊里的这个人：读、改、删都只能是本人那一轮 */
export const ownDm = (turn: Pick<MemoryTurn, 'place' | 'openId'>, openId: string): boolean => turn.place === 'dm' && turn.openId === openId;

/** `memory_update` / `memory_forget`；`text` 是新文本（只有改文本时才核对出处） */
export function decideEdit(input: { turn: MemoryTurn; place: MemoryPlace; item: Pick<MemoryItem, 'scope' | 'source'>; text?: string }): EditDecision {
  const { turn, place, item, text } = input;
  if (!turn.active || turn.place === 'comment') return { allow: false, reason: 'not-allowed-here' };
  const who = actorOf(turn);
  const actor = { actorRole: who.actorRole, ...(who.actorOpenId ? { actorOpenId: who.actorOpenId } : {}) };
  const scope = item.scope;
  if (scope.kind === 'bot') {
    const failed = botWriteGate(turn, text);
    return failed ? { allow: false, reason: 'out-of-scope', downgraded: failed } : { allow: true, actor };
  }
  if (scope.kind === 'dm') return ownDm(turn, scope.openId) ? { allow: true, actor } : { allow: false, reason: 'out-of-scope' };
  const bound = turn.place === 'dm' ? (place.botProjectIds ?? []) : place.chatProjectId ? [place.chatProjectId] : [];
  if (!bound.includes(scope.projectId)) return { allow: false, reason: 'out-of-scope' };
  if (isHuman(turn) && isManager(turn)) return { allow: true, actor };
  const botOfThisChat = item.source.actorRole === 'bot' && item.source.chatId !== undefined && item.source.chatId === turn.chatId;
  if (isHuman(turn) && turn.role === 'member' && turn.openId !== undefined && item.source.actorOpenId === turn.openId) return { allow: true, actor };
  return botOfThisChat ? { allow: true, actor } : { allow: false, reason: 'not-yours' };
}

/** 腾位候选只列 bot 自记和导入的，人写的不列（§3.2 表最后一行） */
export const isMakeRoomCandidate = (item: Pick<MemoryItem, 'source' | 'state'>): boolean =>
  item.state === 'active' && (item.source.actorRole === 'bot' || item.source.via === 'import');

/** 移层：只有主人，只在桌面端（§3.1），所以这里只看调用方是不是桌面端 */
export const canMoveLayer = (actor: { role: MemoryActorRole }): boolean => actor.role === 'desktop';
/** 点成可信：同样只有主人在桌面端 */
export const canConfirmTrust = canMoveLayer;
