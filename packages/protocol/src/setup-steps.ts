import type {AdminSetupStatus} from './admin.js';
import {BWRAP_TRIAL, type Agent, type ApplicationService, type ClaudeSandbox, type DesktopSnapshot, type ServiceActionReason, type ServiceActionReport, type ToolState} from './domain.js';

export type StepTone = 'success' | 'warning' | 'danger' | 'neutral';
/** What the step's button does; the checklist component wires each kind. */
export type StepAction =
  | {kind: 'reauthorize'; label: string}
  | {kind: 'open'; label: string; url: string; target: 'app-console' | 'event-settings'}
  | {kind: 'enable'; label: string}
  | {kind: 'confirmCallback'; label: string; confirmed: boolean}
  | {kind: 'environment'; label: string}
  | {kind: 'codexLogin'; label: string}
  | {kind: 'claudeLogin'; label: string}
  | {kind: 'serviceInstall'; label: string; primary?: boolean}
  | {kind: 'serviceSkip'; label: string}
  | {kind: 'serviceRecheck'; label: string};
export type SetupStep = {
  id: 'credentials' | 'scopes' | 'connection' | 'event' | 'callback' | 'publish' | 'codex' | 'claude' | 'service' | 'codex-linux' | 'claude-sandbox';
  title: string; status: string; tone: StepTone; done: boolean;
  detail?: string | undefined; items?: readonly string[] | undefined; actions: readonly StepAction[];
  /** Shown under the step without changing its tone or `done`: optional settings whose absence breaks a later flow. */
  warnings?: readonly string[] | undefined;
  /** Shell lines for the user to run; shown verbatim, never run by vonvon (s20a). */
  commands?: readonly string[] | undefined;
};

/** Join-group scope and bot-added event: optional for receiving messages, needed to bind groups (s02a). */
export const JOIN_SCOPE_WARNING = '还没开读群信息的权限（im:chat:readonly）：把 Bot 拉进群后不会提醒你绑定，「查找已经加入的群」也会失败。';
export const BOT_ADDED_WARNING = '没订阅「机器人进群」（im.chat.member.bot.added_v1）：把 Bot 拉进群后不会提醒你绑定。';
/** Recall event: optional, without it a recalled message the bot read is still used (s15). */
export const RECALL_WARNING = '没订阅「撤回消息」（im.message.recalled_v1）：撤回 Bot 读过的消息后，Bot 不会知道，还会接着用它。';
/** Optional events whose absence gets a warning under the 事件订阅 step. */
const OPTIONAL_EVENT_WARNINGS = [
  ['im.chat.member.bot.added_v1', BOT_ADDED_WARNING],
  ['im.message.recalled_v1', RECALL_WARNING],
] as const;

/** The order follows the Feishu console: the long connection must be up before the
 * event page can save "长连接" mode, and events only count once a version is published. */
