import type { ResponseRoster } from '@vonvon/protocol';
import { responseMemberLabel } from '../bot/response-members';
import { voiceView, VOICE_TITLE, VOICE_DESCRIPTION, VOICE_NOTICE, VOICE_DOC_URL } from '../voice/view';
import {
  COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES,
  COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES,
  getCompletionReminderConfig,
  getMaxConcurrentRuns,
  getPendingPolicy,
  getSessionTitleConfig,
  getSessionTitleEfforts,
  normalizeRunIdleTimeoutSeconds,
  RUN_IDLE_TIMEOUT_DEFAULT_SEC,
  RUN_IDLE_TIMEOUT_MAX_SEC,
  RUN_IDLE_TIMEOUT_MIN_SEC,
  summarizeSessionTitles,
  type AppConfig,
  type SessionTitleAiConfig,
} from '../config/schema';
import { conversationCopy, FULL_ACCESS_WARNING, modeToConversation, topicConversationCopy } from '@vonvon/protocol';
import { noMentionOf, ruleKind, sessionModeOf, type Project } from '../project/registry';
import {
  DEFAULT_BACKEND_ID,
  REASONING_EFFORTS,
  type BackendProbe,
  type ModelInfo,
  type PermissionMode,
  type ReasoningEffort,
} from '../agent/types';
import { catalogById } from '../agent/catalog';
import { groupBackendId, groupPermission, resolveCommentsExecution } from '../config/execution';
import { permissionTable, tierInfo, type PermissionTable, type TableEnv } from '../agent/permission';
import { CUSTOM_MODEL_OPTION, MODEL_ID_MAX_LENGTH, parseModelId } from '../agent/model-id';
import type { SessionRecord } from '../bot/session-store';
import { labelScope } from '../config/scopes';
import { summarizeEventDiagnosis, type EventDiagnosis } from '../utils/event-diagnosis';
import { actions, actionsFixed, button, card, form, hr, input, linkButton, md, note, selectMenu, submitButton, type ActionValue, type CardElement, type CardObject, type SelectOption } from './cards';
import { reasoningEffortLabel, relativeTime } from './command-cards';

/** applink to open a Feishu group chat by chat_id (oc_xxx). Feishu has no
 * deep link to a specific thread/topic, so this lands in the group and the
 * user scrolls to the topic themselves. */
