import { createBridgeChannel } from './bridge-channel';
import { APP_ROLE_CACHE_MS, createAppRoleRefresher, getAppRoleSnapshot } from '../config/app-roles';
import type { CollaborationRequest } from '../admin/collaboration';
import type { HostSettings } from '../admin/settings-types';
import type { AdminWriteResult } from '../admin/ops';
import { createGroupExecutor, type AdminGroupOp, type JoinedGroups } from '../admin/groups';
import type { Project } from '../project/registry';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AdminWriteOp } from '../admin/ops';
import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';
import { createOrchestrator } from './handle-message';
import { createTopicRegistry } from './topic-registry';
import type { BotIdentity } from '../config/bots';
import { adoptAdminSessions } from './session-store';
import { paths } from '../config/paths';
import { setTierMergePending, splitTierChats } from '../project/registry';
import type { PermissionMode } from '../agent/types';
import { onCrashSync } from '../host/crash-guard';

export interface BridgeOptions {
  identity: BotIdentity;
  cfg: AppConfig;
  appSecret: string;
  /** fallback cwd for groups that aren't registered projects. */
  fallbackCwd: string;
  onConnectionChange?: () => void;
  /** `bots/<appId>/dropped.json` (s18c): the queued messages a shutdown drops are kept there and answered once connected
   * again. Only `daemon run` passes it; without it nothing is kept or answered. */
  droppedFile?: string;
  /** Per-bot daily judgement counts; omitted by callers that do not persist usage. */
  judgeUsageFile?: string;
}

export interface BridgeHandle {
  channel: LarkChannel;
  collaboration: (request: CollaborationRequest) => Promise<unknown>;
  adminGroups: (op: AdminGroupOp) => Promise<JoinedGroups | Project>;
  adminExecute: (op: AdminWriteOp) => Promise<AdminWriteResult>;
  settings: HostSettings;
  /** Graceful teardown: drop the long connection first, then close every codex
   *  session (no orphan app-servers). Idempotent enough for a signal handler. */
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
  const identity = { ...opts.identity };
  if (identity.appId !== opts.cfg.accounts.app.id || identity.tenant !== opts.cfg.accounts.app.tenant) throw new Error('Bot 的注册身份与配置不匹配');
  await mergeTiers();
  const app = opts.cfg.accounts.app;
  const channel = createBridgeChannel(app, opts.appSecret);