export function botSteps(agent: Agent, status: AdminSetupStatus | undefined, problem?: string): SetupStep[] {
  if (!status) {
    const reading = {status: problem ? '检测失败' : '正在检测…', tone: problem ? 'warning' : 'neutral', done: false, detail: problem, actions: []} as const;
    return [{id: 'credentials', title: '飞书应用', ...reading}, connectionStep(agent)];
  }
  const event = status.event;
  const eventSettings: StepAction = {kind: 'open', label: '打开事件设置', url: status.eventConfigUrl, target: 'event-settings'};
  const missed = OPTIONAL_EVENT_WARNINGS.filter(([e]) => event.missingOptional?.includes(e)).map(([, w]) => w);
  const eventWarnings = missed.length ? missed : undefined;
  const steps: SetupStep[] = [
    status.credentials.ok
      ? {id: 'credentials', title: '飞书应用', status: '凭据有效', tone: 'success', done: true, actions: []}
      : status.credentials.unreachable
        ? {id: 'credentials', title: '飞书应用', status: '无法确认', tone: 'neutral', done: false, detail: `连不上飞书，凭据还没检测：${status.credentials.reason ?? '未知原因'}。网络恢复后会自动重试。`, actions: []}
        : {id: 'credentials', title: '飞书应用', status: '凭据无效', tone: 'danger', done: false, detail: status.credentials.reason ?? '读不到这个 Bot 的凭据。', actions: [{kind: 'reauthorize', label: '重新扫码'}]},
    scopeStep(status),
    connectionStep(agent),
    event.state === 'ok'
      ? {id: 'event', title: '事件订阅', status: '已订阅接收消息', tone: 'success', done: true, detail: event.missingOptional?.length ? '有几项可选事件没订阅，不影响收消息。' : undefined, items: event.missingOptional, actions: event.missingOptional?.length ? [eventSettings] : [], warnings: eventWarnings}
      : event.state === 'missing'
        ? {id: 'event', title: '事件订阅', status: '缺少接收消息事件', tone: 'warning', done: false, detail: '在事件设置里选"使用长连接接收事件"，添加"接收消息"（im.message.receive_v1），再发布一个新版本。', actions: [eventSettings], warnings: eventWarnings}
        : event.state === 'unpublished'
          ? {id: 'event', title: '事件订阅', status: '上线后才能确认', tone: 'neutral', done: false, detail: '在事件设置里选"使用长连接接收事件"，添加"接收消息"（im.message.receive_v1）。版本上线后这里会自动确认。', actions: [eventSettings]}
          : {id: 'event', title: '事件订阅', status: '无法确认', tone: 'neutral', done: false, detail: event.reason, actions: [eventSettings]},
    cardCallbackStep(status),
    event.state === 'unpublished'
      ? {id: 'publish', title: '发布', status: '还没有上线的版本', tone: 'warning', done: false, detail: '在开发者后台的"版本管理与发布"里创建并发布一个版本；已经提交的，等管理员审核通过后这里会变绿。改过权限、事件或回调后，也要再发布一次。', actions: [{kind: 'open', label: '打开开发者后台', url: status.consoleUrl, target: 'app-console'}]}
      : event.state === 'unchecked'
        ? {id: 'publish', title: '发布', status: '无法确认', tone: 'neutral', done: false, detail: event.reason, actions: [{kind: 'open', label: '打开开发者后台', url: status.consoleUrl, target: 'app-console'}]}
        : {id: 'publish', title: '发布', status: event.version ? `已发布 ${event.version}` : '已发布', tone: 'success', done: true, actions: []},
  ];
  // Rejected credentials get no token, so the later reads would only repeat step 1's error.
  if (status.credentials.ok || status.credentials.unreachable) return steps;
  return steps.map(step => step.id === 'scopes' || step.id === 'event' || step.id === 'publish'
    ? {...step, status: '等第 1 步', tone: 'neutral', done: false, detail: '飞书应用的凭据有效后才能检测。', items: undefined, warnings: undefined}
    : step);
}

/** Configuration reads take precedence over manual confirmation and historical receipts. */
function cardCallbackStep(status: AdminSetupStatus): SetupStep {
  const {configuration, confirmed, verifiedAt} = status.cardCallback;
  const base = {id: 'callback', title: '卡片回调'} as const;
  const settings: StepAction = {kind: 'open', label: '打开回调设置', url: status.eventConfigUrl, target: 'event-settings'};
  if (configuration?.state === 'configured') return {...base, status: '已配置 · 长连接', tone: 'success', done: true,
    detail: verifiedAt ? '已收到过这个 Bot 的真实卡片回调（card.action.trigger）。' : undefined, actions: []};
  if (configuration?.state === 'missing') return {...base, status: '未订阅卡片回调', tone: 'warning', done: false,
    detail: '在回调配置里添加「卡片回传交互」（card.action.trigger），使用长连接接收回调。', actions: [settings]};
  if (configuration?.state === 'wrong-mode') return {...base, status: '需改为长连接', tone: 'warning', done: false,
    detail: '已订阅卡片回传交互，但当前使用请求地址接收。请在回调配置里改为长连接。', actions: [settings]};
  const unread = configuration?.state === 'unchecked' ? `本次未能读取回调配置${configuration.reason ? `：${configuration.reason}` : '。'}` : '';
  if (verifiedAt) return {...base, status: '已验证', tone: 'success', done: true,
    detail: `${unread}${unread ? ' ' : ''}已收到过这个 Bot 的真实卡片回调（card.action.trigger）。`, actions: unread ? [settings] : []};
  if (confirmed) return {...base, status: '已手动确认', tone: 'success', done: true,
    detail: `${unread}${unread ? ' ' : ''}你已确认完成配置，尚未收到真实卡片回调。`, actions: [...(unread ? [settings] : []), {kind: 'confirmCallback', label: '撤销确认', confirmed: false}]};
  return {...base, status: configuration ? '无法确认配置' : '待验证', tone: 'neutral', done: false,
    detail: `${unread || '尚未收到真实卡片回调，收到后会自动验证。'} 这不代表未配置；可打开回调设置核对，或在完成配置后手动确认。`,
    actions: [settings, {kind: 'confirmCallback', label: '我已配置', confirmed: true}]};
}

