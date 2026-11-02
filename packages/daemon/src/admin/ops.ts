import type { BotSettingsEdit, SettingsAction, SettingsSave, SettingsActionResult, HostSettings } from './settings-types';
import { backendIds } from '../agent';
import { permissionTable, tableEnv, tierInfo, TIER_NETWORK } from '../agent/permission';
import { groupBackendId, groupPermission } from '../config/execution';
import type { AgentBackend, BackendProbe, PermissionMode, ReasoningEffort } from '../agent/types';
import { tierLabel, type BackendProbeRow } from '../card/dm-cards';
import {
  COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES,
  COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES,
  getCompletionReminderConfig,
  type AppConfig,
  type AppPreferences,
  type CompletionReminderMode,
  type ResolvedCompletionReminderConfig,
} from '../config/schema';
import { loadConfig, saveConfig } from '../config/store';
import {
  effectiveMode,
  getProjectByName,
  mutateProject,
  sessionModeOf,
  updateProject,
  type Project,
} from '../project/registry';

/**
 * 管理面共享写操作层（第二棒：daemon 集成 + 写操作双端同源）。
 *
 * 【契约】DM 卡片回调（handle-message 的 dm.proj.* / gs.*）与 Web 控制台
 * （AdminService 写方法，经 Orchestrator.adminExecute / supervisor IPC）**都只
 * 走这里**写 projects.json——同一套校验、同一套落盘、同一套活跃会话驱逐，杜绝
 * 双写两套逻辑漂移。本模块只依赖 registry / agent 注册表 / dm-cards 的 tierLabel
 * （纯展示），不依赖 channel / orchestrator——驱逐动作由调用方以回调注入
 * （evictLiveSessionsForChat 是 orchestrator 进程内状态，必须在 bot 进程内执行；
 * 这也是 supervisor 写操作走 IPC 而非文件级直写的根本原因）。
 *
 * 写操作必须在「持有该 bot registry 的进程」内执行：registry 的 withLock 是
 * 进程内锁，跨进程直写会与 bot 进程的读-改-写交错丢更新。
 */

/** Web/IPC 写操作的序列化形态（supervisor → bot 子进程经 process.send 转发）。 */
export type AdminWriteResult = { kind: 'done' } | SettingsSave | SettingsActionResult;

export type AdminWriteOp =
  | { kind: 'settingsPatch'; edit: BotSettingsEdit }
  | { kind: 'settingsAction'; action: SettingsAction }
  | { kind: 'voice'; value: import('../voice/types').VoiceAction }
  | { kind: 'switchBackend'; project: string; backend: string }
  | {
      kind: 'setPermissionMode';
      project: string;
      mode?: PermissionMode;
    }
  | { kind: 'setNoMention'; project: string; on: boolean }
  | {
      kind: 'setCompletionReminder';
      mode: CompletionReminderMode;
      longTaskMinutes: number;
    };

/** 写操作被校验拒绝（中文原因可直接上卡/上 HTTP body）。HTTP 层映射 409；
 * IPC 层凭 code 还原类型。 */
export class AdminWriteError extends Error {
  readonly code = 'ADMIN_WRITE_REJECTED';
  constructor(reason: string) {
    super(reason);
    this.name = 'AdminWriteError';
  }
}

/** perform* 的统一返回：ok 带写后回读的最新项目（卡片/响应直接渲染它，保证与
 * 盘上一致）；!ok 带中文拒因。不抛错——DM 与 Web 对拒因的呈现方式不同。 */
export type AdminWriteOutcome = { ok: true; project: Project } | { ok: false; reason: string };

/** bot 全局偏好写入的返回；与项目写共用 `{ok:false,reason}` 拒绝协议。 */
export type AdminPreferencesWriteOutcome =
  | { ok: true; completionReminder: ResolvedCompletionReminderConfig }
  | { ok: false; reason: string };

/**
 * Serialize every read-modify-persist-commit of one bot's preferences. The
 * mutator runs only after all earlier writes have settled, so it always reads
 * the latest LIVE preferences; LIVE cfg is replaced only after its matching
 * snapshot has reached disk. A failed write leaves LIVE untouched and does not
 * poison later writes in the queue.
 */