function openChatUrl(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

/**
 * 官网，和诊断卡里的"反馈"：闭源产品没有公开仓库和 issue 页，求助走这两个入口。
 * 反馈指向官网首页的交流群一节，不把飞书群邀请链接写进发布出去的包：群换了或链接重置，改官网就行，不用等发版本。
 */
const SITE_URL = 'https://vonvon.bot';
const FEEDBACK_URL = `${SITE_URL}/#community`;

/** Fixed widths for the menu's two action rows, chosen so both rows span the
 * SAME total and align left+right: row 1 (3 buttons) at 152px each, row 2 (4
 * buttons) at 112px each — with actionsFixed's 8px gap, 3·152+2·8 = 4·112+3·8 =
 * 472px. Buttons are left-packed; the right side stays empty (no stretch). */
const MENU_BTN_W_TOP = '152px';
const MENU_BTN_W_BOT = '112px';

/** Action ids for the DM (private chat) management console. */
export const DM = {
  menu: 'dm.menu',
  newProject: 'dm.newProject',
  newProjectSubmit: 'dm.newProject.submit',
  joinGroupSubmit: 'dm.joinGroup.submit',
  projects: 'dm.projects',
  settings: 'dm.settings',
  voiceSettings: 'dm.voice.settings',
  setVoice: 'dm.voice.set',
  testVoice: 'dm.voice.test',
  refreshVoicePermission: 'dm.voice.refreshPermission',
  doctor: 'dm.doctor',
  reconnect: 'dm.reconnect',
  restart: 'dm.restart',
  restartDo: 'dm.restart.do',
  update: 'dm.update',
  updateDo: 'dm.update.do',
  // 📊 Codex 用量（限额 + 个人资料统计 + 热力图）；share 打开内容选择卡，
  // shareDo 按所选区块生成可转发的分享卡
  usage: 'dm.usage',
  usageRefresh: 'dm.usage.refresh',
  usageShare: 'dm.usage.share',
  usageShareDo: 'dm.usage.share.do',
  rmConfirm: 'dm.rmConfirm',
  rmDo: 'dm.rmDo',
  rmCancel: 'dm.rmCancel',
  setTools: 'dm.set.tools',
  setShowModel: 'dm.set.showModel',
  setWatchdog: 'dm.set.watchdog',
  // 假死超时「自定义…」：watchdogCustom 打开输入卡，watchdogCustomSubmit 保存任意秒数
  watchdogCustom: 'dm.set.watchdog.custom',
  watchdogCustomSubmit: 'dm.set.watchdog.customSubmit',
  // 普通群任务结束提醒（与 ☕ CLI Stop 通知无关）：四档策略 + 长任务阈值子卡
  setCompletionReminder: 'dm.set.completionReminder',
  completionReminderCustom: 'dm.set.completionReminder.custom',
  completionReminderCustomSubmit: 'dm.set.completionReminder.customSubmit',
  setPending: 'dm.set.pending',
  setConcurrency: 'dm.set.concurrency',
  // 权限管理：全局 admins（settings 卡进入）+ 项目响应白名单（项目列表 / 建项目完成卡进入）
  admins: 'dm.admins',
  addAdminForm: 'dm.admin.addForm',
  addAdminSubmit: 'dm.admin.addSubmit',
  rmAdmin: 'dm.admin.rm',
  allowlist: 'dm.allowlist',
  addAllowedForm: 'dm.allow.addForm',
  addAllowedSubmit: 'dm.allow.addSubmit',
  rmAllowed: 'dm.allow.rm',
  // 项目设置容器（项目列表 / 建项目完成卡 进入），以后的项目级设置项往这里加
  projectSettings: 'dm.projectSettings',
  // 🧵 话题钻取：项目总览的「🧵 N 话题」按钮 → 该项目话题列表卡
  projectTopics: 'dm.projectTopics',
  setNoMentionDm: 'dm.proj.noMention',
  // 🗜️ 自动压缩的开关 s12 已去掉；只留给旧卡上的按钮，点了刷新成没有开关的卡
  setAutoCompactDm: 'dm.proj.autoCompact',
  // 🤖 默认模型/强度：新话题的起始模型 + 推理强度（选完提交的下拉表单子卡，仿权限卡）
  modelDefault: 'dm.proj.modelDefault',
  modelDefaultSubmit: 'dm.proj.modelDefault.submit',
  // 🔐 权限：群里所有人共用的权限，做成下拉表单（选+提交）
  permission: 'dm.proj.perm',
  permissionSubmit: 'dm.proj.perm.submit',
  // 🧠 后端 backend/backendSubmit 已移除：后端改为「创建时选定、运行时固定、不支持切换」，
  // 新建卡选后端见 newProjectSubmit；项目设置卡只读展示。
  // 📝 云文档评论 @bot 全局设置：后端按钮(级联)→模型/强度下拉表单提交；提示词在卡内编辑。
  commentSettings: 'dm.comment.settings',
  commentSetBackend: 'dm.comment.setBackend',
  commentSubmit: 'dm.comment.submit',
  commentEditPrompt: 'dm.comment.editPrompt',
  commentPromptSubmit: 'dm.comment.promptSubmit',
  commentResetPrompt: 'dm.comment.resetPrompt',
  // 🏷️ Bridge 新建会话的原生 resume 标题：按后端独立选模型 + Effort。
  sessionTitleSettings: 'dm.sessionTitle.settings',
  sessionTitleSetBackend: 'dm.sessionTitle.setBackend',
  sessionTitleSubmit: 'dm.sessionTitle.submit',
  sessionTitleDisable: 'dm.sessionTitle.disable',
} as const;

/** Action ids of the in-group settings card (@bot /settings), no longer sent (s1b): a click on an old one changes nothing. */
export const GS = {
  setNoMention: 'gs.noMention',
  // 旧卡上的自动压缩按钮（s12 已去掉开关）
  setAutoCompact: 'gs.autoCompact',
  // 🤖 默认模型/强度：群内 /settings 的镜像入口（open=进子卡，submit=保存，settings=返回群设置）
  settings: 'gs.settings',
  modelDefault: 'gs.modelDefault',
  modelDefaultSubmit: 'gs.modelDefault.submit',
} as const;

/** Human label for a group's 会话方式 (product.md 3.4). */
export function kindLabel(p: Pick<Project, 'kind' | 'smart'>): string {
  const copy = conversationCopy[modeToConversation(sessionModeOf(p))];
  return `${copy.name} · ${copy.title}`;
}

/** What a settings card shows in place of 免@ for a 智能 group (s25c): a judgement decides, there is nothing to set. */
export const SMART_NO_MENTION_NOTE = '✋ 免 @：智能开话题由我判断回不回，没有这一项。';

/** 官网下载页入口；`url` 为空（不是 macOS）时什么也不画。 */
function desktopDownloadElements(url?: string | null): CardElement[] {
  if (!url) return [];
  return [
    note('macOS 桌面版的安装包在官网下载页。'),
    actions([linkButton('🌐 打开下载页', url, 'primary')]),
    hr(),
  ];
}

/**
 * The top-level management menu.
 *
 * @param opts.version the bridge's own version (from bridgeVersion()); shown as a
 *   small badge in the header. Omitted → no badge.
 *
 * dm-cards stays a pure renderer — all IO (discovery file / version) lives in
 * the caller.
 */
export function buildDmMenuCard(opts: { version?: string } = {}): CardObject {
  const { version } = opts;
  return card(
    [
      md('直接跟我说就行。这里是常用入口。'),
      hr(),
      // 两行按钮固定宽度、左对齐；两行宽度配平后总长相等、右边缘对齐（见 MENU_BTN_W_*）。
      actionsFixed([
        button('➕ 新建项目', { a: DM.newProject }, 'primary'),
        button('📁 项目列表', { a: DM.projects }),
        button('⚙️ 设置', { a: DM.settings }),
      ], MENU_BTN_W_TOP),
      actionsFixed([
        button('📊 用量', { a: DM.usage }),
        button('🩺 诊断', { a: DM.doctor }),
        button('🔁 重启', { a: DM.restart }),
        button('⬆️ 更新', { a: DM.update }),
      ], MENU_BTN_W_BOT),
    ],
    {
      header: {
        title: '🤖 Vonvon Bot 管理台',
        template: 'blue',
        textTags: version ? [{ text: `v${version}`, color: 'green' }] : undefined,
      },
      forward: false,
    },
  );
}

const backToMenu = () => actions([button('⬅️ 菜单', { a: DM.menu })]);

export function buildForegroundUpdateCard(info: {
  current: string;
  distribution?: 'bundled' | 'other';
  /** 官网下载页；不是 macOS 时为空，不画入口。 */
  desktopDownload?: string | null;
}): CardObject {
  return card(
    [
      md(`当前版本：**v${info.current}**`),
      note('前台运行的 daemon 不支持在此更新。'),
      note(info.distribution === 'bundled'
        ? '此运行时随桌面应用提供，请在桌面应用中更新。'
        : '请通过部署此运行时的来源获取新版本，再在启动终端停止旧进程并运行 `vonvon daemon run`。'),
      ...(info.distribution === 'bundled' ? [] : desktopDownloadElements(info.desktopDownload)),
      backToMenu(),
    ],
    { header: { title: '⬆️ 更新说明', template: 'blue' } },
  );
}

/**
 * 长连接状态卡（🔄 重连）：只读展示当前连接态 + 自动重连说明，无副作用。SDK 自带
 * 断线重连，这里不主动 force-reconnect（无可靠 API），只把状态摊给管理员看，长期
 * 断开就引导去终端重跑/重启。private chat 菜单与首页卡按钮共用这一张，单一事实源。
 */
export function buildReconnectCard(conn: string): CardObject {
  const template = conn === 'connected' ? 'green' : 'orange';
  return card(
    [
      md(`长连接状态：**${conn}**`),
      note('SDK 会自动重连；若长期断开，请在启动终端里 Ctrl+C 后重新运行 `vonvon daemon run`。'),
      backToMenu(),
    ],
    { header: { title: '🔄 长连接', template } },
  );
}

export function buildForegroundRestartCard(): CardObject {
  return card(
    [
      md('当前为**前台运行**。'),
      note('前台运行时不支持在此重启。请在启动终端里 Ctrl+C 后重新运行 `vonvon daemon run`。重启期间机器人会离线。'),
      backToMenu(),
    ],
    { header: { title: '🔁 重启说明', template: 'orange' } },
  );
}

/** Snapshot the doctor card renders + folds into a copy-paste prompt for codex.
 * Gathered by the handler (file checks, versions, live connection state) so the
 * builder stays pure and testable. */
export interface DoctorInfo {
  /** codex CLI resolvable and runnable (backend.isAvailable) */
  codexOk: boolean;
  /** codex --version string, or null if unresolved */
  codexVer: string | null;
  /** Feishu long-connection state (channel.getConnectionStatus().state) */
  conn: string;
  /**
   * 机器人自身的 open_id（`ou_…`，来自 bot/v3/info）。运行时用凭据换 token 现查，
   * 没换成（凭据失效 / 网络不通）→ undefined，卡片显示「未能获取」而非空字段；
   * 拿不到不算硬故障，不会把 header 升橙。
   */
  botOpenId?: string;
  /** the bridge's own version */
  bridgeVer: string;
  /** process.version */
  node: string;
  /** `${platform}-${arch}` */
  platform: string;
  /** background daemon stdout log path (launchd) */
  logStdout: string;
  /** background daemon stderr log path (launchd) */
  logStderr: string;
  /** current bot's config.json path */
  configFile: string;
  /**
   * 飞书权限自检：尚未开通的必需 scope（来自 application/v6/scopes 的 grant_status，
   * 含 im:message.group_msg 等事件订阅类）。`undefined` = 没查成（凭证失效 / 网络
   * 不通 / 接口不可用），与 `[]`（全部已开通）严格区分，卡片据此分三态渲染——
   * 绝不把"查不到"误报成"缺失"。
   */
  missingScopes?: string[];
  /**
   * 开放平台「权限管理」一键开通页：缺失时预选缺失项、否则预选全部必需 scope。
   * 用户点开即已勾好待申请权限，保存即生效（自建应用无需审核）。
   */
  scopeGrantUrl: string;
  /**
   * 「加入存量群」可选 scope（{@link JOIN_GROUP_SCOPES}）尚未开通的项，三态同
   * {@link missingScopes}（undefined = 查不到）。不属必需，仅在诊断卡里提示，
   * 让存量用户能发现并开通。
   */
  missingJoinScopes?: string[];
  /** 一键开通页，预选「加入存量群」那两项 scope。 */
  joinScopeGrantUrl: string;
  /**
   * 事件订阅诊断（版本信息 API：从未发布版本 / 缺 im.message.receive_v1 / 配置
   * 齐全，外加 unchecked 降级；见 utils/event-diagnosis.ts）。undefined = 调用方
   * 未接线 / 没跑诊断 → 卡片不渲染该块（保持旧行为，与 unchecked 严格区分）。
   */
  eventDiagnosis?: EventDiagnosis;
  /** 开发者后台「事件与回调」页深链（无预选参数可用，纯落地页）。 */
  eventConfigUrl?: string;
}

/** Friendly label for a long-connection state; unknown states show raw. */
function connLabel(state: string): string {
  switch (state) {
    case 'connected':
      return '✅ 已连接';
    case 'connecting':
      return '⏳ 连接中';
    case 'reconnecting':
      return '↻ 重连中';
    case 'disconnected':
      return '❌ 已断开';
    default:
      return state;
  }
}

/** One-line 飞书权限 status for the copy-paste codex prompt (plain text). */
function scopeStatusText(i: DoctorInfo): string {
  if (i.missingScopes === undefined) return '未能自动检查（凭证失效或网络问题）';
  if (i.missingScopes.length === 0) return '必需权限齐全';
  return `缺失 ${i.missingScopes.length} 项：${i.missingScopes.join(' ')}`;
}

/**
 * 「飞书权限」诊断块：把 {@link DoctorInfo.missingScopes} 的三态渲染成一行状态，
 * 缺失或查不到时再附一个直达开放平台、已预选待开通 scope 的「去开通」按钮——
 * 用户点开即勾好、保存即生效，无需自己对照清单。
 */
function scopeDiagnosis(i: DoctorInfo): CardElement[] {
  if (i.missingScopes === undefined) {
    return [
      md('- 飞书权限：⚠️ 无法自动检查（凭证失效或网络不通）'),
      actions([linkButton('🔑 去权限页核对', i.scopeGrantUrl)]),
    ];
  }
  if (i.missingScopes.length === 0) {
    return [md('- 飞书权限：✅ 必需权限已全部开通')];
  }
  return [
    md(`- 飞书权限：❌ 缺 ${i.missingScopes.length} 项 —— 开通前相关功能（收发消息 / 卡片 / 图片 / 建群等）不可用`),
    note(`待开通：\n${i.missingScopes.map((s) => `· ${labelScope(s)}`).join('\n')}`),
    actions([linkButton('🔑 一键去开通这些权限', i.scopeGrantUrl)]),
  ];
}

/**
 * 「事件订阅」诊断块：版本信息 API 的三态 + unchecked 降级。eventDiagnosis 没接线
 * （undefined）时整块不渲染，保持旧卡片形状——接线只需 handler 多填两个字段。
 */
function eventSubscriptionDiagnosis(i: DoctorInfo): CardElement[] {
  const d = i.eventDiagnosis;
  if (!d) return [];
  const goBtn: CardElement[] = i.eventConfigUrl ? [actions([linkButton('⚡ 去事件配置页', i.eventConfigUrl)])] : [];
  switch (d.state) {
    case 'ok': {
      const out: CardElement[] = [md(`- 事件订阅：✅ 版本 v${d.version ?? '?'} 已订阅 \`im.message.receive_v1\``)];
      if (d.missingOptional?.length) {
        out.push(note(`可选事件未订阅（对应功能静默关闭）：\n${d.missingOptional.map((e) => `· ${e}`).join('\n')}`));
      }
      return out;
    }
    case 'missing':
      return [
        md(`- 事件订阅：❌ 已发布版本 v${d.version ?? '?'} 缺 ${(d.missingRequired ?? []).map((e) => `\`${e}\``).join('、')} —— @我 不会有反应`),
        note('去「事件配置」标签添加缺的事件（订阅方式选长连接），再创建版本并发布生效。'),
        ...goBtn,
      ];
    case 'unpublished':
      return [
        md('- 事件订阅：❌ 从未发布过版本 —— 事件订阅未生效，@我 不会有反应'),
        note('去「事件配置」标签订阅 `im.message.receive_v1`（订阅方式选长连接），再到「应用发布」创建版本并发布。'),
        ...goBtn,
      ];
    case 'unchecked':
      return [
        md(`- 事件订阅：⚠️ 无法自动检查（${d.reason ?? '未知原因'}）`),
        note('开通「读取应用版本信息」权限（application:application.app_version:readonly，上方 🔑 一键开通链接已含）后可自动检测。'),
      ];
  }
}

/**
 * 「加入存量群」诊断块：这俩 scope 是 opt-in（不在 REQUIRED_SCOPES 里，所以
 * 启动/凭据校验都不会提示），存量用户最容易漏。这里把 scope 状态显式渲染出来、
 * 缺失时给「去开通」按钮；事件订阅状态有诊断结果（eventDiagnosis.events）时按
 * 真实状态渲染，否则附一条未能自动检测的提醒。
 */
function joinFeatureDiagnosis(i: DoctorInfo): CardElement[] {
  const out: CardElement[] = [md('**加入存量群（可选）**')];
  if (i.missingJoinScopes === undefined) {
    out.push(md('- 权限：⚠️ 未能自动检查（凭据失效或网络不通）'), actions([linkButton('🔑 去开通', i.joinScopeGrantUrl)]));
  } else if (i.missingJoinScopes.length === 0) {
    out.push(md('- 权限：✅ 已开通（`im:chat:readonly` / `im:chat.members:write_only`）'));
  } else {
    out.push(
      md(`- 权限：❌ 缺 ${i.missingJoinScopes.length} 项 —— 开通后才能把我加进已有群（绑定 / 退群）`),
      note(`待开通：\n${i.missingJoinScopes.map((s) => `· ${labelScope(s)}`).join('\n')}`),
      actions([linkButton('🔑 一键开通这两项权限', i.joinScopeGrantUrl)]),
    );
  }
  const subscribed = i.eventDiagnosis?.events;
  if (subscribed) {
    const wanted = ['im.chat.member.bot.added_v1', 'im.chat.member.bot.deleted_v1'];
    const missing = wanted.filter((e) => !subscribed.includes(e));
    out.push(
      missing.length === 0
        ? note('事件：✅ 已订阅 `im.chat.member.bot.added_v1` / `im.chat.member.bot.deleted_v1`')
        : note(`⚠️ 还需在后台「事件与回调」订阅：${missing.map((e) => `\`${e}\``).join('、')} —— 缺则该功能静默关闭。`),
    );
  } else {
    out.push(
      note(
        '⚠️ 还需在后台「事件与回调」手动订阅 `im.chat.member.bot.added_v1`（被拉进群→推送绑定卡）和 ' +
          '`im.chat.member.bot.deleted_v1`（被移出群→自动解绑）—— 本次未能自动检测订阅状态（需「读取应用版本信息」权限）。',
      ),
    );
  }
  return out;
}

/**
 * The self-contained prompt the user copies into a project group and @s the bot
 * with. Since codex runs locally on the same machine, handing it the absolute
 * log paths lets it actually read the logs and diagnose. Keep this plain text
 * (no markdown / backticks) — it's pasted verbatim as a chat message.
 */
function codexDiagnosePrompt(i: DoctorInfo): string {
  return [
    '我在用 Vonvon Bot（飞书 ↔ 本地 Codex / Claude Code）遇到问题，请帮我定位原因并给出修复步骤。',
    '',
    '【环境】',
    `- Vonvon Bot 版本：v${i.bridgeVer}`,
    `- codex 版本：${i.codexVer ?? '未找到（PATH / CODEX_BIN 里都没有 codex）'}`,
    `- Node：${i.node}`,
    `- 平台：${i.platform}`,
    `- 官网：${SITE_URL}`,
    '',
    '【运行快照】',
    `- codex 可用：${i.codexOk ? '是' : '否'}`,
    `- 飞书长连接：${i.conn}`,
    `- 飞书权限：${scopeStatusText(i)}`,
    ...(i.eventDiagnosis ? [`- 事件订阅：${summarizeEventDiagnosis(i.eventDiagnosis)}`] : []),
    '',
    '【请你做的事】',
    '1. 读取并分析日志，找出最近的报错或异常堆栈：',
    `   - 后台守护输出日志：${i.logStdout}`,
    `   - 后台守护错误日志：${i.logStderr}`,
    '   （若是前台 vonvon daemon run 模式，日志在启动它的终端窗口，请把终端里的报错一起发我）',
    `2. 判断问题属于哪类：codex 启动 / 登录、飞书鉴权或权限不足、长连接断开、还是配置缺失（配置文件：${i.configFile}）。`,
    `3. 必要时对照官网文档给方案：${SITE_URL}`,
    '4. 给出可直接执行的修复步骤。',
    '',
    '【我遇到的现象】',
    '（在这里补充：比如 @机器人不回复 / 卡片按钮点了没反应 / 启动就报错……）',
  ].join('\n');
}

/**
 * Diagnostics card for the DM console (🩺 诊断). Top half is a quick local
 * self-check (codex + long connection + version/platform); bottom half is a
 * copy-paste code block the user hands to codex for a deep, log-backed
 * diagnosis, plus the site / feedback-group links. Sent as a reply (terminal card) — re-open
 * the console by messaging the bot.
 */
export function buildDoctorCard(i: DoctorInfo): CardObject {
  const prompt = codexDiagnosePrompt(i);
  // codex 不可用、明确查到缺权限、或事件订阅明确未生效 → 橙色警示；
  // "没查成"(undefined / unchecked) 不算硬故障，保持蓝。
  const hasProblem =
    !i.codexOk ||
    (i.missingScopes !== undefined && i.missingScopes.length > 0) ||
    i.eventDiagnosis?.state === 'missing' ||
    i.eventDiagnosis?.state === 'unpublished';
  return card(
    [
      md('**初步诊断**'),
      md(
        `- Codex：${i.codexOk ? `✅ 可用${i.codexVer ? `（${i.codexVer}）` : ''}` : '❌ 不可用（检查 CODEX_BIN / PATH）'}`,
      ),
      md(`- 飞书长连接：${connLabel(i.conn)}`),
      md(`- 机器人 open_id：${i.botOpenId ? `\`${i.botOpenId}\`` : '⚠️ 未能获取（凭据失效或网络不通）'}`),
      ...scopeDiagnosis(i),
      ...eventSubscriptionDiagnosis(i),
      note(`Vonvon Bot v${i.bridgeVer}　·　Node ${i.node}　·　${i.platform}`),
      hr(),
      ...joinFeatureDiagnosis(i),
      hr(),
      md('**日志路径**'),
      note(`后台守护输出：\`${i.logStdout}\``),
      note(`后台守护错误：\`${i.logStderr}\``),
      note('前台 `run` 模式：日志在启动它的终端窗口里'),
      hr(),
      md('**让 Codex 帮你深度诊断** — 复制下面整段，到任意项目群里 **@我** 粘贴发送：'),
      md('```\n' + prompt + '\n```'),
      actions([
        linkButton('🌐 官网', SITE_URL),
        linkButton('💬 反馈', FEEDBACK_URL),
      ]),
    ],
    { header: { title: '🩺 诊断', template: hasProblem ? 'orange' : 'blue' } },
  );
}

