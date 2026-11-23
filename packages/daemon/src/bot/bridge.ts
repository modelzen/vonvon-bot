import { bridgeFeedback } from '../feedback/bridge';
import { nativeRichSourceItems } from '../recipe/rich-source-lineage';
import { codexDraftParser } from '../recipe/codex-draft-parser';
import { resolveModelPreference } from '../config/execution';
import { AuthoringService, type AuthoringIpc } from '../recipe/authoring-service';
import { createBridgeChannel } from './bridge-channel';
import { APP_ROLE_CACHE_MS, APP_ROLE_RETRY_MS, createAppRoleRefresher, getAppRoleSnapshot } from '../config/app-roles';
import type { CollaborationRequest } from '../admin/collaboration';
import type { HostSettings } from '../admin/settings-types';
import type { AdminWriteResult } from '../admin/ops';
import { createGroupExecutor, type AdminGroupOp, type GroupMembers, type GroupMembership, type JoinedGroups } from '../admin/groups';
import type { Project } from '../project/registry';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AdminWriteOp } from '../admin/ops';
import type { AdminLibraryOp } from '../admin/library';
import type { GroupIdentity, ScheduleReply, ScheduleRequest } from '@vonvon/protocol';
import type { ScheduleActor } from '../admin/schedule-commands';
import { isAdmin, type AppConfig } from '../config/schema';
import {resourceTools} from '../agent/entry/resource-tools';
import { createCommandTools } from '../agent/entry/command-tools';
import { createFeishuReader, type FeishuReadReply, type FeishuReadRequest } from '../feishu-read/reader';
import { createFeishuCalls, createFeishuReads } from '../agent/entry/feishu-tools';
import type { ApiRequest } from '../feishu-read/api';
import { createMemoryWriter } from './memory-writer';
import { createFirstHello } from './first-hello';
import { dmProject, dmPersonOf, getProjectByChatId, listProjects } from '../project/registry';
import { isProjectId } from '../project/library';
import { createAgentEntries, type AgentEntries } from '../agent/entry/registry';
import { log } from '../core/logger';
import { createOrchestrator } from './handle-message';
import { putSessionCliOnPath, writeSessionCli } from '../agent/session-cli';
import { createTopicRegistry } from './topic-registry';
import type { BotIdentity } from '../config/bots';
import { adoptAdminSessions } from './session-store';
import { botPaths, paths } from '../config/paths';
import { setTierMergePending, splitTierChats } from '../project/registry';
import type { PermissionMode } from '../agent/types';
import { onCrashSync } from '../host/crash-guard';
import { createCardCallbackRecorder } from '../config/card-callback';
import type { HostApi } from '../admin/ipc';
import type { StopReason } from '../host/lifecycle';

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
  /** devices-4a 4.2: the host's session tokens; each session gets one when it starts and gives it up when it ends. Without it
   * (tests) a session's shell carries only the marker, which `vonvon` refuses to run as the owner with. */
  host?: HostApi;
}

export interface BridgeHandle {
  richRecipe:(op:import('../recipe/rich-installer').RichBotOp)=>Promise<unknown>;
  authoring: (op: AuthoringIpc) => Promise<unknown>;
  entries: AgentEntries;
  channel: LarkChannel;
  collaboration: (request: CollaborationRequest) => Promise<unknown>;
  adminGroups: (op: AdminGroupOp) => Promise<JoinedGroups | GroupMembers | GroupMembership | GroupIdentity | Project>;
  adminExecute: (op: AdminWriteOp) => Promise<AdminWriteResult>;
  /** A read this Bot runs as itself, the host asking (dm-agent 7.3). */
  feishuRead: (request: FeishuReadRequest) => Promise<FeishuReadReply>;
  feishuApi: (request: ApiRequest) => Promise<FeishuReadReply>;
  /** The host's workspace fan-out for this bot (admin/library.ts `AdminLibraryOp`). */
  libraryExecute: (op: AdminLibraryOp) => Promise<unknown>;
  settings: HostSettings;
  /** Scheduled tasks over the wire (admin/ipc.ts `AdminScheduleOp`), run as the local owner or a Bot session's turn. */
  schedule: (actor: ScheduleActor, request: ScheduleRequest) => Promise<ScheduleReply>;
  /** Tries the first private message to the creator, when the bot still owes one; the host calls it once the scopes are in. */
  firstHello: () => Promise<void>;
  /** Teardown: drop the long connection first, cut the running turns short and close every agent session (no orphan
   *  app-servers). `reason`, read as the cards end, says why on them. Idempotent enough for a signal handler. */
  shutdown: (reason?: () => StopReason) => Promise<void>;
}