export type AppPreferencesWriter = (mutate: (preferences: AppPreferences) => void | Promise<void>, options?: { beforeCommit?: () => void }) => Promise<AppPreferences>;

export function createAppPreferencesWriter(opts: {
  cfg: AppConfig;
  /** Test injection; production defaults to the atomic config writer. */
  persistConfig?: (cfg: AppConfig, beforeCommit?: () => void) => Promise<void>;
}): AppPreferencesWriter {
  let chain: Promise<unknown> = Promise.resolve();
  const persist = opts.persistConfig ?? ((next: AppConfig, beforeCommit?: () => void) => saveConfig(next, undefined, opts.cfg, beforeCommit));

  return (mutate, options) => {
    const run = chain.then(async () => {
      if (!opts.persistConfig) {
        const disk = await loadConfig();
        if (JSON.stringify(disk) !== JSON.stringify(opts.cfg)) throw new AdminWriteError('配置已被其他进程修改，请重启 daemon 后重新加载设置');
      }
      const preferences = structuredClone(opts.cfg.preferences ?? {});
      await mutate(preferences);
      await persist({ ...opts.cfg, preferences }, options?.beforeCommit);
      opts.cfg.preferences = preferences;
      return preferences;
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const TIERS: readonly PermissionMode[] = ['qa', 'write', 'full'];
const COMPLETION_REMINDER_MODES: readonly CompletionReminderMode[] = ['manual', 'long', 'failures', 'always'];

/**
 * 项目后端切换的纯校验（exported for tests）：① 目标 id 在注册表里；② 目标后端
 * doctor() 探测通过（未装 CLI / SDK 不可用要在这里拦住，而不是切过去后每条消息
 * 报错）；③ 项目的权限档在目标后端声明的支持面内
 * （某后端若仅支持部分权限档——其 startThread 的 fail-closed 硬守卫不变，这里
 * 只是把拒绝提前到切换时并讲清原因）。返回首个不满足的原因（中文，直接上卡）；
 * 全过返回 null。切换本身不驱逐活跃会话：SessionRecord.backend 让已有话题会话
 * 仍走原后端，新话题才用新值（resolveThread 按记录路由的既有语义）。
 */
export function validateBackendSwitch(opts: {
  /** 目标后端 id（下拉提交值） */
  target: string;
  /** 注册表内全部后端 id（backendIds()） */
  registered: readonly string[];
  /** 项目当前权限档（要被目标后端支持） */
  project: Pick<Project, 'mode'>;
  /** 目标后端声明的权限档支持面（AgentBackend.supportedModes；undefined ⇒ 全支持） */
  supportedModes?: readonly PermissionMode[];
  /** 目标后端 doctor() 探测结果；undefined = 探测没跑成，按不可用拒绝 */
  probe?: BackendProbe;
}): string | null {
  if (!opts.registered.includes(opts.target)) {
    return `未知后端「${opts.target}」（可用：${opts.registered.join('、')}）`;
  }
  if (!opts.probe?.ok) {
    return `后端「${opts.target}」当前不可用：${opts.probe?.hint ?? '环境探测失败（没装或没配置好）'}`;
  }
  if (opts.supportedModes) {
    const tier = effectiveMode(opts.project);
    if (!opts.supportedModes.includes(tier)) {
      return (
        `该后端仅支持 ${opts.supportedModes.map(tierLabel).join(' / ')} 权限，` +
        `本项目当前为 ${tierLabel(tier)} —— 请先在「🔐 权限」调整到支持的档位再切换。`
      );
    }
  }
  return null;
}

/** Windows doctor starts Job Object supervisors for version and sandbox probes.
 * Their bounded startup can exceed 3 s even for a healthy installed CLI. Keep
 * the outer budget above those probes; a hung/failed doctor still cannot pass. */
export const BACKEND_PROBE_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 3_000;

/**
 * 🧠 后端检测的纯探测（exported for tests）：并行对全部后端 doctor({force})，
 * 单个超时（Promise.race 兜底）/抛错都归一成 probe undefined——检测结果卡按
 * 不可用渲染，绝不放行。输入是后端实例的最小切面，注册表里有什么测什么，
 * 新后端注册即自动出现在结果卡上。
 */
export async function probeBackends(
  backends: readonly Pick<AgentBackend, 'id' | 'displayName' | 'supportedModes' | 'doctor'>[],
  timeoutMs = BACKEND_PROBE_TIMEOUT_MS,
): Promise<BackendProbeRow[]> {
  return Promise.all(
    backends.map(async (be) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      });
      const probe = await Promise.race([be.doctor({ force: true }).catch(() => undefined), timeout]).finally(() =>
        clearTimeout(timer),
      );
      return { id: be.id, name: be.displayName, probe, supportedModes: be.supportedModes };
    }),
  );
}

/** 写后回读（卡片/响应与盘上一致）；理论上 update 后必在，缺了用合成值兜底。 */
async function freshOr(name: string, fallback: Project): Promise<Project> {
  return (await getProjectByName(name)) ?? fallback;
}

/**
 * 🧠 切换项目后端（DM dm.proj.backend.submit 与 Web switchBackend 同源）：
 * 写盘前再 doctor({force}) 探一次「现在」的状态（检测卡渲染后环境可能已变），
 * validateBackendSwitch 全过才写 Project.backend。**不驱逐活跃会话**——已有话题
 * 会话按 SessionRecord.backend 仍走原后端，新话题才用新值。
 */
export async function performBackendSwitch(opts: {
  projectName: string;
  target: string;
  /** 后端实例解析（orchestrator 的缓存版或裸 createBackend 均可） */
  backendFor: (id: string) => AgentBackend;
}): Promise<AdminWriteOutcome> {
  const p = await getProjectByName(opts.projectName);
  if (!p) return { ok: false, reason: `项目「${opts.projectName}」不存在` };
  // 后端在新建项目时选定、运行时固定，不支持切换（防御式：UI 已撤切换入口，这里挡住
  // 任何残留 IPC/HTTP 请求）。仅放行 legacy 项目（backend 未设）的一次性落地与同值 no-op。
  if (p.backend && p.backend !== opts.target) {
    return {
      ok: false,
      reason: '该项目的后端已在创建时选定，运行时固定、不支持切换。如需更改，请删除该项目后用新后端重新创建。',
    };
  }
  const registered = backendIds();
  const known = registered.includes(opts.target);
  const probe = known ? (await probeBackends([opts.backendFor(opts.target)]))[0]?.probe : undefined;
  const reason = validateBackendSwitch({
    target: opts.target,
    registered,
    project: p,
    supportedModes: known ? opts.backendFor(opts.target).supportedModes : undefined,
    probe,
  });
  if (reason) return { ok: false, reason };
  await mutateProject(opts.projectName, latest => {
    if (groupBackendId(latest) !== opts.target) {
      const mode = groupPermission(latest).tier;
      latest.mode = mode;
      latest.network = TIER_NETWORK[mode];
      delete latest.custom;
    }
    latest.backend = opts.target;
  });
  return { ok: true, project: await freshOr(opts.projectName, { ...p, backend: opts.target }) };
}

/**
 * 🔐 设置权限（DM dm.proj.perm.submit 与 Web setPermissionMode 同源）：落盘
 * mode 和随档的联网效果、清除自定义，再驱逐本项目活跃会话让新档立即生效（codex 沙箱在
 * thread/start 绑定后不可变）。mode 缺省 = 不改。
 */
export async function performSetPermissionMode(opts: {
  projectName: string;
  mode?: PermissionMode;
  /** The active runtime backend supplies both supported modes and host sandbox availability. */
  backendFor: (id: string) => AgentBackend;
  /** orchestrator 进程内驱逐（LIVE 线程只存在于 bot 进程内存里） */
  evictLiveSessionsForChat: (chatId: string) => Promise<void>;
}): Promise<AdminWriteOutcome> {
  // Web 来路的档位值未经 DM 端 asTier 收窄，这里再守一道（DM 来路恒合法）。
  if (opts.mode !== undefined && !TIERS.includes(opts.mode)) return { ok: false, reason: `未知权限「${String(opts.mode)}」` };
  const p = await getProjectByName(opts.projectName);
  if (!p) return { ok: false, reason: `项目「${opts.projectName}」不存在` };
  if (opts.mode === undefined) return { ok: true, project: p };
  const backend = groupBackendId(p);
  const be = opts.backendFor(backend);
  const info = tierInfo(permissionTable(backend), tableEnv(be), opts.mode);
  if (info.unavailable) return { ok: false, reason: info.unavailable };
  const mode = opts.mode;
  await mutateProject(opts.projectName, latest => {
    latest.mode = mode;
    latest.network = TIER_NETWORK[mode];
    delete latest.custom;
  });
  await opts.evictLiveSessionsForChat(p.chatId);
  return { ok: true, project: await freshOr(opts.projectName, p) };
}

/** 智能 has no 免@ (s25c): an old card's button or an old page's switch is refused with this. */
export const SMART_NO_MENTION_REFUSED = '这个群是智能开话题，回不回由 Bot 判断，没有免 @ 这一项';

/** ✋ 免@ 开关（DM dm.proj.noMention / gs.noMention 与 Web setNoMention 同源）。
 * 即时生效（每条消息读盘判定），无需驱逐。智能群没有这一项，拒绝（s25c）。 */
export async function performSetNoMention(opts: { projectName: string; on: boolean }): Promise<AdminWriteOutcome> {
  const p = await getProjectByName(opts.projectName);
  if (!p) return { ok: false, reason: `项目「${opts.projectName}」不存在` };
  if (sessionModeOf(p) === 'smart') return { ok: false, reason: SMART_NO_MENTION_REFUSED };
  // Turned 智能 meanwhile: nothing is written, and it is refused the same way so the card says so (审查低).
  let turned = false;
  await updateProject(opts.projectName, latest => {
    if (sessionModeOf(latest) !== 'smart') return { noMention: opts.on };
    turned = true;
    return {};
  });
  if (turned) return { ok: false, reason: SMART_NO_MENTION_REFUSED };
  return { ok: true, project: await freshOr(opts.projectName, { ...p, noMention: opts.on }) };
}

/** 🤖 设置项目「新话题默认模型 / 推理强度」。**不驱逐活跃会话**——默认只管新会话，
 * 进行中 / 已 resume 的会话保留各自显式选择（语义上不该被默认改动打断，也免去给非
 * 管理员留 DoS 面）。model 的有效性（在该后端实时模型列表内、effort 受该模型支持）
 * 由调用方在写前对着 live listModels 校验 + 收窄；这里只确保项目存在并落盘。读取侧
 * 的最终防线在 {@link pickDefault}：盘上若仍存到坏值，apply 时会被忽略并回落后端默认。 */
export async function performSetModelDefault(opts: {
  projectName: string;
  model: string;
  effort?: ReasoningEffort;
  /** 手填的 id（3.11）：调用方已用 parseModelId 校验，读取侧不再对列表校验。 */
  custom?: boolean;
}): Promise<AdminWriteOutcome> {
  const p = await getProjectByName(opts.projectName);
  if (!p) return { ok: false, reason: `项目「${opts.projectName}」不存在` };
  const patch = { defaultModel: opts.model, defaultEffort: opts.effort, defaultModelCustom: opts.custom === true };
  await updateProject(opts.projectName, patch);
  return { ok: true, project: await freshOr(opts.projectName, { ...p, ...patch }) };
}

/**
 * 🔔 设置普通任务结束提醒。该偏好属于每个 bot 的 config.json，而非项目注册表：
 * 必须在持有 LIVE `cfg` 的 bot 进程内执行，先原子落盘，再替换同一个 cfg 对象的
 * preferences 引用，使正在运行的任务链路下一次读取就能看到新策略。Web/supervisor
 * 只能投递 {@link AdminWriteOp}，不得跨进程直写配置文件。
 */
export async function performSetCompletionReminder(opts: {
  cfg: AppConfig;
  mode: CompletionReminderMode;
  /** Omit for a mode-only update; the writer merges the latest queued threshold. */
  longTaskMinutes?: number;
  /** 测试注入；生产缺省走 config/store 的原子 saveConfig。 */
  persistConfig?: (cfg: AppConfig, beforeCommit?: () => void) => Promise<void>;
  /** 与其它 DM/Web preferences 写共享的串行 writer。 */
  writePreferences?: AppPreferencesWriter;
}): Promise<AdminPreferencesWriteOutcome> {
  if (!COMPLETION_REMINDER_MODES.includes(opts.mode)) {
    return { ok: false, reason: `未知完成提醒策略「${String(opts.mode)}」` };
  }
  if (
    opts.longTaskMinutes !== undefined &&
    (!Number.isInteger(opts.longTaskMinutes) ||
      opts.longTaskMinutes < COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES ||
      opts.longTaskMinutes > COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES)
  ) {
    return {
      ok: false,
      reason:
        `长任务阈值必须是 ${COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES}–` +
        `${COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES} 之间的整数分钟`,
    };
  }

  // 不直接先 mutate LIVE cfg：若落盘失败，运行态仍保留旧值，不会出现“本轮生效、重启丢失”。
  const writePreferences =
    opts.writePreferences ?? createAppPreferencesWriter({ cfg: opts.cfg, persistConfig: opts.persistConfig });
  await writePreferences((preferences) => {
    const current = getCompletionReminderConfig({ ...opts.cfg, preferences });
    preferences.completionReminder = {
      mode: opts.mode,
      longTaskMinutes: opts.longTaskMinutes ?? current.longTaskMinutes,
    };
  });
  return { ok: true, completionReminder: getCompletionReminderConfig(opts.cfg) };
}

export interface AdminWriteExecutorDeps {
  settings?: HostSettings;
  voiceAction?: (action: import('../voice/types').VoiceAction) => Promise<void>;
  backendFor: (id?: string) => AgentBackend;
  evictLiveSessionsForChat: (chatId: string) => Promise<void>;
  /** LIVE bot config；setCompletionReminder 需要它来热更新运行态。 */
  cfg?: AppConfig;
  /** 测试注入；生产缺省由 performSetCompletionReminder 调 saveConfig。 */
  persistConfig?: (cfg: AppConfig, beforeCommit?: () => void) => Promise<void>;
  /** 与 DM 设置共用，避免 Web/DM 并发读改写丢字段。 */
  writePreferences?: AppPreferencesWriter;
}

export function createAdminWriteExecutor(deps: AdminWriteExecutorDeps): (op: AdminWriteOp) => Promise<AdminWriteResult> {
  const writePreferences =
    deps.writePreferences ??
    (deps.cfg ? createAppPreferencesWriter({ cfg: deps.cfg, persistConfig: deps.persistConfig }) : undefined);
  return async (op) => {
    if (op.kind === 'settingsPatch' || op.kind === 'settingsAction') {
      if (!deps.settings) return { kind: 'unavailable', reason: { kind: 'readonly', reason: 'owner-offline', message: 'Bot 设置服务还没准备好' } };
      return op.kind === 'settingsPatch' ? deps.settings.save(op.edit) : deps.settings.act(op.action);
    }
    const outcome = await runAdminWriteOp(op, { ...deps, writePreferences });
    if (!outcome.ok) throw new AdminWriteError(outcome.reason);
    return { kind: 'done' };
  };
}

/** AdminWriteOp 分发（exported for tests）。 */
export async function runAdminWriteOp(
  op: Exclude<AdminWriteOp, { kind: 'settingsPatch' | 'settingsAction' }>,
  deps: AdminWriteExecutorDeps,
): Promise<AdminWriteOutcome | AdminPreferencesWriteOutcome | { ok: true }> {
  switch (op.kind) {
    case 'voice':
      if (!deps.voiceAction) return { ok: false, reason: '语音服务未就绪' };
      try { await deps.voiceAction(op.value); return { ok: true }; }
      catch (err) { return { ok: false, reason: err instanceof Error ? err.message : '语音设置失败' }; }
    case 'switchBackend':
      return performBackendSwitch({ projectName: op.project, target: op.backend, backendFor: deps.backendFor });
    case 'setPermissionMode':
      return performSetPermissionMode({
        projectName: op.project,
        mode: op.mode,
        backendFor: deps.backendFor,
        evictLiveSessionsForChat: deps.evictLiveSessionsForChat,
      });
    case 'setNoMention':
      return performSetNoMention({ projectName: op.project, on: op.on });
    case 'setCompletionReminder':
      if (!deps.cfg) return { ok: false, reason: 'Bot 的运行配置不可用，无法即时更新完成提醒' };
      return performSetCompletionReminder({
        cfg: deps.cfg,
        mode: op.mode,
        longTaskMinutes: op.longTaskMinutes,
        persistConfig: deps.persistConfig,
        writePreferences: deps.writePreferences,
      });
  }
}