/** The 权限 step, shared by the checklist and the register dialog's grant step. Only the required
 * scopes decide it; a missing join-group scope is a warning (the grant link already includes it). */
export function scopeStep(status: AdminSetupStatus): SetupStep & {id: 'scopes'} {
  const missing = status.scopes.missingRequired;
  const grant: StepAction = {kind: 'open', label: '一键开权限', url: status.scopes.grantUrl, target: 'app-console'};
  const warnings = status.scopes.missingJoinScopes?.includes('im:chat:readonly') ? [JOIN_SCOPE_WARNING] : undefined;
  const base = {id: 'scopes', title: '权限', warnings} as const;
  if (missing === undefined) return {...base, status: '无法确认', tone: 'neutral', done: false, detail: '暂时读不到已开通的权限。可以直接一键开权限，开过的不会重复申请。', actions: [grant]};
  if (missing.length) return {...base, status: `还缺 ${missing.length} 项`, tone: 'warning', done: false, detail: '一键开权限会预选下面这些权限，在飞书开发者后台确认即可。', items: missing, actions: [grant]};
  return {...base, status: '已开通', tone: 'success', done: true, actions: warnings ? [grant] : []};
}

/** The 长连接 step, also the 连接 row of the 状态与诊断 page. */
export function connectionStep(agent: Agent): SetupStep {
  const base = {id: 'connection', title: '长连接'} as const;
  if (agent.readError) return {...base, status: '读取失败', tone: 'warning', done: false, detail: agent.readError, actions: []};
  if (!agent.enabled) return {...base, status: '没有启用', tone: 'warning', done: false, detail: '启用后 Bot 会连上飞书，事件设置页才能保存长连接方式。', actions: [{kind: 'enable', label: '启用 Bot'}]};
  if (agent.connection === 'connected') return {...base, status: '已连接', tone: 'success', done: true, actions: []};
  if (agent.connection === 'connecting' || agent.connection === 'reconnecting') return {...base, status: '连接中', tone: 'neutral', done: false, actions: []};
  return {...base, status: '未连接', tone: 'warning', done: false, detail: '凭据有效但连不上时，检查网络，或重新扫码。', actions: []};
}

/** Steps that only Feishu can answer; when they are all done the poller stops. */
export function remoteStepsDone(status: AdminSetupStatus | undefined): boolean {
  if (!status) return false;
  const configuration = status.cardCallback.configuration;
  const callbackDone = configuration && configuration.state !== 'unchecked'
    ? configuration.state === 'configured' : status.cardCallback.confirmed;
  return Boolean(status.credentials.ok && status.scopes.missingRequired?.length === 0 && status.event.state === 'ok' && callbackDone);
}

export type ToolSteps = {steps: SetupStep[]; ready: boolean};
/** Codex or Claude: either one installed, signed in and new enough is enough. `claudeChecking`: the page is asking
 * for the Claude login (or about to), so an unknown answer reads 检查中; `vonvon bot status` leaves it out. */
export function toolSteps(tools: readonly ToolState[], opts: {claudeChecking?: boolean} = {}): ToolSteps {
  const codex = tools.find(tool => tool.tool === 'codex');
  const claude = tools.find(tool => tool.tool === 'claude');
  const steps = [codexStep(codex), claudeStep(claude, opts.claudeChecking)];
  return {steps, ready: steps.some(step => step.done)};
}

