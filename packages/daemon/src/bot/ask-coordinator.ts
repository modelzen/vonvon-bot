import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { isSensitiveAsk, type AgentRun, type AskRequest, type AskResolution } from '../agent/types';
import { isAdmin, resolveOwner, type AppConfig } from '../config/schema';
import { buildAskCard, parseAskSubmission, type AskCardState } from '../card/ask-card';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { log } from '../core/logger';
import type { IdlePause } from './watchdog';

export interface AskOrigin { subagentId: string; name?: string }

export interface AskTurnInput {
  run: AgentRun;
  sessionKey: string;
  placement: { chatId: string; replyTo: string; replyInThread: boolean };
  initiator: { kind: 'user' | 'bot' | 'unknown'; openId?: string };
  idlePause: IdlePause;
  waiting: (label: string | undefined, subagentId?: string) => void;
  fault: (error: unknown) => void;
}
export interface AskTurn {
  enqueue(request: AskRequest, from?: AskOrigin): void;
  cancel(requestId: string): void;
  close(reason: 'stopped' | 'turn-ended'): void;
}
export interface TypedInput {
  chatId: string;
  place: string;
  senderId: string;
  senderKind: 'user' | 'bot' | 'unknown';
  text: string;
  createTime?: number;
}
type EntryState = { kind: 'queued' } | { kind: 'sending' } | { kind: 'visible'; messageId: string; shownAt: number }
  | { kind: 'settled'; presentation: AskCardState };
interface Entry {
  request: AskRequest;
  from?: AskOrigin;
  state: EntryState;
  release: () => void;
  timer?: ReturnType<typeof setTimeout>;
  denied: Set<string>;
}
interface Turn extends AskTurnInput { faulted: boolean; open: boolean; queue: Entry[] }

/** Owns logical claims synchronously; all transport work is detached from run/shutdown drains. */
export class AskCoordinator {
  private readonly turns = new Map<string, Turn>();
  private readonly carriers = new Map<string, { turn: Turn; entry: Entry }>();
  private readonly latest = new WeakMap<AgentRun, Turn>();
  private readonly seen = new WeakMap<AgentRun, Set<string>>();
  private open = true;
  constructor(private readonly channel: LarkChannel, private readonly cfg: AppConfig,
    private readonly names: { peek(id: string): string | undefined }) {}