/**
 * Interactive new-project form: project name + optional CWD + **backend picker**
 * + submit/cancel. The backend is chosen here, at creation, and fixed afterwards
 * (no switching). `backends` lists only the downloaded + permission-compatible
 * options (computed by the handler via {@link projectCreatableBackends}); when
 * just one (codex baseline), it's shown as a static note instead of a dropdown.
 */
export function buildNewProjectFormCard(
  opts: { name?: string; cwd?: string; error?: string; backends?: SelectOption[] } = {},
): CardObject {
  const elements = [];
  if (opts.error) elements.push(md(`❌ **创建失败**：${opts.error}`));
  const backends = opts.backends ?? [];
  const formItems: CardElement[] = [
    input({ name: 'name', label: '项目名', placeholder: 'my-app', value: opts.name, required: true }),
    input({ name: 'cwd', label: '文件夹路径（选填，留空自动新建）', placeholder: '/Users/you/code/my-app', value: opts.cwd }),
  ];
  if (backends.length > 1) {
    formItems.push(
      note('🧠 后端 Agent（创建后**固定不可切换**；标注「未下载」的需先去 Web「后端 Agent」页下载，选它会提示）'),
      selectMenu({ name: 'backend', placeholder: '选择后端 Agent', options: backends, initial: backends[0]?.value }),
    );
  } else if (backends.length === 1) {
    formItems.push(note(`🧠 后端 Agent：**${backends[0]!.label}**（创建后固定）`));
  }
  formItems.push(...sessionModeItems('创建', { a: DM.newProjectSubmit }), actions([button('⬅️ 菜单', { a: DM.menu })]));
  elements.push(
    md('填项目名（必填）。**文件夹路径留空** = 为这个群新建独立目录；**填绝对路径** = 用电脑上已有的文件夹。'),
    form('new_project', formItems),
  );
  return card(elements, { header: { title: '➕ 新建项目', template: 'turquoise' } });
}

/**
 * A creation that may have made a group (s36d1): the request reached Feishu and no answer says what came of it, or
 * the group exists and its row was not saved (`chatId` then opens it, and the warning already says it was built).
 * It repeats what was asked but carries no form, so one more click cannot create a second group; 新建项目 from the
 * menu starts a new request.
 */
export function buildNewProjectUncertainCard(opts: { name: string; cwd?: string; warning: string; chatId?: string }): CardObject {
  return card([
    md(opts.chatId ? `⚠️ ${opts.warning}` : `⚠️ **不确定建好没有**：${opts.warning}`),
    note(`项目名：${opts.name}   ·   文件夹：${opts.cwd || '留空（为这个群新建独立目录）'}`),
    actions([
      ...(opts.chatId ? [linkButton('💬 打开群聊', openChatUrl(opts.chatId), 'primary')] : []),
      button('⬅️ 菜单', { a: DM.menu }),
    ]),
  ], { header: { title: '➕ 新建项目', template: 'orange' } });
}

/**
 * 会话方式 in the order and words of product.md 3.4, then 免@. One submit button per
 * mode, so nothing is preselected and nothing is marked as recommended.
 * 免@ left unpicked takes the mode's default (多会话开，单会话关), see {@link parseNoMentionPick}.
 * 智能 has no 免@: the buttons share one form, so its pick is dropped rather than hidden (s25c).
 */
function sessionModeItems(verb: string, value: ActionValue, topic = false): CardElement[] {
  const modes = topic ? [['topic', topicConversationCopy.threads], ['smart', topicConversationCopy.smart]] as const : [['multi', conversationCopy.threads], ['single', conversationCopy.shared], ['smart', conversationCopy.smart]] as const;
  return [
    md('**会话方式**（点下面的按钮就选了这一项）'),
    ...modes.map(([, copy]) => note(`**${copy.title}**：${copy.subtitle}`)),
    selectMenu({
      name: 'noMention',
      placeholder: topic ? '免 @：不选就是开（不 @ 也回）；智能开话题没有这一项' : '免 @：不选就按会话方式（@ 我开新会话 开，整群一条会话 关；智能开话题没有这一项）',
      options: [{ label: '免 @ 开：不 @ 也回', value: 'on' }, { label: '免 @ 关：@ 我才回', value: 'off' }],
    }),
    actions(modes.map(([kind, copy]) => submitButton(`${verb}·${copy.title}`, { ...value, kind }, 'default', `submit_${kind}`))),
  ];
}

/** The 项目 pick from the setup card: 'join' (also when left unpicked) or 'new'. Anything else counts as unpicked. */
export function parseProjectPick(formValue: Record<string, unknown> | undefined): 'join' | 'new' {
  return formValue?.project === 'new' ? 'new' : 'join';
}

/** The 免@ pick from {@link sessionModeItems}; undefined when left unpicked. */
export function parseNoMentionPick(formValue: Record<string, unknown> | undefined): boolean | undefined {
  const v = formValue?.noMention;
  return v === 'on' ? true : v === 'off' ? false : undefined;
}

/**
 * Bind-an-existing-group form. Reached when a human adds the bot to a group and
 * the bot DMs the privileged adder or owner. Mirrors {@link buildNewProjectFormCard} but the name
 * input is pre-filled with the group's name (still editable — lets the user
 * dodge a name clash), and the submit buttons carry the group's `chatId` so the
 * handler binds *this* group instead of creating a new one.
 */
export function buildJoinGroupFormCard(
  opts: { chatId: string; name?: string; cwd?: string; error?: string; backends?: SelectOption[];
    backend?: string; topic?: boolean; hasOtherBots?: boolean; addedBy?: { name?: string }; fullOnly?: string;
    /** The project another bot already works in for this group: the card then offers it next to a new one. Only the name
     * goes on the card; the daemon looks the project up again on submit, so no id can be posted back (§5.6). */
    sibling?: { name: string } },
): CardObject {
  const elements: CardElement[] = [];
  if (opts.error) elements.push(md(`❌ **绑定失败**：${opts.error}`));
  const backends = opts.backends ?? [];
  const formItems: CardElement[] = [
    input({ name: 'name', label: '项目名', placeholder: 'my-app', value: opts.name, required: true }),
    note('项目名默认用群名，可改。'),
    input({ name: 'cwd', label: '工作区（选填）', placeholder: '留空就给这个群新建一个目录；填本机已有目录的绝对路径就用它', value: opts.cwd }),
  ];
  if (backends.length > 1) {
    formItems.push(
      note('🧠 后端（绑定后不能换）。默认用这个 bot 的后端。'),
      selectMenu({ name: 'backend', placeholder: '选择后端 Agent', options: backends, initial: opts.backend ?? backends[0]?.value }),
    );
  } else if (backends.length === 1) {
    formItems.push(note(`🧠 后端 Agent：**${backends[0]!.label}**（绑定后固定）`));
  }
  if (opts.sibling) {
    formItems.push(
      note('📁 项目：同一个群的 Bot 默认共用项目；要分开就新建。别的项目只能在网页端选。'),
      selectMenu({ name: 'project', placeholder: '选择项目', initial: 'join', options: [
        { label: `加入本群已有的项目「${opts.sibling.name}」`, value: 'join' },
        { label: `新建项目「${opts.name || '本群'}」`, value: 'new' },
      ] }),
    );
  }
  formItems.push(note('🔒 权限：只读（不联网）。设置好以后在群详情页或私聊里改。'));
  if (opts.fullOnly) formItems.push(note(`ℹ️ ${opts.fullOnly} 选 Codex 也能绑定，@ 我时我会回一句说明。要用，绑定后在群设置里改成完全访问。`));
  formItems.push(...sessionModeItems('绑定', { a: DM.joinGroupSubmit, chatId: opts.chatId, ...(opts.topic ? { t: 'topic' } : {}) }, opts.topic));
  if (opts.hasOtherBots) formItems.push(note('群里还有别的 bot。几个 bot 都选智能，它们才能互相 @、各自判断接不接话。'));
  const group = opts.name ? `「${opts.name}」` : '一个群（没读到群名）';
  const introduction = opts.error ? '重新选一下，点下面对应的按钮。' : opts.addedBy
    ? `**${opts.addedBy.name || '有人'}** 把我拉进了${group}。拉我的不是管理员，所以发给你。设置好才能用：选会话方式，点下面对应的按钮。`
    : `你把我拉进了${group}。设置好才能用：选会话方式，点下面对应的按钮。`;
  elements.push(
    md(introduction),
    note('设置好之前，群里 @ 我只回一句“主人还没设置好这个群”。这张卡不过期；也可以在网页的 Bot 页点「加入飞书群」设置。'),
    form('join_group', formItems),
  );
  return card(elements, { header: { title: '🔗 设置这个群', template: 'turquoise' } });
}