function codexStep(tool: ToolState | undefined): SetupStep {
  const base = {id: 'codex', title: 'Codex'} as const;
  const version = tool?.version ? ` · ${tool.version}` : '';
  if (!tool || tool.installation === 'unknown') return {...base, status: '无法确认', tone: 'neutral', done: false, detail: tool?.message, actions: [{kind: 'environment', label: '去本机环境'}]};
  if (tool.installation === 'missing') return {...base, status: '未安装', tone: 'neutral', done: false, detail: '可以在本机环境里装托管副本（要用本机的 Node.js 和 npm）。没装 Node.js 的话，装 ChatGPT 或 Codex 桌面应用，或者用 Homebrew 装 Codex。', actions: [{kind: 'environment', label: '去本机环境'}]};
  const compatibility = tool.compatibility;
  if (compatibility?.status === 'tooOld') return {...base, status: `版本太旧${version}`, tone: 'warning', done: false, detail: `最低要 ${compatibility.minimum}，请在本机环境更新。`, actions: [{kind: 'environment', label: '去本机环境'}]};
  if (tool.authentication === 'signedOut') return {...base, status: `没配置好${version}`, tone: 'warning', done: false, detail: '在终端运行 codex 配置好（账号或自定义 API 都行），然后重新检测。', actions: [{kind: 'environment', label: '查看本机环境'}]};
  if (tool.authentication === 'unknown') return {...base, status: `无法确认配置${version}`, tone: 'neutral', done: false, detail: tool.message, actions: [{kind: 'environment', label: '去本机环境'}]};
  const newer = compatibility?.status === 'newer' ? `比验证过的 ${compatibility.verified} 新，一般能用。` : undefined;
  return {...base, status: `可用${version}`, tone: 'success', done: true, detail: newer, actions: []};
}

function claudeStep(tool: ToolState | undefined, checking = false): SetupStep {
  const base = {id: 'claude', title: 'Claude'} as const;
  const version = tool?.version ? ` · ${tool.version}` : '';
  if (!tool || tool.installation === 'unknown') return {...base, status: '无法确认', tone: 'neutral', done: false, detail: tool?.message, actions: [{kind: 'environment', label: '去本机环境'}]};
  if (tool.installation === 'missing') return {...base, status: '未安装', tone: 'neutral', done: false, detail: '要用 Claude，在本机环境里安装 Claude Agent SDK。', actions: [{kind: 'environment', label: '去本机环境'}]};
  if (tool.authentication === 'signedIn' || tool.authentication === 'notRequired') return {...base, status: `可用${version}`, tone: 'success', done: true, detail: tool.message, actions: [{kind: 'claudeLogin', label: '检查配置'}]};
  if (checking && tool.authentication === 'unknown') return {...base, status: `检查中${version}`, tone: 'neutral', done: false, detail: '正在检查 Claude 的配置。', actions: [{kind: 'claudeLogin', label: '检查配置'}]};
  const status = tool.authentication === 'signedOut' ? '没配置好' : '无法确认配置';
  return {...base, status: `${status}${version}`, tone: tool.authentication === 'signedOut' ? 'warning' : 'neutral', done: false, detail: tool.message ?? '在终端运行 claude 配置好（账号或自定义 API 都行），然后点"检查配置"。', actions: [{kind: 'claudeLogin', label: '检查配置'}]};
}

/** Linux only (s20a): what the qa and write modes need, under the tools. Neither step counts toward 还差几步 or 可以用了,
 * and neither changes a mode or a system setting: they explain and give the commands. A missing tool has no step. */
export function linuxSteps(tools: readonly ToolState[]): SetupStep[] {
  const claude = tools.find(tool => tool.tool === 'claude');
  const steps: SetupStep[] = [];
  if (claude && claude.installation !== 'missing') steps.push(claudeSandboxStep(claude.sandbox));
  return steps;
}

