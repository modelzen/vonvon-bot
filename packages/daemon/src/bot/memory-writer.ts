import { MEMORY_TEXT_MAX, type MemoryItem, type MemoryItemScope } from '@vonvon/protocol';
import { log } from '../core/logger';
import { botDir } from '../config/paths';
import { libraryLocation, isProjectId, type LibraryLocation } from '../project/library';
import { decideAdd, decideEdit, decisionMessages, type AddDecision, type MemoryPlace, type MemoryTurn, type RequestedScope } from './memory-authority';
import { normalizeBranchName } from './memory-branches';
import { findSecretShape } from './memory-secret-shape';
import type { FoundBlocks } from './hidden-blocks';
import { reportLatestAction } from './diagnostics';
import { botMemoryLocation, MemoryStore, projectMemoryLocation, type ItemResult, type MemoryActor, type Refused } from './memory-store';

/**
 * 记忆写入的执行层（记忆设计 §3.2、§3.3、§3.4）：memory 工具和隐藏块共用。权限表在 `memory-authority.ts`，条目库在
 * `memory-store.ts`，这里把"这一轮的事实 → 判 → 落到哪份记忆 → 写"串起来，并在提交点前把判断再做一遍
 * （commit guard 里现取，不用开轮时的快照）：两次不一样就按新的重来，所以插话、轮次结束都挡得住。
 */

export interface MemoryWriterDeps {
  botId: string;
  /** `bots/<appId>/`，Bot 记忆放在它下面 */
  botDirectory?: string;
  /** 这个群绑定的项目 id；没有（旧绑定行还没迁移）返回 undefined */
  projectIdOf(chatId: string): Promise<string | undefined>;
  /** 私聊里指定 `{project}` 时用：本 bot 有绑定的全部项目（私聊 agent 到 s49 才有） */
  botProjectIds?(): Promise<readonly string[]>;
  library?: LibraryLocation;
  /** 测试用：条数上限 */
  limits?: { project?: number; bot?: number };
  now?: () => number;
}

/** 一次写入要的、随这一轮变的东西 */
export interface WriteContext {
  /** 这一轮对记忆的事实，每次现取；undefined 是入口已经没了 */
  turn(): MemoryTurn | undefined;
  triggerMessageId?: string;
  /** 工具路径：registry 的 commit guard，提交点前同步调，抛错就不写 */
  guard?: () => void;
  reserveBotWrite?(): boolean;
  releaseBotWrite?(): void;
}

export interface AddArgs { text: string; branch?: string; scope?: RequestedScope; claim?: 'asked' | 'self'; why?: string }
export interface EditArgs { id: string; text?: string; branch?: string; why?: string }

export interface ItemView { id: string; scope: 'project' | 'bot' | 'dm'; text: string; branch: string }
export type AddOutcome =
  | { ok: true; item: ItemView; scopeApplied: 'project' | 'bot' | 'dm'; branchApplied: string; newBranch?: true; downgraded?: NonNullable<Extract<AddDecision, { allow: true }>['downgraded']>; usage: { used: number; limit: number } }
  | { ok: false; error: 'memory-full'; message: string; candidates: Array<Pick<ItemView, 'id' | 'text' | 'branch'>>; usage?: { used: number; limit: number } }
  | { ok: false; error: 'refused'; reason: 'not-allowed-here' | 'no-project' | 'looks-like-secret' | 'duplicate'; message: string }
  | { ok: false; error: 'bad-args'; message: string };
export type EditOutcome =
  | { ok: true; item: ItemView; branchApplied: string; newBranch?: true; usage: { used: number; limit: number } }
  | { ok: false; error: 'not-found' | 'out-of-scope' | 'not-yours' | 'archived' | 'conflict' | 'bad-args' | 'refused'; message: string; current?: Pick<ItemView, 'id' | 'text' | 'branch'> };

export interface ListedMemory {
  scope: 'project' | 'bot';
  projectId?: string;
  branches: string[];
  items: Array<{ id: string; text: string; branch: string; trust: 'trusted' | 'untrusted' }>;
  usage: { used: number; limit: number };
}