/** Shown after a project is created/bound — a terminal "留痕" record with a
 * jump-to-group button so the admin can hop straight into the group and start
 * working. (Re-open the console any time by messaging the bot.) `droppedNoMention`:
 * the form picked 免@ and the group went 智能, which has none (s25c). */
export function buildNewProjectDoneCard(p: Project, droppedNoMention = false, topic = false): CardObject {
  const joined = (p.origin ?? 'created') === 'joined';
  const verb = joined ? '已绑定群' : '已创建项目';
  const title = joined ? '🔗 绑定已有群' : '➕ 新建项目';
  const backendId = groupBackendId(p);
  const backendName = catalogById(backendId)?.displayName ?? backendId;
  const elements: CardElement[] = [
    md(`✅ ${verb} **${p.name}**${p.blank ? ' _(空白项目)_' : ''}`),
    note(`📂 \`${p.cwd}\`   ·   ${topic && sessionModeOf(p) === 'multi' ? '按话题聊' : kindLabel(p)}   ·   🧠 ${backendName}`),
    ...(droppedNoMention ? [note('智能开话题没有免 @，刚才选的没用上。')] : []),
    ...(groupPermission(p).effect.mode === 'full' ? [note(`🔓 权限：完全访问。${FULL_ACCESS_WARNING}`)] : []),
    md(p.chatId ? '👉 去群里 **@我** 干活。' : '发我任意消息可再次打开管理台。'),
  ];
  if (p.chatId)
    elements.push(
      actions([
        linkButton('💬 打开群聊', openChatUrl(p.chatId), 'primary'),
        button('⚙️ 项目设置', { a: DM.projectSettings, n: p.name }),
      ]),
    );
  return card(elements, { header: { title, template: 'green' } });
}

/** Max topics listed in one project's topics card. Feishu caps a card at ~200
 * components (error 300305 "element exceeds the limit"); even a single very
 * active project stays well under this with a generous cap + "+N more" tail. */
const PROJECT_TOPICS_MAX = 50;

/** Projects per page in the overview. Feishu counts NESTED components against
 * its ~200-element cap (error 300305 "element exceeds the limit", which the
 * platform silently DROPS — no error card), and each project's action row of up
 * to 4 buttons expands to ~13 components (column_set + a column/button/plain_text
 * per button) — so a project costs ~17 components, NOT the ~4 visible elements.
 * Measured against the real 39-project store: a page of 12 = 214 components
 * (still over, still dropped); a page of 8 = ~146, comfortably under (a known-OK
 * 50-row topics card sits near ~150). Keep this ≤ ~8 unless the row slims down. */
const PROJECT_LIST_PAGE_SIZE = 8;

/** Project list — a SLIM, PAGED overview: one summary line per project + a row
 * of actions (the 🧵 button drills into that project's topics). Topics are NOT
 * listed inline: an active group accumulates dozens, and rendering them all
 * pushed the whole card past Feishu's ~200-component cap (→ silent overflow).
 * `page` (0-indexed) is clamped to a valid page, so a stale 下一页 click or a
 * list that shrank after a delete never lands on an empty page; topics live in
 * {@link buildProjectTopicsCard}. */
export function buildProjectListCard(
  projects: Project[],
  sessionsByChat: Map<string, SessionRecord[]> = new Map(),
  page = 0,
): CardObject {
  if (projects.length === 0) {
    return card(
      [md('还没有项目。点 **➕ 新建项目** 或直接发我一个项目名。'), actions([button('⬅️ 菜单', { a: DM.menu })])],
      { header: { title: '📁 项目列表', template: 'wathet' } },
    );
  }
  const pageCount = Math.ceil(projects.length / PROJECT_LIST_PAGE_SIZE);
  const cur = Math.min(Math.max(Math.trunc(page) || 0, 0), pageCount - 1);
  const start = cur * PROJECT_LIST_PAGE_SIZE;
  const elements: CardObject[] = [];
  for (const p of projects.slice(start, start + PROJECT_LIST_PAGE_SIZE)) {
    const topicCount = (p.chatId ? sessionsByChat.get(p.chatId) : undefined)?.length ?? 0;
    const dir = `📂 \`${p.cwd}\`${p.branch && p.branch !== '—' ? `   🌿 ${p.branch}` : ''}`;
    // 智能 has no 免@ (s25c).
    const meta = p.chatId
      ? `${kindLabel(p)}${(p.origin ?? 'created') === 'joined' ? ' · 🔗已加入' : ''}${sessionModeOf(p) === 'smart' ? '' : `   ·   免@：${noMentionOf(p) ? '开' : '关'}`}`
      : '⚠️ 未绑定群';
    elements.push(md(`**${p.name}**${p.blank ? ' _(空白)_' : ''}`));
    elements.push(note(`${dir}\n${meta}`));
    const row: CardObject[] = [];
    if (p.chatId) row.push(linkButton('💬 打开群聊', openChatUrl(p.chatId)));
    row.push(button(`🧵 ${topicCount} 话题`, { a: DM.projectTopics, n: p.name }));
    row.push(button('⚙️ 设置', { a: DM.projectSettings, n: p.name }));
    row.push(button('🗑 删除', { a: DM.rmConfirm, n: p.name }, 'danger'));
    elements.push(actions(row));
    elements.push(hr());
  }
  elements.push(
    note(pageCount > 1 ? `共 ${projects.length} 个项目 · 第 ${cur + 1}/${pageCount} 页` : `共 ${projects.length} 个项目`),
  );
  const nav: CardObject[] = [];
  if (cur > 0) nav.push(button('⬅️ 上一页', { a: DM.projects, p: cur - 1 }));
  if (cur < pageCount - 1) nav.push(button('下一页 ➡️', { a: DM.projects, p: cur + 1 }));
  nav.push(button('⬅️ 菜单', { a: DM.menu }));
  elements.push(actions(nav));
  return card(elements, { header: { title: '📁 项目列表', template: 'wathet' } });
}

/** Topic drill-down: one project's topics (sessions), newest first, capped to
 * stay under the component limit. Reached via the 🧵 button on the overview. */
export function buildProjectTopicsCard(
  project: Pick<Project, 'name' | 'chatId'>,
  sessions: SessionRecord[],
): CardObject {
  const elements: CardObject[] = [md(`**${project.name}** · 共 ${sessions.length} 个话题`)];
  if (sessions.length === 0) {
    elements.push(note('（暂无话题）'));
  } else {
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const s of sorted.slice(0, PROJECT_TOPICS_MAX)) {
      const title = (s.summary || '(空)').replace(/\s+/g, ' ').slice(0, 50);
      elements.push(note(`· ${title} · ${relativeTime(s.updatedAt)}`));
    }
    if (sorted.length > PROJECT_TOPICS_MAX) {
      elements.push(note(`· …还有 ${sorted.length - PROJECT_TOPICS_MAX} 个话题（更早的可在群里 \`/resume\` 恢复）`));
    }
  }
  const nav: CardObject[] = [];
  if (project.chatId) nav.push(linkButton('💬 打开群聊', openChatUrl(project.chatId)));
  nav.push(button('⬅️ 项目列表', { a: DM.projects }));
  elements.push(hr(), actions(nav));
  return card(elements, { header: { title: `🧵 话题 · ${project.name}`, template: 'wathet' } });
}

export function buildRmConfirmCard(name: string, origin?: 'created' | 'joined'): CardObject {
  const note_ =
    (origin ?? 'created') === 'joined'
      ? '仅解绑（移除注册），**不删代码目录**。确认后**我会退出该群**（群是你们的，不会解散）。'
      : '仅解绑（移除注册 + 撤销置顶横幅），**不删代码目录**。群主会转给你，再由你自行在飞书解散群。';
  return card(
    [
      md(`确定删除项目 **${name}**？`),
      note(note_),
      actions([
        button('✅ 确认删除', { a: DM.rmDo, n: name }, 'danger'),
        button('取消', { a: DM.rmCancel }),
      ]),
    ],
    { header: { title: '🗑 删除项目', template: 'red' } },
  );
}

/** A label line + a row of option buttons; the currently-selected option is
 * highlighted (primary). Each button carries `{ a: actionId, v: <value> }`, so
 * tapping any option sets that value directly (no cycling). Distinct values keep
 * each option's callback unique; managed.ts's per-render token lets a value you
 * already picked once be picked again. */
function optionRow(
  label: string,
  actionId: string,
  current: string,
  opts: { label: string; value: string }[],
): CardElement[] {
  return [
    md(label),
    actions(opts.map((o) => button(o.label, { a: actionId, v: o.value }, o.value === current ? 'primary' : 'default'))),
  ];
}

/** 设置卡分区小标题（灰、加粗、notation 字号）—— 把设置项按主题分组。 */
function settingSection(title: string): CardElement {
  return { tag: 'markdown', content: `**${title}**`, text_size: 'notation', text_color: 'grey' };
}

/**
 * 带说明的设置项：加粗名称 + 灰字说明 + 选项按钮行（当前值高亮 primary）。说明让
 * 每项自解释（“看不懂这开关是啥”的解法）。按钮而非 select：select 一交互即锁
 * card_id（见下方 {@link buildSettingsCard} 注释）。
 */
function settingItem(
  name: string,
  desc: string,
  actionId: string,
  current: string,
  opts: { label: string; value: string }[],
): CardElement[] {
  return [
    md(`**${name}**`),
    note(desc),
    actions(opts.map((o) => button(o.label, { a: actionId, v: o.value }, o.value === current ? 'primary' : 'default'))),
  ];
}

/** Compact, IO-free status for the document-comment entry on the global card. */
function summarizeCommentSettings(cfg: AppConfig): string {
  // What a comment runs on: the settings, else the bot default, else built in (s36d2).
  const comments = resolveCommentsExecution(cfg.preferences);
  const backend = catalogById(comments.backend)?.displayName ?? comments.backend;
  const model = comments.model?.model ?? '默认模型';
  const effort = comments.model?.effort ? reasoningEffortLabel(comments.model.effort) : '默认推理强度';
  return `${backend} · ${model} · ${effort}`;
}

export function buildVoiceSettingsCard(cfg: AppConfig, notice?: string): CardObject {
  const v = voiceView(cfg);
  const testing = v.feishu.state === 'testing';
  const cooling = (v.feishu.retryAt ?? 0) > Date.now();
  const toggle = button(v.enabled ? '已开启 · 点击关闭' : '已关闭 · 点击开启', { a: DM.setVoice, v: v.enabled ? 'off' : 'on' }, v.enabled ? 'primary' : 'default');
  const test = button(testing ? '检测中…' : '测试', { a: DM.testVoice });
  return card([
    md(VOICE_DESCRIPTION),
    actions([{ ...toggle, disabled: !v.enabled && testing }]),
    md(notice ?? `${v.result}${v.feishu.code ? `（${v.feishu.code}）` : ''}`),
    ...(cooling ? [note(`可重试时间：${new Date(v.feishu.retryAt!).toLocaleTimeString()}`)] : []),
    ...(v.enabled && v.feishu.state === 'missing_permission' ? [
      note('授权并发布应用后，点击重新检测。'),
      actions([linkButton('去授权', v.grantUrl), button('重新检测', { a: DM.refreshVoicePermission })]),
    ] : []),
    actions([button('⬅️ 设置', { a: DM.settings }), ...(v.enabled ? [{ ...test, disabled: testing }] : [])]),
  ], { header: { title: '🎙️ ' + VOICE_TITLE }, forward: false });
}