const FULL_INSTEAD = '不想改的话，这台主机上用 Claude 的群就用完全访问。';
const SANDBOX_MISSING = 'Claude 在只读、读写档下用 bubblewrap 沙箱把命令关在工作区里，缺了这两档的回合会失败（Sandbox required but unavailable），完全访问不受影响。别的发行版用自己的包管理器装 bubblewrap 和 socat；装好后一分钟内这里会更新。';
const SANDBOX_APPARMOR = `Ubuntu 23.10 起默认不让普通程序建用户命名空间（kernel.apparmor_restrict_unprivileged_userns = 1），bwrap 起不来，只读、读写档的回合会失败。给 bwrap 单独加一份 AppArmor 配置就行，不用全局关掉这个限制，命令见下；${FULL_INSTEAD}`;
const USERNS_SETTINGS: Record<string, string> = {'kernel.unprivileged_userns_clone': '1', 'user.max_user_namespaces': '15000'};

/** The same profile the owner added on JP-VPS (docs/v1-plan.md section 7), for the bwrap the probe found. */
const apparmorCommands = (bwrap: string): string[] => [
  "sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'", 'abi <abi/4.0>,', 'include <tunables/global>', `profile bwrap ${bwrap} flags=(unconfined) {`,
  '  userns,', '  include if exists <local/bwrap>', '}', 'EOF', 'sudo apparmor_parser -r /etc/apparmor.d/bwrap',
];

function claudeSandboxStep(sandbox: ClaudeSandbox | undefined): SetupStep {
  const step = (status: string, tone: StepTone, detail?: string, commands?: string[]): SetupStep =>
    ({id: 'claude-sandbox', title: 'Claude 的权限', status, tone, done: tone === 'success', detail, actions: [], commands});
  if (!sandbox) return step('无法确认', 'neutral');
  const missing = [...(sandbox.bwrap ? [] : ['bwrap']), ...(sandbox.socat ? [] : ['socat'])];
  if (!sandbox.bwrap || missing.length) return step(`缺 ${missing.join('、')}`, 'warning', SANDBOX_MISSING, [`sudo apt install ${missing.map(name => name === 'bwrap' ? 'bubblewrap' : name).join(' ')}`]);
  switch (sandbox.userns) {
    case 'ok': return step('可以用', 'success', 'bubblewrap 和 socat 都在，沙箱起得来。');
    case 'apparmor': return step('被 AppArmor 挡住', 'warning', SANDBOX_APPARMOR, apparmorCommands(sandbox.bwrap));
    case 'disabled': {
      const setting = sandbox.detail && USERNS_SETTINGS[sandbox.detail] ? sandbox.detail : 'user.max_user_namespaces';
      return step('用户命名空间被关掉了', 'warning', `这台主机关掉了用户命名空间（${setting} = 0），bwrap 起不来，只读、读写档的回合会失败。下面这条马上生效；要长期生效，把同样的设置写进 /etc/sysctl.d/ 下的一个文件。${FULL_INSTEAD}`,
        [`sudo sysctl -w ${setting}=${USERNS_SETTINGS[setting]}`]);
    }
    case 'failed': return step('沙箱起不来', 'warning', `bwrap 试跑失败：${sandbox.detail ?? '原因不明'}。在终端里跑一次下面这条，看完整的报错。`,
      [[sandbox.bwrap, ...BWRAP_TRIAL].join(' ')]);
    default: return step('无法确认', 'neutral');
  }
}

const SERVICE_RECHECK: StepAction = {kind: 'serviceRecheck', label: '重新检测'};
/** A failed service action stays on the step for 10 minutes; after that it is history. */
const SERVICE_FAILURE_SHOWN_FOR = 10 * 60_000;
const serviceUnreachable = (manager: string, detail: string | undefined): string => `暂时问不到 ${manager}${detail ? `：${detail}` : '。'}`;

/** 登录电脑时自动运行 bot (3.1 item 4, 3.10), for the checklist, the desktop and `vonvon bot status`. On macOS the web UI and
 * the desktop install it; on Linux the step only names the terminal command. First match wins. */