/** 提交点前轮次已经结束（隐藏块路径；工具路径是 registry 的 ToolRefusal） */
export class TurnEnded extends Error { constructor() { super('这一轮已经结束'); } }
/** 提交点前重判的结果和开始时的不一样，按新的结果重来 */
class Redecide extends Error {}

const MESSAGES = {
  'not-allowed-here': decisionMessages['not-allowed-here'],
  'no-project': decisionMessages['no-project'],
  'looks-like-secret': '像密钥，没记。',
  duplicate: '已经记着了。',
} as const;
const cleanWhy = (why: string | undefined): string | undefined => {
  const text = why?.replace(/\s+/g, ' ').trim();
  // 像密钥的理由整句丢掉：why 会进 memory.json 和 events.jsonl
  return text && !findSecretShape(text) ? Array.from(text).slice(0, 200).join('') : undefined;
};

const sameDecision = (a: AddDecision, b: AddDecision): boolean => JSON.stringify(a) === JSON.stringify(b);
const scopeName = (scope: MemoryItemScope): 'project' | 'bot' | 'dm' => scope.kind;
const viewOf = (item: MemoryItem): ItemView => ({ id: item.id, scope: scopeName(item.scope), text: item.text, branch: item.branch });

/** 条目 id 是 `<store>:<6 位>`，store = `p_<projectId>` | `b` | `d_<openId>` */
function scopeOfId(id: string): MemoryItemScope | undefined {
  const cut = id.lastIndexOf(':');
  if (cut <= 0) return undefined;
  const store = id.slice(0, cut);
  if (store === 'b') return { kind: 'bot' };
  if (store.startsWith('p_') && isProjectId(store.slice(2))) return { kind: 'project', projectId: store.slice(2) };
  if (store.startsWith('d_') && /^[A-Za-z0-9_-]{1,100}$/.test(store.slice(2))) return { kind: 'dm', openId: store.slice(2) };
  return undefined;
}

export interface MemoryWriter {
  add(ctx: WriteContext, args: AddArgs, via: 'tool' | 'hidden_block'): Promise<AddOutcome>;
  update(ctx: WriteContext, args: EditArgs): Promise<EditOutcome>;
  forget(ctx: WriteContext, args: Omit<EditArgs, 'text' | 'branch'>): Promise<EditOutcome>;
  list(place: { kind: 'group' | 'p2p' | 'doc'; chatId?: string }, scope?: 'project' | 'bot' | { project: string }): Promise<{ lists: ListedMemory[] } | { error: 'refused'; message: string }>;
  /** 这一轮在哪：本群绑定的项目（私聊里是本 bot 的项目）。Bot 会话的命令行写记忆时按同一个落点判（devices-4b 4.5） */
  placeOf(turn: Pick<MemoryTurn, 'chatId' | 'place'>): Promise<MemoryPlace>;
  /** 终态解析：这一轮最后一条消息里的隐藏块，逐条写。返回写成几条和没记上的原因 */
  applyBlocks(input: { found: FoundBlocks; nonce: string; ctx: WriteContext }): Promise<{ written: number; missed: string[] }>;
}