/**
 * Global preferences card. Grouped into sections, each
 * setting a self-explaining {@link settingItem} (name + grey caption + option
 * buttons, current value highlighted). Buttons, not select_static, on purpose:
 * Feishu locks a card_id once a select has been interacted with, after which
 * *every* button on it (including ⬅️ 菜单) stops firing. Buttons never lock, so
 * this card stays fully interactive and updates in place. `notice` = 卡顶提示行。
 */
export function buildSettingsCard(cfg: AppConfig, notice?: string): CardObject {
  const watchdogSec = normalizeRunIdleTimeoutSeconds(cfg.preferences?.runIdleTimeoutSeconds);
  const completionReminder = getCompletionReminderConfig(cfg);
  return card(
    [
      ...(notice ? [md(notice)] : []),
      settingSection('⏱ 运行控制'),
      md(`**⏱ 假死超时** · 当前 **${watchdogSec === 0 ? '关闭' : watchdogSec % 60 === 0 ? `${watchdogSec / 60} 分钟` : `${watchdogSec} 秒`}**`),
      note('多久没有任何输出就自动终止本轮（防卡死）。'),
      actions([
        ...[0, 300, RUN_IDLE_TIMEOUT_DEFAULT_SEC].map((v) =>
          button(v === 0 ? '关闭' : `${v / 60} 分钟`, { a: DM.setWatchdog, v: String(v) }, v === watchdogSec ? 'primary' : 'default'),
        ),
        button('自定义…', { a: DM.watchdogCustom }),
      ]),
      ...settingItem(
        '🔔 任务结束提醒',
        '结束后额外回复一条消息并 @ 发起人。「仅手动」会在运行卡显示提醒按钮；其他档位自动判断，不显示按钮。',
        DM.setCompletionReminder,
        completionReminder.mode,
        [
          { label: '仅手动', value: 'manual' },
          { label: '长任务', value: 'long' },
          { label: '失败或超时', value: 'failures' },
          { label: '每次结束', value: 'always' },
        ],
      ),
      ...(completionReminder.mode === 'long'
        ? [
            md(`**⏳ 长任务阈值** · 当前 **${completionReminder.longTaskMinutes} 分钟**`),
            note('任务耗时达到这个阈值后，结束时才会提醒。'),
            actions([button('修改阈值…', { a: DM.completionReminderCustom })]),
          ]
        : []),
      ...settingItem(
        '📥 运行中来新消息',
        '正在跑时你又发消息：引导＝插进当前轮纠偏；排队＝等这轮跑完再处理。',
        DM.setPending,
        getPendingPolicy(cfg),
        [
          { label: '引导', value: 'steer' },
          { label: '排队', value: 'queue' },
        ],
      ),
      ...settingItem(
        '⚡ 并发上限',
        '所有群 / 话题全局同时最多跑几个，满了排队（排队卡可 ⏹ 取消）。改后需重启生效。',
        DM.setConcurrency,
        String(getMaxConcurrentRuns(cfg)),
        [
          { label: '1', value: '1' },
          { label: '5', value: '5' },
          { label: '10', value: '10' },
          { label: '20', value: '20' },
        ],
      ),
      hr(),
      note('会话标题与云文档评论分别配置，互不影响，也不会改变普通聊天使用的模型。'),
      md('**🏷️ 会话标题**'),
      note('让 Bridge 新建的会话在 Claude Code / Codex 的恢复列表（/resume）中显示易识别的标题。'),
      md(`**当前策略**\n${summarizeSessionTitles(cfg, reasoningEffortLabel)}`),
      actions([button('配置会话标题', { a: DM.sessionTitleSettings }, 'primary')]),
      hr(),
      md('**📝 云文档评论**'),
      note('在飞书文档、表格或多维表格（含 wiki）的评论里 @我，自动运行 Agent 并回复；回复规则可控制是否直接修改文档。'),
      md(`**当前**：${summarizeCommentSettings(cfg)}`),
      actions([button('配置评论处理', { a: DM.commentSettings }, 'primary')]),
      hr(),
      md('**🎙️ ' + VOICE_TITLE + '**'),
      note(VOICE_DESCRIPTION),
      note(`${VOICE_NOTICE} [飞书 ASR 文档](${VOICE_DOC_URL})`),
      actions([button(cfg.preferences?.voice?.enabled ? '去关闭' : '去开启', { a: DM.voiceSettings })]),
      hr(),
      actions([button('👮 管理员', { a: DM.admins }), button('⬅️ 菜单', { a: DM.menu })]),
    ],
    { header: { title: '⚙️ 全局设置', template: 'blue' } },
  );
}

/** Action ids on old cards for 咖啡一下, which s02b removed: the entry on the
 * settings card and the controls on its sub-card. */
export const COFFEE_RETIRED_ACTIONS = [
  'dm.coffee.settings',
  'cli.toggle.enabled',
  'cli.set.delivery',
  'cli.set.notifyScope',
  'cli.toggle.agent',
  'cli.toggle.keepAwake',
  'cli.toggle.includeBridge',
  'cli.hooks.repair',
] as const;

/** Top line of the settings card re-rendered after a tap on one of them. */
export const COFFEE_RETIRED = '☕ 咖啡一下第一版已经拿掉了。本机 Claude Code、Codex 要审批时，照常在终端里问。';

/** Reserved select value that switches the adjacent free-text input on. It is
 * deliberately not a model id/allowlist: any caller-provided live model id is
 * otherwise passed through unchanged, including third-party providers. */
export const SESSION_TITLE_CUSTOM_MODEL_OPTION = CUSTOM_MODEL_OPTION;

export interface SessionTitleBackendOption {
  id: string;
  label: string;
}

/** Best-effort scalar reader for Feishu form values (string / array / {value}). */
function sessionTitleFormScalar(formValue: Record<string, unknown> | undefined, name: string): string | undefined {
  const raw = formValue?.[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first === 'string') return first.trim();
  if (first && typeof first === 'object') {
    const obj = first as Record<string, unknown>;
    for (const value of [obj.value, obj.id]) {
      if (typeof value === 'string') return value.trim();
    }
  }
  return undefined;
}

export type SessionTitleFormParseResult =
  | { ok: true; config: SessionTitleAiConfig }
  | { ok: false; message: string };

/**
 * Parse the model/Effort form without consulting a model allowlist. A live
 * dropdown value is accepted verbatim; choosing “custom” makes the text input
 * authoritative. Both fields are mandatory before AI can be enabled.
 */
export function parseSessionTitleFormValue(
  formValue: Record<string, unknown> | undefined,
): SessionTitleFormParseResult {
  const selectedModel = sessionTitleFormScalar(formValue, 'model');
  const customModel = sessionTitleFormScalar(formValue, 'customModel');
  let model: string;
  if (selectedModel && selectedModel !== SESSION_TITLE_CUSTOM_MODEL_OPTION) {
    model = selectedModel;
  } else {
    if (!customModel) return { ok: false, message: '请选择模型，或填写自定义模型 ID。' };
    const parsed = parseModelId(customModel);
    if (!parsed.ok) return parsed;
    model = parsed.id;
  }

  const rawEffort = sessionTitleFormScalar(formValue, 'effort');
  if (!rawEffort || rawEffort.length > 1000) {
    return { ok: false, message: '请选择推理强度。' };
  }
  return {
    ok: true,
    config: { enabled: true, model, effort: rawEffort as ReasoningEffort },
  };
}

/**
 * Resume-title settings sub-card. The selected backend is transient UI state,
 * supplied by the caller together with that backend's live model list. Config
 * is shared by all sessions under preferences.sessionTitles.policy.
 */
export function buildSessionTitleSettingsCard(
  cfg: AppConfig,
  backendOptions: SessionTitleBackendOption[],
  selectedBackendId: string | undefined,
  models: ModelInfo[],
  notice?: string,
): CardObject {
  const policy = getSessionTitleConfig(cfg);
  const curBackend =
    (selectedBackendId && backendOptions.some((backend) => backend.id === selectedBackendId)
      ? selectedBackendId
      : policy.enabled ? policy.backend : backendOptions[0]?.id) ?? DEFAULT_BACKEND_ID;
  const visible = models.filter((model) => !model.hidden && model.id.trim());
  const configured = policy.enabled && policy.backend === curBackend ? policy : { enabled: false as const };
  const configuredLive = configured.enabled ? visible.find((model) => model.id === configured.model) : undefined;
  const initialModel = configured.enabled
    ? (configuredLive?.id ?? SESSION_TITLE_CUSTOM_MODEL_OPTION)
    : undefined;
  const customModel = configured.enabled && !configuredLive ? configured.model : undefined;
  const titleEfforts = curBackend === 'claude-agent'
    ? getSessionTitleEfforts(curBackend)
    : [...new Set([...getSessionTitleEfforts(curBackend), ...catalogEfforts(visible), ...(configured.enabled ? [configured.effort] : [])])];

  const modelSelect = {
    ...selectMenu({
      name: 'model',
      placeholder: '选择标题模型',
      options: [
        ...visible.map((model) => ({ label: model.displayName || model.id, value: model.id })),
        { label: '自定义模型 ID…', value: SESSION_TITLE_CUSTOM_MODEL_OPTION },
      ],
      initial: initialModel,
    }),
    required: true,
  };
  const effortSelect = {
    ...selectMenu({
      name: 'effort',
      placeholder: '选择推理强度',
      // 自定义/第三方模型的能力无法事先推断：给全量协议档位，
      // 而不用某个 live 模型的 supportedEfforts 反向做隐形白名单。
      options: titleEfforts.map((effort) => ({ label: reasoningEffortLabel(effort), value: effort })),
      initial: configured.enabled ? configured.effort : undefined,
    }),
    required: true,
  };

  const elements: CardElement[] = [
    ...(notice ? [md(notice)] : []),
    note(
      'Bridge 只为升级后新建的会话设置一次原生标题。生成前会移除发信人、引用、话题历史、附件等封装；短提问直接使用，长提问统一使用此处的标题模型。',
    ),
    hr(),
  ];

  if (backendOptions.length > 1) {
    elements.push(
      md('🧠 **标题 Provider**'),
      actions(
        backendOptions.map((backend) =>
          button(
            backend.label,
            { a: DM.sessionTitleSetBackend, v: backend.id },
            backend.id === curBackend ? 'primary' : 'default',
          ),
        ),
      ),
    );
  } else {
    elements.push(md(`🧠 **标题 Provider**：${backendOptions[0]?.label ?? curBackend}`));
  }

  elements.push(
    md(
      `**当前方式**：${
        policy.enabled
          ? `AI 精炼 · ${policy.model} · ${reasoningEffortLabel(policy.effort)}`
          : '截断首句（不调用模型）'
      }`,
    ),
    actions([
      button(
        policy.enabled ? '关闭 AI 标题' : '✓ 截断首句（不调用模型）',
        { a: DM.sessionTitleDisable, b: curBackend },
        policy.enabled ? 'default' : 'primary',
      ),
    ]),
    hr(),
    md('**AI 精炼（可选）**'),
    note(
      '仅长提问会调用标题模型，短提问不增加成本；调用失败会自动回退到截断首句。支持填写任意第三方模型 ID。',
    ),
    ...(visible.length === 0 ? [note('未取到实时模型列表，请选“自定义模型 ID”后填写。')] : []),
    form('session_title_model_effort', [
      md('🤖 **标题模型**'),
      modelSelect,
      input({
        name: 'customModel',
        label: '第三方 / 自定义模型 ID（仅选“自定义”时使用）',
        placeholder: '例如 provider/model-name',
        value: customModel,
        required: visible.length === 0,
        maxLength: 200,
        width: 'fill',
      }),
      md('🎚 **推理强度**'),
      effortSelect,
      actions([
        submitButton(
          '✅ 保存并使用 AI 精炼',
          { a: DM.sessionTitleSubmit, b: curBackend },
          'primary',
          'submit_session_title',
        ),
      ]),
    ]),
    hr(),
    actions([button('⬅️ 返回设置', { a: DM.settings })]),
  );

  return card(elements, { header: { title: '🏷️ 会话标题', template: 'blue' } });
}