export function serviceStep(application: Pick<DesktopSnapshot['application'], 'platform' | 'service'>, now = Date.now()): SetupStep & {id: 'service'} {
  const service = application.service;
  if (application.platform === 'linux') return linuxServiceStep(service);
  if (application.platform !== 'macos') return {id: 'service', title: '后台服务', status: '不支持', tone: 'neutral', done: false, detail: '这台电脑不支持后台服务。', actions: []};
  const failure = recentServiceFailure(service, now);
  const step = (status: string, tone: StepTone, done: boolean, detail: string | undefined, actions: readonly StepAction[] = []) =>
    ({id: 'service', title: '登录电脑时自动运行 Bot（推荐）', status, tone, done, detail, actions, warnings: failure ? [failure] : undefined} as const);
  const action = service?.action;
  if (action?.phase === 'running') return step(action.action === 'install' ? '正在打开…' : '正在关闭…', 'neutral', false, '页面会断开几秒再连上。');
  if (service?.blocked === 'development') return step('开发版不能装', 'neutral', false, SERVICE_DISTRIBUTION_MESSAGE);
  if (service?.blocked === 'translocated') return step('先移到"应用程序"', 'warning', false, 'Vonvon Bot 正从临时位置运行，装成后台服务后下次会找不到它。把它拖到"应用程序"文件夹，从那里打开，再回到这一步。', [SERVICE_RECHECK]);
  switch (service?.state) {
    case 'running': return step('已开启', 'success', true, 'Bot 跑在后台服务里：退出 app、注销再登录都在线，崩溃后自动重启。');
    case 'detached': case 'stopped':
      return step('已开启 · 这次没交给后台服务', 'warning', true, '现在的 daemon 是单独启动的，崩溃后不会自动重启；下次登录电脑时会由后台服务启动。', [{kind: 'serviceInstall', label: '交给后台服务'}]);
    case 'disabled': return step('已在系统设置里关掉', 'warning', false, '在"系统设置 › 通用 › 登录项与扩展"的"允许在后台"里打开 Vonvon Bot，再点「重新检测」。', [SERVICE_RECHECK]);
    case 'not-installed': return service?.skipped
      ? step('已跳过', 'neutral', true, 'Bot 跑在单独启动的 daemon 里，退出 app 不停，但这样崩溃后不会自动重启；注销或重启电脑后要重新打开 app。', [{kind: 'serviceInstall', label: '改为自动运行'}])
      : step('推荐打开', 'warning', false, '打开后 Bot 跑在 macOS 的后台服务里：退出 app、注销再登录都在线，崩溃后自动重启。', [{kind: 'serviceInstall', label: '打开', primary: true}, {kind: 'serviceSkip', label: '跳过'}]);
    case 'conflict': return step('要处理', 'danger', false, service?.detail, [SERVICE_RECHECK]);
    default: return step('无法确认', 'neutral', false, serviceUnreachable('launchd', service?.detail), [SERVICE_RECHECK]);
  }
}

export const LINGER_OFF_WARNING = '没开 linger：退出最后一个登录会话后 Bot 会停，开机也不启动。在终端运行 loginctl enable-linger。';

/** Linux (1.4): read-only, the step names the terminal command. Without linger a running service is still done, with a
 * warning; an unreachable user manager gets the daemon's hint when it has one (s20a). */
function linuxServiceStep(service: ApplicationService | undefined): SetupStep & {id: 'service'} {
  const step = (status: string, tone: StepTone, done: boolean, detail: string | undefined, warnings?: readonly string[]) => ({id: 'service', title: '后台服务', status, tone, done, detail, actions: [], warnings} as const);
  switch (service?.state) {
    case 'running': {
      const boot = service.linger === 'on' ? '；开机就启动，退出 SSH 也在线' : '';
      return step('在运行', 'success', true, `Bot 跑在 systemd 用户服务里，崩溃后自动重启${boot}。`, service.linger === 'off' ? [LINGER_OFF_WARNING] : undefined);
    }
    case 'not-installed': return step('没装', 'neutral', false, '在终端运行 vonvon service install，装成 systemd 用户服务，崩溃后自动重启。');
    case 'disabled': return step('没启用', 'neutral', false, '在终端运行 vonvon service install。');
    case 'detached': return step('已装 · 这次没交给后台服务', 'warning', true, '在终端运行 vonvon daemon stop，再运行 vonvon daemon start。');
    case 'stopped': return step('已装 · 没在运行', 'warning', true, '在终端运行 vonvon daemon start。');
    case 'conflict': return step('要处理', 'danger', false, service?.detail);
    default: return step('无法确认', 'neutral', false, service?.hint ?? serviceUnreachable('systemd', service?.detail));
  }
}