  // 咖啡一下 (the local Claude Code / Codex hook relay) left v1 in s02b: no
  // service and no socket; s02c deleted D/cli-bridge. Since s02c2 the installed
  // hooks run an empty `vonvon hook`, and the tools ask in the terminal.
  const orchestrator = createOrchestrator(channel, opts.cfg, opts.fallbackCwd, createTopicRegistry({ dir: paths.topicsDir }),
    { droppedFile: opts.droppedFile, judgeUsageFile: opts.judgeUsageFile, bot: identity });
  const roles = createAppRoleRefresher(app, opts.appSecret);
  await roles.refresh();
  let rolesStopped = false;
  let rolesTimer: ReturnType<typeof setTimeout>;
  const scheduleRoles = (): void => {
    const cached = getAppRoleSnapshot(app.id, app.tenant);
    const remaining = cached ? cached.fetchedAt + APP_ROLE_CACHE_MS - Date.now() : 0;
    rolesTimer = setTimeout(() => {
      void roles.refresh().then(() => { if (!rolesStopped) scheduleRoles(); });
    }, remaining > 0 && remaining <= APP_ROLE_CACHE_MS ? remaining : APP_ROLE_CACHE_MS);
    rolesTimer.unref();
  };
  scheduleRoles();
  const offCrash = onCrashSync(() => orchestrator.saveDroppedSync('crash'));
  const groupTasks = new Set<Promise<JoinedGroups | Project>>();
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    rolesStopped = true;
    clearTimeout(rolesTimer);
    const rolesClosing = roles.stop();
    // s18c: stop taking events first. One that comes after this is not acknowledged, so Feishu pushes it again to the
    // next process, which answers it; taken now, it would be acknowledged and dropped by the closing orchestrator.
    // Replies and card updates go over HTTP, which this does not close. allSettled handles a rejection at once: it must
    // not wait unhandled while the orchestrator drains.
    const transportClosing = Promise.allSettled([channel.disconnect()]);
    const groupsClosing = Promise.allSettled([...groupTasks]);
    const orchestratorClosing = orchestrator.shutdown();
    closing = (async () => {
      const errors: unknown[] = [];
      await rolesClosing;
      try { await orchestratorClosing; }
      catch (error) { errors.push(error); }
      const groups = await groupsClosing;
      for (const result of groups) if (result.status === 'rejected') errors.push(result.reason);
      for (const result of await transportClosing) {
        if (result.status === 'rejected') { log.fail('ws', result.reason, { phase: 'disconnect' }); errors.push(result.reason); }
      }
      if (errors.length) throw new AggregateError(errors, 'Bridge cleanup failed');
    })().finally(offCrash);
    return closing;
  };
  try {
    channel.on('message', orchestrator.onMessage);
    channel.on('cardAction', orchestrator.dispatcher.handle);
    channel.on('comment', orchestrator.onComment);
    channel.on('botAdded', orchestrator.onBotAddedToChat);
    channel.on('reaction', orchestrator.onReaction);
    // The SDK exposes no named event for bot-*removed* (im.chat.member.bot.deleted_v1),
    // recalls (im.message.recalled_v1) or bot-menu clicks (application.bot.menu_v6),
    // so tap its private raw EventDispatcher: register() merges by event key, so
    // this adds our handlers without clobbering the SDK's built-ins.
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
          // A recall carries only the message, the chat, when and who (s15).
          'im.message.recalled_v1': (raw: unknown) => {
            type Recall = { message_id?: string; chat_id?: string; recall_type?: string };
            const ev = raw as Recall & { event?: Recall };
            void orchestrator.onRecall({
              messageId: ev?.message_id ?? ev?.event?.message_id,
              chatId: ev?.chat_id ?? ev?.event?.chat_id,
              recallType: ev?.recall_type ?? ev?.event?.recall_type,
            });
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
        log.info('ws', 'raw-event-tap', { events: ['im.chat.member.bot.deleted_v1', 'im.message.recalled_v1', 'application.bot.menu_v6'] });
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
    // Only once connected: when this start fails, the file stays as it is for the next one.
    orchestrator.replyDropped();

    const executeGroup = createGroupExecutor(channel, identity, opts.cfg.preferences?.projectsRootDir);
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

/**
 * s15c: a group has one tier and one session per place. Before anything reads
 * the stores, admins' `#admin` sessions of groups that still store two tiers
 * take their place's key; projects.json drops `guestMode` at its next write
 * (see foldGuestTier), so this reruns until then. The single-instance lock
 * keeps an old process from writing meanwhile. A failure is logged, never
 * fatal: the bot starts, and the chats are kept in projects.json
 * (setTierMergePending) so the next start tries them again even after that
 * write; a success drops them.
 */
async function mergeTiers(): Promise<void> {
  let split = new Map<string, PermissionMode>();
  try {
    split = await splitTierChats();
    if (!split.size) return;
    const places = await adoptAdminSessions(split);
    log.info('run', 'tier-merge', { chats: [...split].map(([chat, tier]) => `${chat.slice(-6)}→${tier}`), sessions: places.length, places: places.map((p) => p.slice(-6)) });
    await setTierMergePending([]);
  } catch (err) {
    log.fail('run', err, { phase: 'tier-merge' });
    if (split.size) await setTierMergePending([...split.keys()]).catch((e) => log.fail('run', e, { phase: 'tier-merge-pending' }));
  }
}