export type CommentModelFormResolution =
  | { ok: false; message: string }
  | { ok: true; model: ModelInfo; effort?: ReasoningEffort; adjusted: boolean };

/** Resolve the comment form against the selected model, not the backend-wide
 * effort union shown by CardKit. The UI cannot dynamically cascade its effort
 * select, so an incompatible value falls back to that model's default. */
export function resolveCommentModelFormValue(
  models: ModelInfo[],
  modelId: string | undefined,
  requestedEffort: ReasoningEffort | undefined,
): CommentModelFormResolution {
  const visible = models.filter((model) => !model.hidden && model.id.trim());
  const selected = modelId
    ? visible.find((model) => model.id === modelId)
    : visible.find((model) => model.isDefault) ?? visible[0];
  if (!selected) return { ok: false, message: '所选模型当前不可用，未保存。请重新选择。' };

  const supported = selected.supportedEfforts ?? [];
  const effort = supported.length === 0
    ? undefined
    : requestedEffort && supported.includes(requestedEffort)
      ? requestedEffort
      : supported.includes(selected.defaultEffort)
        ? selected.defaultEffort
        : supported[0];
  return {
    ok: true,
    model: selected,
    effort,
    adjusted: Boolean(requestedEffort && effort !== requestedEffort),
  };
}

/**
 * 云文档评论的全局设置卡。Agent 按钮只切换待编辑对象并重渲模型列表，不立即落盘；
 * Agent + 模型 + 推理强度在表单提交时一次保存。表单内的下拉本身无 callback，浏览不会
 * 产生半套配置；提交后 CardKit 会锁原卡，handler 负责发送一张新的可交互结果卡。
 * 回复规则在 {@link buildCommentPromptCard} 中单独编辑。`models` 是待编辑 Agent 的实时列表。
 */
export function buildCommentSettingsCard(
  cfg: AppConfig,
  backendOptions: { id: string; label: string }[],
  models: ModelInfo[],
  notice?: string,
  selectedBackendId?: string,
): CardObject {
  const comments = cfg.preferences?.comments ?? {};
  const visible = models.filter((m) => !m.hidden);
  const configuredBackend =
    comments.backend && backendOptions.some((b) => b.id === comments.backend)
      ? comments.backend
      : (backendOptions.find((b) => b.id === DEFAULT_BACKEND_ID)?.id ?? backendOptions[0]?.id ?? DEFAULT_BACKEND_ID);
  const curBackend =
    selectedBackendId && backendOptions.some((backend) => backend.id === selectedBackendId)
      ? selectedBackendId
      : configuredBackend;
  const editingConfiguredBackend = curBackend === configuredBackend;
  // Resolved current values — no explicit "unset" option; just preselect the
  // effective default (backend's own default when nothing is configured).
  const explicit = editingConfiguredBackend && comments.model
    ? visible.find((m) => m.id === comments.model)
    : undefined;
  const curModel = explicit ?? visible.find((m) => m.isDefault) ?? visible[0];
  const unionEfforts = catalogEfforts(visible);
  const curEffort =
    editingConfiguredBackend && comments.effort && (curModel?.supportedEfforts ?? []).includes(comments.effort)
      ? comments.effort
      : curModel?.defaultEffort;
  const canPickModel = visible.length > 1;
  const canPickEffort = unionEfforts.length > 0;

  const els: CardElement[] = [
    ...(notice ? [md(notice)] : []),
    note('在云文档评论里 @我后，使用这里的配置运行 Agent 并回复。回复规则可控制怎么回答、是否直接修改文档；下一条新评论起生效，不影响普通聊天。'),
    hr(),
  ];

  // 后端：级联源。多后端给按钮（点了重渲下面的模型/强度表单），单后端只读。
  if (backendOptions.length > 1) {
    els.push(
      md('🧠 **评论使用的 Agent**'),
      note('这里只预览可选配置；点击“保存评论配置”后才会生效。'),
      actions(
        backendOptions.map((b) =>
          button(b.label, { a: DM.commentSetBackend, v: b.id }, b.id === curBackend ? 'primary' : 'default'),
        ),
      ),
    );
  } else {
    els.push(md(`🧠 **评论使用的 Agent**：${backendOptions[0]?.label ?? curBackend}`));
  }

  els.push(
    md(
      `**${editingConfiguredBackend ? '当前配置' : '待保存配置'}**：${curModel?.displayName ?? '默认模型'}${
        curEffort ? ` · ${reasoningEffortLabel(curEffort)}` : ''
      }`,
    ),
  );

  if (visible.length === 0) {
    els.push(note('暂时没有取到这个 Agent 的模型列表，未提供保存入口；请稍后重试或检查 Agent 登录状态。'));
  } else {
    // Agent + model + effort are committed by this one submit. The select
    // values themselves have no callbacks, so browsing cannot partially save.
    const formEls: CardElement[] = [];
    if (canPickModel) {
      formEls.push(
        md('🤖 **回复模型**'),
        selectMenu({
          name: 'model',
          placeholder: '选择模型',
          options: visible.map((m) => ({ label: m.displayName, value: m.id })),
          initial: curModel?.id,
        }),
      );
    } else {
      formEls.push(md(`🤖 **回复模型**：${curModel?.displayName ?? visible[0]!.id}（该 Agent 仅一个模型）`));
    }
    if (canPickEffort) {
      formEls.push(
        md('🎚 **推理强度**'),
        selectMenu({
          name: 'effort',
          placeholder: '选择推理强度',
          options: unionEfforts.map((e) => ({ label: reasoningEffortLabel(e), value: e })),
          initial: curEffort,
        }),
      );
    } else {
      formEls.push(note('该模型没有可调推理档位。'));
    }
    formEls.push(actions([
      submitButton('✅ 保存评论配置', { a: DM.commentSubmit, b: curBackend }, 'primary', 'submit_comment'),
    ]));
    els.push(form('comment_model_effort', formEls));
  }

  els.push(
    hr(),
    md('✍️ **回复规则**'),
    note('控制 Agent 如何理解评论、组织回复，以及是否读取或直接修改文档。'),
    actions([button('编辑回复规则', { a: DM.commentEditPrompt }, 'primary')]),
    hr(),
    md('📎 **文档读写能力**'),
    note('Bot 用自己的身份读和改文档：在文档右上角的分享里搜 Bot 名，要读给阅读权限，要改给编辑权限。表格和多维表格现在不能改。'),
    hr(),
    actions([button('⬅️ 返回设置', { a: DM.settings })]),
  );

  return card(els, { header: { title: '📝 云文档评论', template: 'blue' } });
}

/**
 * 评论回复规则编辑子卡（📝 云文档评论 →「编辑回复规则」）。底层仍是可直接维护的
 * comment-instructions.md 提示词；卡片用用户任务语言呈现。一个表单：撑满卡宽的多行输入框，
 * 预填当前 master 模板内容（含 {变量}）+ 保存按钮。保存后由 handler 写 master 并同步进
 * 所有文档（含历史）。卡里同时展示每轮自动追加给 agent 的实时消息长什么样，让用户清楚
 * 「固定人设（这段）+ 每轮实时facts」的分工。飞书 input 硬上限 1000 字（range 1–1000），
 * 更长的提示词需直接编辑 master 文件（无限制）；传入 `masterFile` 时把路径显示出来。
 */
export function buildCommentPromptCard(
  currentPrompt: string,
  notice?: string,
  masterFile?: string,
): CardObject {
  return card(
    [
      ...(notice ? [md(notice)] : []),
      md('**✍️ 回复规则**'),
      note('这段自定义评论提示词控制 Agent 如何回复、是否读取或修改文档。保存后会同步到所有文档（含历史），下一条评论生效。'),
      md(
        [
          '**可用变量**（同步到每篇文档时自动替换成该文档自己的值）：',
          '- `{docUrl}` 文档链接',
          '- `{fileToken}` 文档 token（链接里类型后那段）',
          '- `{fileType}` 文档类型，取值：',
          '    - `doc`/`docx`（飞书云文档）',
          '    - `sheet`（飞书表格）',
          '    - `bitable`（多维表格）',
        ].join('\n'),
      ),
      note('评论的选中原文和用户问题每轮都会自动提供，无需重复写进规则。'),
      form('comment_prompt', [
        input({
          name: 'prompt',
          label: '回复规则（提示词）',
          value: currentPrompt,
          required: true,
          inputType: 'multiline_text',
          rows: 12,
          width: 'fill',
          maxLength: 1000, // Feishu input hard cap (range 1–1000); longer prompts → edit master file
        }),
        // 两个都是 form 提交按钮（普通 button 在 form 内不保证触发）：保存读输入框内容落盘；
        // 重置忽略输入框、直接把内置默认写回 master 并同步（handler 端处理）。
        actions([
          submitButton('✅ 保存回复规则', { a: DM.commentPromptSubmit }, 'primary', 'submit_prompt'),
          submitButton('↩️ 重置为默认', { a: DM.commentResetPrompt }, 'default', 'reset_prompt'),
        ]),
      ]),
      hr(),
      md('**📨 每轮评论 @我，我会收到下面消息：**'),
      md(
        [
          '我在飞书云文档的评论里 @了你。文档信息：',
          '- 链接：{docUrl}',
          '- file_token：{fileToken}',
          '- 类型：{fileType}',
          '- 评论范围：行内评论（针对选中文字） / 全文评论（针对整篇）',
          '', // 空行结束列表，否则下一行被并进「评论范围」那个 bullet
          '用户选中的原文：（仅行内评论时附上）',
          '> ……被评论的那段文字……',
          '', // 空行结束引用，否则「用户的问题」被并进引用块
          '用户的问题：……评论正文……',
        ].join('\n'),
      ),
      note(
        masterFile
          ? `也可直接编辑 ${masterFile}（改文件后，新规则在每篇文档的下一条评论时生效）。`
          : '也可直接编辑 bot 目录下的 comment-instructions.md。',
      ),
      actions([button('⬅️ 返回', { a: DM.commentSettings })]),
    ],
    { header: { title: '✍️ 编辑回复规则', template: 'blue' }, widthMode: 'fill' },
  );
}

/**
 * Custom idle-timeout input card. A dedicated form card (like 新建项目 / 添加管理员)
 * so the settings card itself stays button-only and never locks. Submit lands on
 * {@link DM.watchdogCustomSubmit}; 返回 goes back to the settings card in place.
 */