/** How long a stop waits for the scheduled runs' records once the orchestrator closed (it settled the runs). */
const SCHEDULER_DRAIN_MS = 3_000;

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
  const feedback = bridgeFeedback(identity, opts.cfg, opts.appSecret, channel);
  const cardCallbacks = createCardCallbackRecorder(app.id, {
    onError: error => log.fail('setup', error, { phase: 'card-callback-verification', appId: app.id }),
  });

  // 记忆写入（工具、隐藏块和 Bot 会话的命令行共用）：群绑定的项目取自绑定行，Bot 记忆在 bots/<appId>/ 下。私聊不对应
  // 群，它的项目是本 Bot 现在绑定的全部项目，每次现读、去重（Codex 审查 239-1 / 241-1：缺了它，私聊写项目记忆全被拒）
  const memory = createMemoryWriter({
    botId: app.id,
    projectIdOf: async chatId => (await listProjects()).find(project => project.chatId === chatId)?.projectId,
    botProjectIds: async () => [...new Set((await listProjects()).flatMap(project => isProjectId(project.projectId) ? [project.projectId] : []))],
    dmPersonOf: async chatId => dmPersonOf(await getProjectByChatId(chatId), chatId)?.openId,
  });
  // 咖啡一下 (the local Claude Code / Codex hook relay) left v1 in s02b: no
  // service and no socket; s02c deleted D/cli-bridge. Since s02c2 the installed
  // hooks run an empty `vonvon hook`, and the tools ask in the terminal.
  const host = opts.host;
  // A revoke lost at shutdown is fine: the host drops all of this bot's tokens when its process exits.
  const sessions = host ? { revoke: (sessionId: string) => { void host.revokeSessionToken(sessionId).catch(() => undefined); } } : undefined;
  const feishu = createFeishuReader({ channel, app });
  const members = async (chatId: string, cursor?: string): Promise<GroupMembers> => {
    const result = await createGroupExecutor(channel, identity)({ kind: 'groupMembers', chatId, cursor });
    if (!('members' in result)) throw new Error('Invalid members reply');
    return result;
  };
  const entries = createAgentEntries({ feedbackEnabled: feedback.enabled, appId: app.id, isAdmin: id => isAdmin(opts.cfg, id), ...(sessions ? { sessions } : {}),
    memoryPlace: turn => memory.placeOf(turn), tools: [...resourceTools((get,query)=>authoring.resources.tool(get,query)),...createCommandTools({
    appId: app.id, feedback: true, memory, feishu, groupTier: chatId => orchestrator.permissionOf(chatId),
    schedule: { execute: (actor, request) => orchestrator.scheduleAs(actor, request) },
    groups: async cursor => {
      const result = await createGroupExecutor(channel, identity)({ kind: 'joinedGroups', cursor });
      if (!('groups' in result)) throw new Error('Invalid group reply');
      return result;
    },
    members, ...(host ? { route: (bot, request) => host.feishuRead(bot, request), routeApi: (bot, request) => host.feishuApi(bot, request) } : {}),
  })] });
  const sessionCli = await writeSessionCli();
  if (sessionCli) putSessionCliOnPath(sessionCli);
  const parser = codexDraftParser(async () => {
    const group = await dmProject(botPaths(identity.appId).projectsFile);
    if (!group) return;
    const backend = group.modelAccess?.backend ?? group.backend ?? 'codex-appserver';
    return {backend, model:resolveModelPreference({bot:opts.cfg.preferences, group},backend)?.model};
  });
  const authoring = new AuthoringService({bot: identity, cfg: opts.cfg, channel, parser,managedSources:nativeRichSourceItems,tasks:async chatId=>{
    const result=await orchestrator.scheduleAs({kind:'local',via:'desktop'},{action:'list',chatId});
    if(result.kind!=='tasks')throw new Error('无法读取所选群的任务。');
    return result.tasks;
  }});
  const orchestrator = createOrchestrator(channel, opts.cfg, opts.fallbackCwd, createTopicRegistry({ dir: paths.topicsDir }),
    { entries, memory, authoring, feedback, droppedFile: opts.droppedFile, judgeUsageFile: opts.judgeUsageFile, bot: identity, ...(host ? { host } : {}), ...(sessionCli ? { sessionCli } : {}) });
  const firstHello = createFirstHello({ cfg: opts.cfg, appSecret: opts.appSecret, channel, write: orchestrator.writePreferences });
  const roles = createAppRoleRefresher(app, opts.appSecret);
  await roles.refresh();
  let rolesStopped = false;
  let rolesTimer: ReturnType<typeof setTimeout>;
  const scheduleRoles = (): void => {
    const cached = getAppRoleSnapshot(app.id, app.tenant);
    const remaining = cached ? cached.fetchedAt + APP_ROLE_CACHE_MS - Date.now() : 0;
    // No fresh result (the last refresh failed, or none ever came): try again sooner, within the trust window (252-4).
    rolesTimer = setTimeout(() => {
      // The same slow beat brings the bot's first hello: nothing tells a running process that the app was published.
      void roles.refresh().then(() => { void firstHello.attempt(); if (!rolesStopped) scheduleRoles(); });
    }, remaining > 0 && remaining <= APP_ROLE_CACHE_MS ? remaining : APP_ROLE_RETRY_MS);
    rolesTimer.unref();
  };
  scheduleRoles();
  const offCrash = onCrashSync(() => orchestrator.saveDroppedSync('crash'));
  const groupTasks = new Set<Promise<JoinedGroups | GroupMembers | GroupMembership | GroupIdentity | Project>>();
  let closing: Promise<void> | undefined;
  const shutdown = (reason?: () => StopReason): Promise<void> => {
    if (closing) return closing;
    authoring.close();
    rolesStopped = true;
    firstHello.stop();
    clearTimeout(rolesTimer);
    const feedbackClosing = Promise.allSettled([feedback.close()]);
    const rolesClosing = roles.stop();
    // s18c: stop taking events first. One that comes after this is not acknowledged, so Feishu pushes it again to the
    // next process, which answers it; taken now, it would be acknowledged and dropped by the closing orchestrator.
    // Replies and card updates go over HTTP, which this does not close. allSettled handles a rejection at once: it must
    // not wait unhandled while the orchestrator drains.
    const transportClosing = Promise.allSettled([channel.disconnect()]);
    // Drain evidence received before disconnect completed; it runs independently of the business handlers.
    const callbacksClosing = transportClosing.then(() => cardCallbacks.close());
    const groupsClosing = Promise.allSettled([...groupTasks]);
    // No scheduled run is claimed from here on. The orchestrator interrupts the runs on and settles them within its drain
    // (handle-message.ts); the records are written right after, so 3 more seconds are plenty: the host kills this process
    // 15 seconds into a stop (bot/supervisor.ts).
    orchestrator.scheduler.stop();
    const orchestratorClosing = orchestrator.shutdown(reason);
    closing = (async () => {
      const errors: unknown[] = [];
      for (const result of await feedbackClosing) if (result.status === 'rejected') errors.push(result.reason);
      await rolesClosing;
      try { await orchestratorClosing; }
      catch (error) { errors.push(error); }
      await orchestrator.scheduler.drain(SCHEDULER_DRAIN_MS);
      const groups = await groupsClosing;
      for (const result of groups) if (result.status === 'rejected') errors.push(result.reason);
      for (const result of await transportClosing) {
        if (result.status === 'rejected') { log.fail('ws', result.reason, { phase: 'disconnect' }); errors.push(result.reason); }
      }
      await callbacksClosing;
      if (errors.length) throw new AggregateError(errors, 'Bridge cleanup failed');
    })().finally(offCrash);
    return closing;
  };
  try {
    await orchestrator.initialize?.();
    channel.on('message', orchestrator.onMessage);
    channel.on('cardAction', event => {
      cardCallbacks.received();
      return orchestrator.dispatcher.handle(event);
    });
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
    // Scheduled runs post to Feishu: the tick starts once connected, after the crashed runs are recorded.
    await orchestrator.scheduler.start();
    void firstHello.attempt();

    const executeGroup = createGroupExecutor(channel, identity, opts.cfg.preferences?.projectsRootDir);
    const adminGroups: BridgeHandle['adminGroups'] = op => {
      if (closing) return Promise.reject(new Error('Bridge is shutting down'));
      const task = executeGroup(op);
      groupTasks.add(task);
      void task.then(() => groupTasks.delete(task), () => groupTasks.delete(task));
      return task;
    };
    return { channel, entries, richRecipe:op=>orchestrator.richRecipe!(op,identity,async chatId=>{await adminGroups({kind:'groupMembership',chatId,identity});}), authoring: async op => op.kind === 'recipeAuthoringDisconnect' ? authoring.disconnect(op.peer.id) : authoring.request(op.peer, op.request), collaboration: orchestrator.collaboration, adminGroups, adminExecute: orchestrator.adminExecute, libraryExecute: orchestrator.libraryExecute, settings: orchestrator.settings, schedule: orchestrator.scheduleAs, feishuRead: createFeishuReads({ feishu, members }), feishuApi: createFeishuCalls(feishu), firstHello: firstHello.attempt, shutdown };
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
