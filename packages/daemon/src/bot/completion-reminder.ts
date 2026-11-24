import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { buildCompletionReminderContent } from '../card/completion-reminder';
import {
  getCompletionReminderConfig,
  shouldSendCompletionReminder,
  shouldShowCompletionReminderButton,
  type AppConfig,
  type CompletionReminderOutcome,
} from '../config/schema';
import { log } from '../core/logger';

export interface CompletionReminderReplyInput {
  cardMsgId: string;
  requesterOpenId?: string;
  /** Who started the turn: a bot-started turn never sends a completion reminder (s27a). */
  requesterKind?: 'user' | 'bot' | 'unknown';
  /** The group mode captured when this run started. */
  smart?: boolean;
  outcome: CompletionReminderOutcome;
  requestedAt: number;
  manuallyRequested: boolean;
  summary?: string;
  cardUpdated: boolean;
  replyInThread: boolean;
}

export interface CompletionReminderReplyDeps {
  channel: LarkChannel;
  cfg: AppConfig;
  /** `seen` records on first call and returns true for a duplicate. */
  dedupe: { seen(id: string): boolean };
  now?: () => number;
}

export type CompletionReminderReplyResult = 'sent' | 'skipped' | 'failed';

/** Smart groups offer manual reminders only for tasks started by a known person. */
export function reminderButtonOffered(
  cfg: AppConfig,
  run: Pick<CompletionReminderReplyInput, 'requesterKind' | 'smart'> & { runLoop?: true; isGoal?: boolean; compacting?: boolean; directMessage?: boolean },
): boolean {
  return run.runLoop === true && !run.isGoal && !run.compacting &&
    shouldShowCompletionReminderButton(cfg) &&
    (run.smart ? !run.directMessage && run.requesterKind === 'user' : run.requesterKind !== 'bot');
}

/**
 * Apply the four-mode policy and emit the native Feishu reply. Delivery is
 * deliberately best-effort: this runs after the task/card terminal has been
 * settled, catches transport failures, and never rewrites the task outcome.
 */
// A bot-started turn never sends a reminder; the agent decides whether its answer @-mentions the bot.
export async function sendCompletionReminderReply(
  deps: CompletionReminderReplyDeps,
  input: CompletionReminderReplyInput,
): Promise<CompletionReminderReplyResult> {
  // Explicit product boundary: user-stop / queue-cancel never generate an @
  // reply. Only ordinary success, agent error and watchdog timeout do.
  if (
    input.requesterKind === 'bot' ||
    !input.requesterOpenId ||
    (input.outcome !== 'done' && input.outcome !== 'error' && input.outcome !== 'idle_timeout')
  ) {
    return 'skipped';
  }

  const elapsedMs = Math.max(0, (deps.now?.() ?? Date.now()) - input.requestedAt);
  if (input.smart) {
    if (input.requesterKind !== 'user') return 'skipped';
    const optedIn = input.manuallyRequested && shouldShowCompletionReminderButton(deps.cfg);
    if (input.outcome === 'done' && input.cardUpdated && !optedIn) return 'skipped';
  } else {
    // A failed terminal card needs an observable fallback in every mode.
    const policyMatch = shouldSendCompletionReminder(deps.cfg, {
      outcome: input.outcome,
      elapsedMs,
      manuallyRequested: input.manuallyRequested,
    });
    if (input.cardUpdated && !policyMatch) return 'skipped';
  }
  if (deps.dedupe.seen(input.cardMsgId)) return 'skipped';

  const content = buildCompletionReminderContent({
    requesterOpenId: input.requesterOpenId,
    outcome: input.outcome,
    elapsedMs,
    summary: input.summary,
    cardUpdated: input.cardUpdated,
    template:getCompletionReminderConfig(deps.cfg).template,
  });
  try {
    await deps.channel.rawClient.im.v1.message.reply({
      path: { message_id: input.cardMsgId },
      data: { msg_type: 'post', content, reply_in_thread: input.replyInThread },
    });
    log.info('card', 'completion-reminder', {
      terminal: input.outcome,
      elapsedMs,
      cardUpdated: input.cardUpdated,
      ...(input.smart ? { smart: true } : {}),
      ...(input.requesterKind ? { requester: input.requesterKind } : {}),
    });
    return 'sent';
  } catch (err) {
    log.fail('card', err, { phase: 'completion-reminder', terminal: input.outcome, ...(input.smart ? { smart: true } : {}) });
    return 'failed';
  }
}
