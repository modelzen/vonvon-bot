import type { CollaborationRequest } from '../admin/collaboration';
import type { HostSettings } from '../admin/settings-types';
import type { AdminWriteResult } from '../admin/ops';
import { createGroupExecutor, type AdminGroupOp, type JoinedGroups } from '../admin/groups';
import type { Project } from '../project/registry';
import { createLarkChannel, Domain, type LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AdminWriteOp } from '../admin/ops';
import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';
import { createOrchestrator } from './handle-message';
import { createTopicRegistry } from './topic-registry';
import { paths } from '../config/paths';

export interface BridgeOptions {
  cfg: AppConfig;
  appSecret: string;
  /** fallback cwd for groups that aren't registered projects. */
  fallbackCwd: string;
  onConnectionChange?: () => void;
}

export interface BridgeHandle {
  channel: LarkChannel;
  collaboration: (request: CollaborationRequest) => Promise<unknown>;
  adminGroups: (op: AdminGroupOp) => Promise<JoinedGroups | Project>;
  adminExecute: (op: AdminWriteOp) => Promise<AdminWriteResult>;
  settings: HostSettings;
  /** Graceful teardown: close every codex session (no orphan app-servers) then
   *  drop the long connection. Idempotent enough for a signal handler. */
  shutdown: () => Promise<void>;
}

/**
 * Bring up the long-connection bot. Wires the `message` handler (group @bot →
 * 会话配置卡 → reply_in_thread topic → codex → streaming card) and the
 * `cardAction` dispatcher (config card model/effort/创建/恢复 buttons), which
 * share run state via the orchestrator. Long-connection is required for
 * `card.action.trigger` (lark-cli doesn't deliver it).
 */
export async function startBridge(opts: BridgeOptions): Promise<BridgeHandle> {
  const app = opts.cfg.accounts.app;
  const channel = createLarkChannel({
    appId: app.id,
    appSecret: opts.appSecret,
    domain: app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-codex-bridge',
    // surface raw events so card-action handlers can read form submissions
    // (action.form_value) — used by the new-project form.
    includeRawEvent: true,
    // Deliver ALL group messages (not just @bot) to `onMessage`. The SDK's
    // PolicyGate otherwise drops non-@ group messages with reason 'no_mention'
    // before they reach us, which would make 免@ impossible. We turn the SDK
    // filter off and let our per-project gate (shouldRespondWithoutMention in
    // handle-message) be the single source of truth for 免@. Non-@ delivery
    // still requires the im:message.group_msg scope (Feishu-side push).
    policy: { requireMention: false },
    // Disable the SDK's 600ms per-chat text batching. It merges messages by
    // chatId, so two topics in the same group posting within 600ms get their
    // content concatenated and senderId taken from the last message — breaking
    // "topic = independent session" and misattributing permissions. delayMs: 0
    // takes the SDK's pure-serial branch (dedup + chat queue stay on); double
    // sends are already prevented by startReservedRun's synchronous booking.
    safety: { batch: { text: { delayMs: 0 } } },
  });

  // 咖啡一下 (the local Claude Code / Codex hook relay) left v1 in s02b: no
  // service and no socket; s02c deleted D/cli-bridge. Since s02c2 the installed
  // hooks run an empty `vonvon hook`, and the tools ask in the terminal.
  const orchestrator = createOrchestrator(channel, opts.cfg, opts.fallbackCwd, createTopicRegistry({ dir: paths.topicsDir }));
  const groupTasks = new Set<Promise<JoinedGroups | Project>>();
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    const groupsClosing = Promise.allSettled([...groupTasks]);
    const orchestratorClosing = orchestrator.shutdown();
    closing = (async () => {
      const errors: unknown[] = [];
      try { await orchestratorClosing; }
      catch (error) { errors.push(error); }
      const groups = await groupsClosing;
      for (const result of groups) if (result.status === 'rejected') errors.push(result.reason);
      try { await channel.disconnect(); }
      catch (error) { log.fail('ws', error, { phase: 'disconnect' }); errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Bridge cleanup failed');
    })();
    return closing;
  };
  try {
    channel.on('message', orchestrator.onMessage);
    channel.on('cardAction', orchestrator.dispatcher.handle);
    channel.on('comment', orchestrator.onComment);
    channel.on('botAdded', orchestrator.onBotAddedToChat);
    channel.on('reaction', orchestrator.onReaction);
    // The SDK exposes no named event for bot-*removed* (im.chat.member.bot.deleted_v1)
    // nor for bot-menu clicks (application.bot.menu_v6), so tap its private raw
    // EventDispatcher: register() merges by event key, so this adds our handlers
    // without clobbering the SDK's built-ins.
    try {
      const tap = (
        channel as unknown as {
          dispatcher?: { register?: (h: Record<string, (raw: unknown) => void>) => unknown };
        }
      ).dispatcher;
      if (tap?.register) {
        tap.register({
          'im.chat.member.bot.deleted_v1': (raw: unknown) => {
            const ev = raw as { chat_id?: string; event?: { chat_id?: string } };
            const chatId = ev?.chat_id ?? ev?.event?.chat_id;
            if (chatId) void orchestrator.onBotRemovedFromChat(chatId);
          },
          'application.bot.menu_v6': (raw: unknown) => {
            const ev = raw as {
              event_id?: string;
              event_key?: string;
              operator?: { operator_id?: { open_id?: string } };
              event?: { event_key?: string; operator?: { operator_id?: { open_id?: string } } };
            };
            void orchestrator.onBotMenu({
              openId: ev?.operator?.operator_id?.open_id ?? ev?.event?.operator?.operator_id?.open_id,
              eventKey: ev?.event_key ?? ev?.event?.event_key,
              eventId: ev?.event_id,
            });
          },
        });
        log.info('ws', 'raw-event-tap', { events: ['im.chat.member.bot.deleted_v1', 'application.bot.menu_v6'] });
      } else {
        log.info('ws', 'raw-event-tap-unavailable');
      }
    } catch (err) {
      log.fail('ws', err, { phase: 'raw-event-tap' });
    }
    channel.on('reject', (evt) => log.info('intake', 'reject', { reason: evt.reason, msgId: evt.messageId }));
    channel.on('error', (err) => { log.fail('ws', err); opts.onConnectionChange?.(); });
    channel.on('reconnecting', () => { log.info('ws', 'reconnecting'); opts.onConnectionChange?.(); });
    channel.on('reconnected', () => { log.info('ws', 'reconnected'); opts.onConnectionChange?.(); });

    await channel.connect();
    opts.onConnectionChange?.();
    log.info('ws', 'connected', { appId: app.id, fallbackCwd: opts.fallbackCwd });

    const executeGroup = createGroupExecutor(channel);
    const adminGroups: BridgeHandle['adminGroups'] = op => {
      if (closing) return Promise.reject(new Error('Bridge is shutting down'));
      const task = executeGroup(op);
      groupTasks.add(task);
      void task.then(() => groupTasks.delete(task), () => groupTasks.delete(task));
      return task;
    };
    return { channel, collaboration: orchestrator.collaboration, adminGroups, adminExecute: orchestrator.adminExecute, settings: orchestrator.settings, shutdown };
  } catch (error) {
    try { await shutdown(); }
    catch (cleanupError) {
      const cleanupErrors: unknown[] = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
      throw new AggregateError([error, ...cleanupErrors], 'Bridge startup and cleanup failed');
    }
    throw error;
  }
}