export function createMemoryWriter(deps: MemoryWriterDeps): MemoryWriter {
  const library = deps.library ?? libraryLocation();
  const storeOptions = deps.now ? { now: deps.now } : {};
  const botDirectory = deps.botDirectory ?? botDir(deps.botId);
  const stores = new Map<string, MemoryStore>();
  function storeFor(scope: MemoryItemScope): MemoryStore {
    if (scope.kind === 'dm') throw new Error('私聊记忆还没有入口');
    const key = scope.kind === 'bot' ? 'b' : scope.projectId;
    let store = stores.get(key);
    if (!store) {
      store = new MemoryStore(scope.kind === 'bot'
        ? botMemoryLocation(botDirectory, deps.limits?.bot ? { limit: deps.limits.bot } : {})
        : projectMemoryLocation(scope.projectId, { library, ...(deps.limits?.project ? { limit: deps.limits.project } : {}) }), storeOptions);
      stores.set(key, store);
    }
    return store;
  }
  async function placeOf(turn: Pick<MemoryTurn, 'chatId' | 'place'>): Promise<MemoryPlace> {
    const chatProjectId = turn.chatId ? await deps.projectIdOf(turn.chatId) : undefined;
    const botProjectIds = turn.place === 'dm' ? await deps.botProjectIds?.() : undefined;
    return { ...(chatProjectId ? { chatProjectId } : {}), ...(botProjectIds ? { botProjectIds } : {}) };
  }
  const bound = (turn: MemoryTurn, place: MemoryPlace): readonly string[] =>
    turn.place === 'dm' ? (place.botProjectIds ?? []) : place.chatProjectId ? [place.chatProjectId] : [];
  const actorOf = (decision: { actorRole: MemoryActor['role']; actorOpenId?: string }): MemoryActor => ({ role: decision.actorRole, ...(decision.actorOpenId ? { openId: decision.actorOpenId } : {}) });
  const candidatesOf = (refused: Refused): Array<Pick<ItemView, 'id' | 'text' | 'branch'>> => (refused.candidates ?? []).map(item => ({ id: item.id, text: item.text, branch: item.branch }));

  function failedAdd(result: Refused): AddOutcome {
    switch (result.reason) {
      case 'memory-full': return { ok: false, error: 'memory-full', message: result.message, candidates: candidatesOf(result), ...(result.usage ? { usage: result.usage } : {}) };
      case 'looks-like-secret': case 'duplicate': return { ok: false, error: 'refused', reason: result.reason, message: MESSAGES[result.reason] };
      default: return { ok: false, error: 'bad-args', message: result.message };
    }
  }

  async function add(ctx: WriteContext, args: AddArgs, via: 'tool' | 'hidden_block'): Promise<AddOutcome> {
    const text = args.text.trim();
    // 隐藏块的 `scope` 属性不当范围用：它永远写不了 Bot 范围，也不能指定别的项目
    const requested = via === 'tool' ? args.scope : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const turn = ctx.turn();
      if (!turn) return { ok: false, error: 'refused', reason: 'not-allowed-here', message: MESSAGES['not-allowed-here'] };
      const place = await placeOf(turn);
      const input = (from: MemoryTurn) => ({ turn: from, place, via, text, ...(requested !== undefined ? { scope: requested } : {}) });
      let decision = decideAdd(input(turn));
      if (!decision.allow) return { ok: false, error: 'refused', reason: decision.reason, message: MESSAGES[decision.reason] };
      let reserved = false;
      if (decision.scope.kind === 'bot') {
        reserved = ctx.reserveBotWrite?.() ?? true;
        // 名额被这一轮另一条占了：按"一轮一条"降到项目
        if (!reserved) decision = decideAdd(input({ ...turn, botWrites: Math.max(1, turn.botWrites) }));
        if (!decision.allow) return { ok: false, error: 'refused', reason: decision.reason, message: MESSAGES[decision.reason] };
      }
      const chosen = decision;
      let succeeded = false;
      try {
        const result = await storeFor(chosen.scope).add({
          text, ...(args.branch !== undefined ? { branch: args.branch } : {}),
          trust: chosen.trust, actor: actorOf(chosen),
          source: {
            via, botId: deps.botId, turn: { kind: turn.kind, steered: turn.steered },
            actorRole: chosen.actorRole, ...(chosen.actorOpenId ? { actorOpenId: chosen.actorOpenId } : {}),
            ...(turn.chatId ? { chatId: turn.chatId } : {}), ...(ctx.triggerMessageId ? { messageId: ctx.triggerMessageId } : {}),
            ...(args.claim ? { claim: args.claim } : {}), ...(cleanWhy(args.why) ? { why: cleanWhy(args.why) } : {}),
            ...(chosen.downgraded ? { downgraded: chosen.downgraded } : {}),
          },
          beforeCommit: () => {
            const fresh = ctx.turn();
            if (!fresh?.active) { ctx.guard?.(); throw new TurnEnded(); }
            const again = decideAdd(input({ ...fresh, botWrites: fresh.botWrites - (reserved ? 1 : 0) }));
            if (!sameDecision(again, chosen)) throw new Redecide();
            ctx.guard?.();
          },
        });
        if (!result.ok) return failedAdd(result as Refused);
        succeeded = true;
        // Both tool and hidden-block additions reach this committed result.
        // Duplicates, refusals and failed writes never announce a new memory.
        if (turn.place === 'group' && turn.chatId) reportLatestAction(turn.chatId, 'memory-saved', (deps.now ?? Date.now)());
        return {
          ok: true, item: viewOf(result.item), scopeApplied: scopeName(chosen.scope), branchApplied: result.branchApplied,
          ...(result.newBranch ? { newBranch: true as const } : {}), ...(chosen.downgraded ? { downgraded: chosen.downgraded } : {}), usage: result.usage,
        };
      } catch (error) {
        if (!(error instanceof Redecide)) throw error;
      } finally {
        if (reserved && !succeeded) ctx.releaseBotWrite?.();
      }
    }
    return { ok: false, error: 'refused', reason: 'not-allowed-here', message: MESSAGES['not-allowed-here'] };
  }

  const editMessage = {
    'not-found': '没有这条记忆。', 'out-of-scope': decisionMessages['out-of-scope'], 'not-yours': decisionMessages['not-yours'],
    archived: '这条记忆已经归档了。', conflict: '这条记忆刚被别处改过，先看看现在的内容。', 'bad-args': '没有要改的内容，或内容不合要求。',
    refused: '这里不能改。',
  } as const;
  const failedEdit = (error: keyof typeof editMessage, current?: MemoryItem): EditOutcome =>
    ({ ok: false, error, message: editMessage[error], ...(current ? { current: { id: current.id, text: current.text, branch: current.branch } } : {}) });

  async function editLike(ctx: WriteContext, args: { id: string; text?: string; branch?: string }, kind: 'update' | 'forget'): Promise<EditOutcome> {
    const scope = scopeOfId(args.id);
    if (!scope) return failedEdit('not-found');
    for (let attempt = 0; attempt < 3; attempt++) {
      const turn = ctx.turn();
      if (!turn) return failedEdit('refused');
      const place = await placeOf(turn);
      // 不在本群绑定里的项目、别人的私聊记忆：不读它，不让人靠回答探出它在不在
      if (scope.kind === 'project' && !bound(turn, place).includes(scope.projectId)) return failedEdit('out-of-scope');
      if (scope.kind === 'dm') return failedEdit('out-of-scope');
      if (turn.place === 'comment') return failedEdit('refused');
      const store = storeFor(scope);
      const item = await store.get(args.id);
      if (!item) return failedEdit('not-found');
      if (item.state === 'archived') return failedEdit('archived');
      const input = (from: MemoryTurn) => ({ turn: from, place, item, ...(args.text !== undefined ? { text: args.text } : {}) });
      const decision = decideEdit(input(turn));
      if (!decision.allow) return failedEdit(decision.reason === 'not-allowed-here' ? 'refused' : decision.reason);
      const onBot = item.scope.kind === 'bot';
      let reserved = false;
      if (onBot) {
        reserved = ctx.reserveBotWrite?.() ?? true;
        if (!reserved) return failedEdit('out-of-scope');
      }
      let succeeded = false;
      try {
        const actor = actorOf({ actorRole: decision.actor.actorRole, ...(decision.actor.actorOpenId ? { actorOpenId: decision.actor.actorOpenId } : {}) });
        const beforeCommit = (): void => {
          const fresh = ctx.turn();
          if (!fresh?.active) { ctx.guard?.(); throw new TurnEnded(); }
          const again = decideEdit(input({ ...fresh, botWrites: fresh.botWrites - (reserved ? 1 : 0) }));
          if (JSON.stringify(again) !== JSON.stringify(decision)) throw new Redecide();
          ctx.guard?.();
        };
        const result: ItemResult = kind === 'forget'
          ? await store.archive({ itemId: item.id, revision: item.revision, actor, beforeCommit })
          : await store.edit({ itemId: item.id, revision: item.revision, actor, beforeCommit, ...(args.text !== undefined ? { text: args.text } : {}), ...(args.branch !== undefined ? { branch: args.branch } : {}) });
        if (!result.ok) {
          if (result.reason === 'conflict') return failedEdit('conflict', 'current' in result ? result.current : undefined);
          if (result.reason === 'not-found' || result.reason === 'archived') return failedEdit(result.reason);
          if (result.reason === 'memory-full') return failedEdit('refused');
          return failedEdit('bad-args');
        }
        succeeded = true;
        return { ok: true, item: viewOf(result.item), branchApplied: result.branchApplied, ...(result.newBranch ? { newBranch: true as const } : {}), usage: result.usage };
      } catch (error) {
        if (!(error instanceof Redecide)) throw error;
      } finally {
        if (reserved && !succeeded) ctx.releaseBotWrite?.();
      }
    }
    return failedEdit('refused');
  }

  async function listOne(scope: MemoryItemScope, only?: string): Promise<ListedMemory> {
    const view = await storeFor(scope).read();
    const keep = only === undefined ? undefined : normalizeBranchName(only);
    const items = view.items.filter(item => item.state === 'active' && (keep === undefined || normalizeBranchName(item.branch) === keep));
    return {
      scope: scope.kind === 'bot' ? 'bot' : 'project', ...(scope.kind === 'project' ? { projectId: scope.projectId } : {}),
      branches: view.branches.map(branch => branch.name).filter(name => keep === undefined || normalizeBranchName(name) === keep),
      items: items.map(item => ({ id: item.id, text: item.text, branch: item.branch, trust: item.trust })),
      usage: { used: view.used, limit: view.limit },
    };
  }

  return {
    add,
    placeOf,
    update: (ctx, args) => editLike(ctx, args, 'update'),
    forget: (ctx, args) => editLike(ctx, args, 'forget'),
    async list(place, scope) {
      // 评论的回复挂在文档里所有读者可见：只给 Bot 记忆的"合作方式"，`scope` 参数忽略，别的分支名也不露
      if (place.kind === 'doc') return { lists: [await listOne({ kind: 'bot' }, '合作方式')] };
      const projectId = place.chatId ? await deps.projectIdOf(place.chatId) : undefined;
      if (typeof scope === 'object') {
        if (scope.project !== projectId) return { error: 'refused', message: '这个项目不在这里，看不了。' };
        return { lists: [await listOne({ kind: 'project', projectId: scope.project })] };
      }
      const lists: ListedMemory[] = [];
      if ((scope === undefined || scope === 'project') && place.kind === 'group' && projectId) lists.push(await listOne({ kind: 'project', projectId }));
      if (scope === undefined || scope === 'bot') lists.push(await listOne({ kind: 'bot' }));
      return { lists };
    },
    async applyBlocks({ found, nonce, ctx }) {
      const missed: string[] = [];
      let written = 0;
      const turn = ctx.turn();
      // 评论里不解析（daemon 按位置关，不靠提示词）
      if (!turn || turn.place === 'comment') return { written, missed };
      for (const block of found.remember) {
        if (block.attrs.n !== nonce) { missed.push('bad-nonce'); log.warn('memory', 'hidden-block-bad-nonce', {}); continue; }
        const text = block.body.trim();
        if (!text || Array.from(text).length > MEMORY_TEXT_MAX) { missed.push('bad-args'); continue; }
        const claim = block.attrs.claim === 'asked' || block.attrs.claim === 'self' ? block.attrs.claim : undefined;
        try {
          const result = await add(ctx, { text, ...(block.attrs.branch !== undefined ? { branch: block.attrs.branch } : {}), ...(claim ? { claim } : {}) }, 'hidden_block');
          if (result.ok) written++;
          else if (result.error === 'memory-full') missed.push('memory-full');
          else if (result.error === 'refused') { if (result.reason !== 'duplicate') missed.push(result.reason); }
          else missed.push('bad-args');
        } catch (error) {
          if (error instanceof TurnEnded) { missed.push('not-allowed-here'); continue; }
          log.fail('memory.hidden-block', error, {});
          missed.push('not-allowed-here');
        }
      }
      for (let index = 0; index < found.dropped; index++) missed.push('dropped');
      log.info('memory', 'hidden-blocks', { written, missed: missed.length });
      return { written, missed };
    },
  };
}