export function buildWatchdogCustomCard(cfg: AppConfig): CardObject {
  const cur = normalizeRunIdleTimeoutSeconds(cfg.preferences?.runIdleTimeoutSeconds);
  return card(
    [
      md('**自定义假死超时**'),
      note(
        `多少秒没有任何输出就自动终止本轮。范围 ${RUN_IDLE_TIMEOUT_MIN_SEC}–${RUN_IDLE_TIMEOUT_MAX_SEC} 秒；填 0 关闭。`,
      ),
      form('watchdog_custom', [
        input({ name: 'sec', label: '超时秒数', placeholder: '例如 600', value: String(cur), required: true }),
        actions([submitButton('✅ 保存', { a: DM.watchdogCustomSubmit }, 'primary', 'submit_watchdog')]),
      ]),
      actions([button('⬅️ 返回设置', { a: DM.settings })]),
    ],
    { header: { title: '⏱ 自定义超时', template: 'blue' } },
  );
}

/**
 * Custom duration threshold for the ordinary task-completion `long` policy.
 * Kept on a dedicated form card so the main settings card remains button-only.
 */
export function buildCompletionReminderCustomCard(cfg: AppConfig): CardObject {
  const cur = getCompletionReminderConfig(cfg).longTaskMinutes;
  return card(
    [
      md('**自定义长任务阈值**'),
      note(
        `任务耗时达到这个时长，结束时额外回复消息并 @ 发起人。范围 ${COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES}–${COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES} 分钟。`,
      ),
      form('completion_reminder_custom', [
        input({ name: 'minutes', label: '时长（分钟）', placeholder: '例如 10', value: String(cur), required: true }),
        actions([
          submitButton('✅ 保存', { a: DM.completionReminderCustomSubmit }, 'primary', 'submit_completion_reminder'),
        ]),
      ]),
      actions([button('⬅️ 返回设置', { a: DM.settings })]),
    ],
    { header: { title: '🔔 长任务阈值', template: 'blue' } },
  );
}

/** Top line of a settings card re-rendered after a tap on an old 自动压缩 toggle. */
export const AUTO_COMPACT_RETIRED = '🗜️ 自动压缩现在一直开着，这个开关已经去掉了。';

/**
 * In-group settings card (@bot /settings until s1b, which sends none any more). 会话方式 is a read-only label here (the web
 * changes it); 免@ is a live toggle. Uses option buttons (never lock) like
 * {@link buildSettingsCard}. Admin-gated by the handler. `notice` = 卡顶提示行。
 */
export function buildGroupSettingsCard(
  project: Pick<Project, 'name' | 'kind' | 'smart' | 'noMention' | 'origin' | 'defaultModel' | 'defaultEffort'>,
  notice?: string,
): CardObject {
  const kind = ruleKind(project);
  const noMention = noMentionOf(project);
  const scopeNote =
    kind === 'single'
      ? '开启后：本群所有消息(不用 @)都交给我处理。'
      : '开启后：话题内的消息(不用 @)都交给我处理；**开新话题仍需 @我**。';
  return card(
    [
      ...(notice ? [md(notice)] : []),
      md(`**群设置** · ${project.name}`),
      note(`会话方式：${kindLabel(project)}`),
      ...(sessionModeOf(project) === 'smart' ? [note(SMART_NO_MENTION_NOTE)] : [
        ...optionRow('✋ 免@（不用 @ 也回复）', GS.setNoMention, noMention ? 'on' : 'off', [
          { label: '开', value: 'on' },
          { label: '关', value: 'off' },
        ]),
        note(scopeNote),
        note('⚠️ 免@ 需应用已开通「接收群内所有消息」(im:message.group_msg)权限，否则收不到非 @ 消息。'),
      ]),
      hr(),
      md('🤖 默认模型 / 推理强度'),
      actions([button('设置默认模型', { a: GS.modelDefault }, 'primary')]),
      note(`当前 ${modelDefaultSummary(project)}　·　新话题的起始模型 / 推理强度（话题内 \`/model\` 可临时改）。`),
    ],
    { header: { title: '⚙️ 群设置', template: 'blue' } },
  );
}

// ── 权限管理卡（admins / 项目响应白名单）──────────────────────────────────────

/** 行内显示一个成员：姓名优先，拿不到名（无 contact scope / 查询失败）则显示 open_id 尾段。 */
function memberName(names: Map<string, string>, id: string): string {
  return names.get(id) ?? `…${id.slice(-6)}`;
}

/**
 * 管理员名单卡（DM「⚙️ 设置 → 👮 管理员」）。只读：名单只在桌面端、网页和终端里改（product.md 第 6 节），
 * 旧卡片上的增删按钮点了也只是重画成这张卡。`names` 由调用方用 contact.batch 预解析 open_id→姓名。
 */
export function buildAdminsCard(cfg: AppConfig, names: Map<string, string>): CardObject {
  const { ownerOpenId, admins = [] } = cfg.preferences?.access ?? {};
  return card([
    md('**管理员名单** · 管理员能通过私聊操作这台电脑和这台电脑上的所有 Bot'),
    hr(),
    ...admins.map(id => actions([md(id === ownerOpenId ? `${memberName(names, id)} · 创建者` : memberName(names, id))])),
    hr(),
    actions([button('⬅️ 设置', { a: DM.settings })]),
    note('名单在 Vonvon Bot 的「私聊 → 沟通方式 → 回应谁」或终端里改。'),
  ], { header: { title: '👮 管理员', template: 'blue' } });
}

/** Short label for a tier (falls back to the raw value). Exported for the
 * backend-switch validation's rejection message (handle-message). */
export function tierLabel(m: PermissionMode): string {
  return tierInfo(permissionTable(DEFAULT_BACKEND_ID), { platform: process.platform }, m)?.name ?? m;
}

type PermissionProject = Pick<Project, 'mode' | 'network' | 'custom' | 'backend' | 'modelAccess'>;
/** The effective permission, including native settings, for the 项目设置 card. */
export function permissionSummary(p: PermissionProject): string {
  const permission = groupPermission(p);
  if (permission.invalid) return '高级设置读不出来，现在按只读跑';
  return permission.custom
    ? `自定义（${permissionTable(groupBackendId(p)).describe(permission.custom)}）${permission.legacy ? '（从旧版的联网开关转来）' : ''}`
    : tierLabel(permission.tier);
}

/** Old cards included a separate network field; they must be refreshed before saving. */
export const PERMISSION_CARD_VERSION = 3;

/** One available-tier dropdown; custom/unavailable settings are never preselected. */
export function buildPermissionCard(p: Pick<Project, 'name'> & PermissionProject, table: PermissionTable, env: TableEnv): CardObject {
  const permission = groupPermission(p);
  const tiers = table.tiers(env);
  const options = tiers.filter(info => !info.unavailable).map(info => ({ label: `${info.name} — ${info.summary}`, value: info.tier }));
  const current = tierInfo(table, env, permission.tier);
  const unselected = permission.custom || permission.invalid || current.unavailable;
  const tierSelect = selectMenu({ name: 'mode', placeholder: unselected ? `现在是${permission.custom ? '自定义' : current.name}，不选就不改` : '选择权限',
    options, ...(unselected ? {} : { initial: permission.tier }) });
  return card(
    [
      md(`**🔐 权限** · ${p.name}`),
      note('群里所有人都用这一档。'),
      ...(permission.invalid ? [note('高级设置读不出来，现在按只读跑。选一档重新设置。')]
        : permission.custom ? [note(`现在是自定义：${table.describe(permission.custom)}。选一档就回到那一档；不选就不改。`)] : []),
      ...(current.unavailable ? [note(`现在是${current.name}。${current.unavailable}`)] : []),
      form('perm', [
        md('🔒 **权限**'),
        tierSelect,
        actions([submitButton('✅ 保存权限', { a: DM.permissionSubmit, n: p.name, v: PERMISSION_CARD_VERSION }, 'primary', 'submit_perm')]),
      ]),
      // devices 第 15 节：给群选完全访问的地方都带这句。
      ...(options.some(option => option.value === 'full') ? [note(`完全访问：${FULL_ACCESS_WARNING}`)] : []),
      note('保存会断开本项目正在进行的会话，让新档位立即生效。'),
      note('高级设置在网页端的群详情里改，或者直接跟我说，例如“把这个群的 Claude 改成先出方案”。'),
      actions([button('⬅️ 返回设置', { a: DM.projectSettings, n: p.name })]),
    ],
    { header: { title: '🔐 权限', template: 'blue' } },
  );
}

/** Known IDs retain their usual order; provider-defined IDs keep discovery order. */
function catalogEfforts(models: ModelInfo[]): ReasoningEffort[] {
  const offered = [...new Set(models.flatMap(model => model.supportedEfforts))];
  return [
    ...REASONING_EFFORTS.filter(effort => offered.includes(effort)),
    ...offered.filter(effort => !(REASONING_EFFORTS as readonly string[]).includes(effort)),
  ];
}

/** One-line summary of a project's default model/effort, for the settings cards.
 * Sync (no model list) — shows the raw stored id (e.g. `gpt-5.5`) or「后端默认」. */
export function modelDefaultSummary(p: Pick<Project, 'defaultModel' | 'defaultEffort'>): string {
  if (!p.defaultModel) return '后端默认（未设）';
  const eff = p.defaultEffort ? ` · 强度 ${reasoningEffortLabel(p.defaultEffort)}` : '';
  return `${p.defaultModel}${eff}`;
}

/**
 * 🤖 默认模型 / 推理强度 子表单卡（项目级，仅管理员）。设的是本项目**新话题**的起始
 * 模型 + 推理强度——per-session `/model` 临时覆盖之上、后端默认之下的那层。和权限卡一样
 * 用 selectMenu 表单（选完提交、不用即时按钮，规避 select 锁卡）。两个入口共用本卡，用
 * `ctx` 决定提交 / 返回的 action（dm = DM 项目设置卡；group = 群 /settings 卡）。
 *
 * 模型下拉总在：列表里的模型，加一项「自定义模型 ID…」配一个输入框（3.11，第三方网关的
 * 模型常不在列表里）。effort 下拉只在该后端**至少一个模型**支持 effort 时出现（claude
 * 这类不调强度的后端不显示假档）。effort 选项取所有可见模型 supportedEfforts 的并集——
 * 提交时再按所选模型校验收窄（见 {@link parseModelDefaultFormValue}）。`models` 由
 * 调用方按项目 backend 实时拉取后传入。
 */