  private effect(operation: () => unknown, failure: (error: unknown) => void = error => log.fail('card', error, { phase: 'ask' })): void {
    try { void Promise.resolve(operation()).catch(error => { try { failure(error); } catch (err) { log.fail('agent', err, { phase: 'ask-fault' }); } }); }
    catch (error) { try { failure(error); } catch (err) { log.fail('agent', err, { phase: 'ask-fault' }); } }
  }
  private fault(turn: Turn, error: unknown): void {
    const current = this.latest.get(turn.run);
    if (!turn.open || (current && current !== turn)) { log.fail('agent', error, { phase: 'ask-old-response' }); return; }
    if (turn.faulted) return;
    turn.faulted = true;
    this.close(turn, 'turn-ended');
    this.effect(() => turn.fault(error));
  }
  private eligible(turn: Turn, request: AskRequest): string[] {
    return [...new Set([resolveOwner(this.cfg), ...(this.cfg.preferences?.access?.admins ?? []),
      ...(request.kind !== 'permission' && turn.initiator.kind === 'user' ? [turn.initiator.openId] : [])]
      .filter((id): id is string => Boolean(id)))];
  }
  private respondents(turn: Turn, request: AskRequest): { openId: string; name: string }[] {
    return this.eligible(turn, request).map(openId => ({ openId, name: this.names.peek(openId) ?? `成员 …${openId.slice(-6)}` }));
  }
  private waiting(turn: Turn): void {
    const head = turn.queue[0];
    this.effect(() => turn.waiting(head ? `⏸ 等 ${this.respondents(turn, head.request).map(person => person.name).join('、') || '指定成员'} 回答（见下方卡片）` : undefined, head?.from?.subagentId));
  }
  private claim(run: AgentRun, request: AskRequest): boolean {
    let ids = this.seen.get(run);
    if (!ids) { ids = new Set(); this.seen.set(run, ids); }
    if (!run.respondToAsk || ids.has(request.id)) return false;
    ids.add(request.id);
    return true;
  }
  openTurn(input: AskTurnInput): AskTurn {
    const previous = this.turns.get(input.sessionKey);
    if (previous) this.close(previous, 'turn-ended');
    const turn: Turn = { ...input, faulted: false, open: this.open, queue: [] };
    if (turn.open) { this.turns.set(input.sessionKey, turn); this.latest.set(input.run, turn); }
    return {
      enqueue: (request, from) => {
        if (!turn.open) { this.unavailable(input.run, request, input.fault); return; }
        if (!this.claim(input.run, request)) {
          this.fault(turn, new Error('Ask producer missing response port or repeated request id')); return;
        }
        turn.queue.push({ request, from, state: { kind: 'queued' }, release: input.idlePause.hold(), denied: new Set() });
        this.waiting(turn);
        this.promote(turn);
      },
      cancel: requestId => {
        const entry = turn.queue.find(candidate => candidate.request.id === requestId);
        if (entry) this.settle(turn, entry, { kind: 'unanswered', reason: 'unavailable' }, { providerResolved: true });
      },
      close: reason => this.close(turn, reason),
    };
  }
  unavailable(run: AgentRun, request: AskRequest, fault: (error: unknown) => void): void {
    if (!this.claim(run, request)) { this.effect(() => fault(new Error('Ask producer missing response port or repeated request id'))); return; }
    this.effect(() => run.respondToAsk?.(request.id, { kind: 'unanswered', reason: 'unavailable' }), fault);
  }
  private close(turn: Turn, reason: 'stopped' | 'turn-ended'): void {
    turn.open = false;
    if (this.turns.get(turn.sessionKey) === turn) this.turns.delete(turn.sessionKey);
    for (const entry of [...turn.queue]) this.settle(turn, entry, { kind: 'unanswered', reason });
  }
  shutdown(): void {
    this.open = false;
    for (const turn of [...this.turns.values()]) this.close(turn, 'stopped');
  }
  private terminal(turn: Turn, entry: Entry, messageId: string, state: AskCardState): void {
    this.effect(() => updateManagedCard(this.channel, messageId,
      buildAskCard({ request: entry.request, from: entry.from, state, respondents: this.respondents(turn, entry.request) })));
  }
  private promote(turn: Turn): void {
    const entry = turn.queue[0];
    if (!turn.open || !entry || entry.state.kind !== 'queued') return;
    if (turn.run.askPending?.(entry.request.id) === false) {
      this.settle(turn, entry, { kind: 'unanswered', reason: 'turn-ended' }, { providerResolved: true });
      return;
    }
    entry.state = { kind: 'sending' };
    entry.timer = setTimeout(() => this.settle(turn, entry, { kind: 'unanswered', reason: 'unavailable' }), 30_000);
    const { chatId, replyTo, replyInThread } = turn.placement;
    this.effect(async () => {
      const sent = await sendManagedCard(this.channel, chatId,
        buildAskCard({ request: entry.request, from: entry.from, state: { kind: 'pending' }, respondents: this.respondents(turn, entry.request) }), replyTo, replyInThread);
      if (entry.state.kind === 'settled') { this.terminal(turn, entry, sent.messageId, entry.state.presentation); return; }
      clearTimeout(entry.timer);
      entry.state = { kind: 'visible', messageId: sent.messageId, shownAt: Date.now() };
      this.carriers.set(sent.messageId, { turn, entry });
      entry.timer = setTimeout(() => this.settle(turn, entry, { kind: 'unanswered', reason: 'timeout' }), 15 * 60_000);
      const content = JSON.stringify({ zh_cn: { content: [[...this.eligible(turn, entry.request).map(user_id => ({ tag: 'at', user_id })), { tag: 'text', text: ' 请回答上方卡片' }]] } });
      this.effect(() => this.channel.rawClient.im.v1.message.reply({ path: { message_id: sent.messageId }, data: { msg_type: 'post', content, reply_in_thread: replyInThread } }));
    }, error => { this.settle(turn, entry, { kind: 'unanswered', reason: 'unavailable' }); log.fail('card', error, { phase: 'ask-send' }); });
  }
  submit(input: { messageId: string; chatId: string; operatorOpenId?: string; value: unknown; formValue: unknown }): 'accepted' | 'invalid' | 'denied' | 'inactive' | 'foreign' {
    const found = this.carriers.get(input.messageId);
    if (!found) return 'inactive';
    const { turn, entry } = found;
    if (!turn.open || this.turns.get(turn.sessionKey) !== turn || turn.queue[0] !== entry) return 'inactive';
    if (turn.placement.chatId !== input.chatId) return 'foreign';
    const parsed = parseAskSubmission({ request: entry.request, value: input.value, formValue: input.formValue });
    if (!parsed.ok) {
      const key = `invalid:${input.operatorOpenId ?? ''}:${parsed.reason}`;
      if (!entry.denied.has(key)) {
        entry.denied.add(key);
        this.effect(() => this.channel.send(input.chatId, { markdown: parsed.message }, { replyTo: input.messageId, replyInThread: turn.placement.replyInThread }));
      }
      return 'invalid';
    }
    const operator = input.operatorOpenId;
    if (!operator || !(isAdmin(this.cfg, operator) || (entry.request.kind !== 'permission' && turn.initiator.kind === 'user' && operator === turn.initiator.openId))) {
      if (operator && !entry.denied.has(operator)) {
        entry.denied.add(operator);
        this.effect(() => this.channel.send(input.chatId, { markdown: '仅指定成员可回答这个问题' }, { replyTo: input.messageId, replyInThread: turn.placement.replyInThread }));
      }
      return 'denied';
    }
    this.settle(turn, entry, { kind: 'answered', answer: parsed.answer }, { actor: this.names.peek(operator) ?? `成员 …${operator.slice(-6)}` });
    return 'accepted';
  }
  typed(input: TypedInput): 'answered' | 'sensitive' | 'none' {
    const turn = this.turns.get(input.place);
    if (!turn || !turn.open || turn.placement.chatId !== input.chatId) return 'none';
    const entry = turn.queue[0];
    if (!entry || entry.state.kind !== 'visible') return 'none';
    if (turn.run.askPending?.(entry.request.id) === false) {
      this.settle(turn, entry, { kind: 'unanswered', reason: 'turn-ended' }, { providerResolved: true });
      return 'none';
    }
    if (!input.createTime) return 'none';
    if (input.createTime < entry.state.shownAt) {
      log.info('card', 'ask-typed-before-visible', { deltaMs: input.createTime - entry.state.shownAt });
      return 'none';
    }
    if (input.senderKind !== 'user' || entry.request.kind !== 'choices') return 'none';
    if (!(isAdmin(this.cfg, input.senderId) || (turn.initiator.kind === 'user' && input.senderId === turn.initiator.openId))) return 'none';
    if (isSensitiveAsk(entry.request)) return 'sensitive';
    const text = input.text.trim().slice(0, 4000);
    if (!text) return 'none';
    log.info('card', 'ask-typed', { len: text.length, kind: entry.request.kind });
    this.settle(turn, entry, { kind: 'answered', answer: { kind: 'text', text } },
      { actor: this.names.peek(input.senderId) ?? `成员 …${input.senderId.slice(-6)}` });
    return 'answered';
  }
  private settle(turn: Turn, entry: Entry, resolution: AskResolution, options: { actor?: string; providerResolved?: boolean } = {}): void {
    if (entry.state.kind === 'settled') return;
    const messageId = entry.state.kind === 'visible' ? entry.state.messageId : undefined;
    const presentation: AskCardState = resolution.kind === 'answered'
      ? { kind: 'answered', answer: resolution.answer, actor: options.actor ?? '', at: new Date().toISOString() }
      : resolution.reason === 'timeout' ? { kind: 'timed-out' }
      : resolution.reason === 'stopped' ? { kind: 'stopped' } : { kind: 'unavailable', reason: resolution.reason };
    entry.state = { kind: 'settled', presentation };
    clearTimeout(entry.timer);
    if (messageId) this.carriers.delete(messageId);
    turn.queue = turn.queue.filter(candidate => candidate !== entry);
    entry.release();
    // Invoke the provider's local claim before doing presentation or any network work.
    if (!options.providerResolved) this.effect(() => turn.run.respondToAsk?.(entry.request.id, resolution), error => this.fault(turn, error));
    this.waiting(turn);
    this.promote(turn);
    if (messageId) this.terminal(turn, entry, messageId, presentation);
  }
}