/** The last service action's failure while it is recent, for the step's warning and the 登录电脑时启动 row. */
export function recentServiceFailure(service: ApplicationService | undefined, now = Date.now()): string | undefined {
  const action = service?.action;
  if (action?.phase !== 'done' || action.ok !== false) return undefined;
  return now - (action.finishedAt ?? action.startedAt) < SERVICE_FAILURE_SHOWN_FOR ? serviceActionMessage(action) : undefined;
}

/** The daemon's reply to the web page's switch, which the page also shows when the connection drops first. */
export const serviceActionStartedMessage = (action: ServiceActionReport['action']): string =>
  action === 'install' ? '正在打开登录时启动，页面会断开几秒。' : '正在关闭登录时启动，页面会断开几秒。';
export const SERVICE_BUSY_MESSAGE = '另一个后台服务操作正在进行，等它结束再试。';
/** Section 1.5: a running service has another definition, e.g. after the app moved or the PATH changed. */
export const SERVICE_REPLACE_RUNNING_MESSAGE = '后台服务正在用另一份定义运行（比如 app 换过位置或版本）。重新打开 Vonvon Bot 会自动更新；或者在终端运行 vonvon daemon stop 后再打开这个开关。';
const SERVICE_DISTRIBUTION_MESSAGE = '从源码运行的 daemon 不能装后台服务。用打包的 Vonvon Bot，或用 npm 装的 vonvon。';
const SERVICE_REASON_TEXT: Partial<Record<ServiceActionReason, string>> = {
  busy: SERVICE_BUSY_MESSAGE,
  'turned-off': '系统设置里关掉了 Vonvon Bot 的后台运行。到"系统设置 › 通用 › 登录项与扩展"的"允许在后台"里打开它，再点「重新检测」。',
  'replace-running': SERVICE_REPLACE_RUNNING_MESSAGE,
  // A development checkout is blocked before the switch; what reaches the transaction is mostly an unrecognized layout.
  distribution: '认不出这份 vonvon 是怎么装的，不能装后台服务。从源码运行的装不了；用 npm 装的，在终端运行 vonvon service install。',
  translocated: 'Vonvon Bot 正从临时位置运行。先把它拖到"应用程序"文件夹，从那里打开，再打开这个开关。',
  interrupted: '上次关闭没有做完。在终端运行 vonvon service uninstall，再试一次。',
};

/** What a finished `vonvon service install|uninstall` did, for the web UI, the desktop and the CLI. A failure names
 * the cause and the next step; the suffix says whether the bot was started again on its old port. */
export function serviceActionMessage(report: ServiceActionReport): string {
  // The s07 details are English sentences; drop their own full stop before Chinese punctuation follows.
  const detail = (report.detail ?? '').replace(/[.。]\s*$/, '');
  const failure = (): string => {
    const known = report.reason && SERVICE_REASON_TEXT[report.reason];
    if (known) return known;
    if (report.reason === 'other-root') return `后台服务属于另一个数据目录：${/belongs to (.+)$/.exec(detail)?.[1] ?? detail}。`;
    if (report.action === 'uninstall') return `没关掉：${detail}。在终端运行 vonvon service uninstall 再试。`;
    if (report.kind === 'install_rolled_back') return `没装上，已经恢复原样：${detail}`;
    if (report.kind === 'install_incomplete') return `没装完：${detail}。在终端运行 vonvon service status 查看。`;
    return `没装上：${detail}`;
  };
  const parts = report.ok ? [] : [failure()];
  if (report.restarted) parts.push('已按原来的端口重新起了 Bot（分离运行）。');
  if (report.restartError) parts.push('Bot 现在没在运行：在终端运行 vonvon daemon start。');
  return parts.map((part, index) => index < parts.length - 1 && !part.endsWith('。') ? `${part}。` : part).join('');
}