export function buildModelDefaultCard(
  p: Pick<Project, 'name' | 'defaultModel' | 'defaultEffort' | 'defaultModelCustom'>,
  models: ModelInfo[],
  ctx: 'dm' | 'group',
  notice?: string,
): CardObject {
  const visible = models.filter((m) => !m.hidden);
  const custom = p.defaultModelCustom && p.defaultModel ? p.defaultModel : undefined;
  // current effective default: hand-typed id, else explicit project default (if
  // still valid), else backend isDefault
  const explicit = !custom && p.defaultModel ? visible.find((m) => m.id === p.defaultModel) : undefined;
  const curModel = custom ? undefined : (explicit ?? visible.find((m) => m.isDefault) ?? visible[0]);
  const curEfforts = curModel?.supportedEfforts ?? [];
  // a hand-typed id keeps its stored effort; a listed model only one it still supports
  const keepStoredEffort = Boolean(custom || (explicit && p.defaultEffort && curEfforts.includes(p.defaultEffort)));
  const curEffort = keepStoredEffort ? p.defaultEffort : curModel?.defaultEffort;
  const unionEfforts = catalogEfforts(visible);
  const canPickEffort = unionEfforts.length > 0;

  const submit = ctx === 'dm' ? { a: DM.modelDefaultSubmit, n: p.name } : { a: GS.modelDefaultSubmit };
  const back = ctx === 'dm' ? { a: DM.projectSettings, n: p.name } : { a: GS.settings };

  const head: CardElement[] = [
    ...(notice ? [md(notice)] : []),
    md(`**🤖 默认模型 / 推理强度** · ${p.name}`),
    note(
      '本项目**新话题**的起始模型与推理强度。进行中 / 已恢复的会话不受影响；话题内随时可用 ' +
        '`/model` 临时改。未设时用后端自带默认。',
    ),
  ];

  const formEls: CardElement[] = [
    md('🤖 **默认模型**'),
    selectMenu({
      name: 'model',
      placeholder: '选择默认模型',
      options: [
        ...visible.map((m) => ({ label: m.displayName, value: m.id })),
        { label: '自定义模型 ID…', value: CUSTOM_MODEL_OPTION },
      ],
      initial: custom ? CUSTOM_MODEL_OPTION : curModel?.id,
    }),
    input({
      name: 'customModel',
      label: '自定义模型 ID（选“自定义”时填）',
      placeholder: '列表里没有的模型，例如 deepseek-chat',
      value: custom,
      maxLength: MODEL_ID_MAX_LENGTH,
      width: 'fill',
    }),
  ];
  if (canPickEffort) {
    formEls.push(
      md('🧠 **默认推理强度**'),
      selectMenu({
        name: 'effort',
        placeholder: '选择默认推理强度',
        options: unionEfforts.map((e) => ({ label: `强度：${reasoningEffortLabel(e)}`, value: e })),
        initial: curEffort,
      }),
    );
  }
  formEls.push(actions([submitButton('✅ 保存默认', submit, 'primary', 'submit_model_default')]));

  return card(
    [
      ...head,
      hr(),
      form('model_default', formEls),
      ...(!canPickEffort ? [note('该后端不调节推理强度（思考由模型自动调度，无 effort 档）。')] : []),
      note('保存只影响之后新建的话题，不会打断正在进行的会话。手填的模型 ID 不核对，填错了新话题第一轮会报错。'),
      actions([button('⬅️ 返回', back)]),
    ],
    { header: { title: '🤖 默认模型', template: 'blue' } },
  );
}

export type ModelDefaultFormParseResult =
  | { ok: true; model: string; effort?: ReasoningEffort; custom: boolean; label: string }
  | { ok: false; message: string };

/**
 * Parse the default-model form of {@link buildModelDefaultCard}. A listed model is
 * checked against the live list and its effort narrowed to what it supports; the
 * 「自定义」 option takes the typed id through {@link parseModelId} and keeps an
 * effort only if the backend's protocol accepts it.
 */
export function parseModelDefaultFormValue(
  formValue: Record<string, unknown> | undefined,
  models: ModelInfo[],
  backendId: string,
): ModelDefaultFormParseResult {
  const selected = sessionTitleFormScalar(formValue, 'model');
  const rawEffort = sessionTitleFormScalar(formValue, 'effort');
  const requestedEffort = rawEffort && rawEffort.length <= 1000 ? rawEffort : undefined;
  if (selected === CUSTOM_MODEL_OPTION) {
    const parsed = parseModelId(sessionTitleFormScalar(formValue, 'customModel'));
    if (!parsed.ok) return parsed;
    const effort = requestedEffort && (backendId !== 'claude-agent' || getSessionTitleEfforts(backendId).includes(requestedEffort))
      ? requestedEffort : undefined;
    return { ok: true, model: parsed.id, effort, custom: true, label: parsed.id };
  }
  const m = selected ? models.find((x) => x.id === selected && !x.hidden) : undefined;
  if (!m) return { ok: false, message: '所选模型无效或已下架，未保存。' };
  const supported = m.supportedEfforts ?? [];
  let effort: ReasoningEffort | undefined;
  if (requestedEffort && supported.includes(requestedEffort)) {
    effort = requestedEffort;
  } else if (supported.length) {
    effort = m.defaultEffort;
  }
  return { ok: true, model: m.id, effort, custom: false, label: m.displayName };
}

/** 单个后端的检测结果（🧠 后端检测结果卡的一行）。`probe` undefined = 探测没
 * 跑成/超时，按不可用渲染——绝不放行。`supportedModes` 同
 * {@link AgentBackend.supportedModes}（undefined ⇒ 全档支持）。 */
export interface BackendProbeRow {
  id: string;
  name: string;
  probe?: BackendProbe;
  supportedModes?: readonly PermissionMode[];
}

// 〔已移除〕buildBackendDetectingCard / buildBackendPickerCard —— 项目后端「运行时切换」
// 卡。产品改为「创建时选定、运行时固定、不支持切换」（阶段4/5）后，这两张卡及其
// DM.backend/backendSubmit 入口已废弃删除；后端只读展示见 buildProjectSettingsCard，
// 创建时选后端见 buildNewProjectFormCard。BackendProbeRow 类型保留（probeBackends 仍用）。

/**
 * 项目设置卡（DM「📁 项目列表 / 建项目完成卡 → ⚙️ 设置」）。可扩展容器：当前放
 * 🔐 权限 + 🧠 后端 + 免@ 开关 + 响应白名单入口，以后的项目级设置项往这里加。
 * 纯按钮（不锁卡）。各按钮携带项目名 n（DM 里点，不能靠 evt.chatId 取项目）。
 * `backendName` = 当前后端的展示名（调用方从注册表解析）；缺省回退到原始 id。
 * `notice` = 卡顶提示行（如后端切换成功的「✅ 已切到 xxx · 新话题生效」）。
 */
export function buildProjectSettingsCard(
  project: Pick<
    Project,
    | 'name'
    | 'kind'
    | 'smart'
    | 'noMention'
    | 'origin'
    | 'cwd'
    | 'mode'
    | 'network'
    | 'custom'
    | 'modelAccess'
    | 'backend'
    | 'defaultModel'
    | 'defaultEffort'
  >,
  backendName?: string,
  notice?: string,
): CardObject {
  const kind = ruleKind(project);
  const noMention = noMentionOf(project);
  return card(
    [
      ...(notice ? [md(notice)] : []),
      md(`**项目设置** · ${project.name}`),
      note(`${kindLabel(project)}${project.cwd ? `   ·   📂 \`${project.cwd}\`` : ''}`),
      hr(),
      actions([button('🔐 权限', { a: DM.permission, n: project.name }, 'primary')]),
      note(`当前 ${permissionSummary(project)}　·　群里所有人都用这一档。`),
      hr(),
      md('🧠 后端'),
      note(
        `当前 ${backendName ?? project.backend ?? DEFAULT_BACKEND_ID} 🔒　·　后端在**新建项目时选定**，运行时固定、不支持切换。如需更改，请删除该项目后用新后端重新创建。`,
      ),
      hr(),
      ...(sessionModeOf(project) === 'smart' ? [note(SMART_NO_MENTION_NOTE)] : [
        md('✋ 免@（不用 @ 也回复）'),
        actions([
          button('开', { a: DM.setNoMentionDm, v: 'on', n: project.name }, noMention ? 'primary' : 'default'),
          button('关', { a: DM.setNoMentionDm, v: 'off', n: project.name }, noMention ? 'default' : 'primary'),
        ]),
        note(
          kind === 'single'
            ? '开启后：本群所有消息(不用 @)都交给我处理。'
            : '开启后：话题内消息(不用 @)都处理；**开新话题仍需 @我**。',
        ),
      ]),
      hr(),
      md('🤖 默认模型 / 推理强度'),
      actions([button('设置默认模型', { a: DM.modelDefault, n: project.name }, 'primary')]),
      note(`当前 ${modelDefaultSummary(project)}　·　新话题的起始模型 / 推理强度（话题内 \`/model\` 可临时改）。`),
      hr(),
      actions([button('🛡 响应白名单', { a: DM.allowlist, n: project.name }, 'primary')]),
      note('设置谁能让我在本群响应 / 跑 codex（空 = 所有人）。'),
      hr(),
      actions([button('⬅️ 项目列表', { a: DM.projects })]),
    ],
    { header: { title: '⚙️ 项目设置', template: 'blue' } },
  );
}

/**
 * 项目响应白名单卡（DM「⚙️ 项目设置 → 🛡 响应白名单」）。结构同 {@link buildAdminsCard}：
 * 纯按钮 + 加人走表单卡 {@link buildAddAllowedCard}。空名单 = 所有人可用；admin/owner
 * 恒豁免，不受此名单限制。
 */
export function buildAllowlistCard(
  project: Pick<Project, 'name' | 'allowedUsers'>,
  names: Map<string, string>,
): CardObject {
  const list = project.allowedUsers ?? [];
  const elements: CardElement[] = [md(`**响应白名单** · ${project.name}`), note('谁能让我在本群响应 / 跑 codex'), hr()];
  if (list.length === 0) {
    elements.push(note('当前**所有人**可用（管理员始终可用）。'));
  } else {
    for (const id of list) {
      elements.push(
        actions([md(memberName(names, id)), button('🗑 移除', { a: DM.rmAllowed, u: id, n: project.name }, 'danger')]),
      );
    }
  }
  elements.push(
    hr(),
    actions([
      button('➕ 添加', { a: DM.addAllowedForm, n: project.name }, 'primary'),
      button('⬅️ 设置', { a: DM.projectSettings, n: project.name }),
    ]),
    note('管理员始终可用，不受此名单限制；名单为空 = 所有人可用。'),
  );
  return card(elements, { header: { title: '🛡 响应白名单', template: 'blue' } });
}

/**
 * 添加响应成员：候选合并真人与 bot 名册；仅显示有界首页，保留手填入口。
 */
export function buildAddAllowedCard(
  projectName: string,
  roster: ResponseRoster | undefined,
): CardObject {
  const MAX = 50;
  const members = roster?.entries ?? [];
  const shown = members.slice(0, MAX);
  const formEls: CardElement[] = [];
  if (shown.length > 0) {
    formEls.push(
      selectMenu({
        name: 'pick',
        placeholder: '从群成员选择',
        options: shown.map((m) => ({ label: responseMemberLabel(m), value: m.openId })),
      }),
    );
  }
  formEls.push(
    input({
      name: 'open_id',
      label: shown.length ? '或直接输入 open_id' : '输入 open_id（未读取到群成员）',
      placeholder: 'ou_xxx',
    }),
    actions([submitButton('✅ 确认添加', { a: DM.addAllowedSubmit, n: projectName }, 'primary', 'submit_allowed')]),
  );
  const tail: CardElement[] = [];
  if (roster?.state !== 'complete') tail.push(note('群成员名册未完整读取，已有响应名单不受影响；可重新打开此页重试，或输入 open_id。'));
  if (members.length > MAX) tail.push(note(`群成员较多，仅列前 ${MAX} 个；其余请直接输入 open_id。`));
  return card(
    [
      md(`**添加可使用「${projectName}」的人**`),
      form('add_allowed', formEls),
      ...tail,
      actions([button('⬅️ 取消', { a: DM.allowlist, n: projectName })]),
    ],
    { header: { title: '➕ 添加白名单成员', template: 'blue' } },
  );
}
