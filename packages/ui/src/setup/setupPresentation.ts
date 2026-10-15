import type {AdminSetupStatus, Agent, ToolState} from '@vonvon/protocol';

export type StepTone = 'success' | 'warning' | 'danger' | 'neutral';
/** What the step's button does; the checklist component wires each kind. */
export type StepAction =
  | {kind: 'reauthorize'; label: string}
  | {kind: 'open'; label: string; url: string; target: 'app-console' | 'event-settings'}
  | {kind: 'enable'; label: string}
  | {kind: 'confirmCallback'; label: string; confirmed: boolean}
  | {kind: 'environment'; label: string}
  | {kind: 'codexLogin'; label: string}
  | {kind: 'claudeLogin'; label: string};
export type SetupStep = {
  id: 'credentials' | 'scopes' | 'connection' | 'event' | 'callback' | 'publish' | 'codex' | 'claude';
  title: string; status: string; tone: StepTone; done: boolean;
  detail?: string; items?: readonly string[]; actions: readonly StepAction[];
  /** Shown under the step without changing its tone or `done`: optional settings whose absence breaks a later flow. */
  warnings?: readonly string[];
};

/** Join-group scope and bot-added event: optional for receiving messages, needed to bind groups (s02a). */
export const JOIN_SCOPE_WARNING = '还没开读群信息的权限（im:chat:readonly）：把 bot 拉进群后不会提醒你绑定，「查找已经加入的群」也会失败。';
export const BOT_ADDED_WARNING = '没订阅「机器人进群」（im.chat.member.bot.added_v1）：把 bot 拉进群后不会提醒你绑定。';

/** The order follows the Feishu console: the long connection must be up before the
 * event page can save "长连接" mode, and events only count once a version is published. */
export function botSteps(agent: Agent, status: AdminSetupStatus | undefined, problem?: string): SetupStep[] {
  if (!status) {
    const reading = {status: problem ? '检测失败' : '正在检测…', tone: problem ? 'warning' : 'neutral', done: false, detail: problem, actions: []} as const;
    return [{id: 'credentials', title: '飞书应用', ...reading}, connectionStep(agent)];
  }
  const event = status.event;
  const eventSettings: StepAction = {kind: 'open', label: '打开事件设置', url: status.eventConfigUrl, target: 'event-settings'};
  const botAdded = event.missingOptional?.includes('im.chat.member.bot.added_v1') ? [BOT_ADDED_WARNING] : undefined;
  const steps: SetupStep[] = [
    status.credentials.ok
      ? {id: 'credentials', title: '飞书应用', status: '凭据有效', tone: 'success', done: true, actions: []}
      : status.credentials.unreachable
        ? {id: 'credentials', title: '飞书应用', status: '无法确认', tone: 'neutral', done: false, detail: `连不上飞书，凭据还没检测：${status.credentials.reason ?? '未知原因'}。网络恢复后会自动重试。`, actions: []}
        : {id: 'credentials', title: '飞书应用', status: '凭据无效', tone: 'danger', done: false, detail: status.credentials.reason ?? '读不到这个 Bot 的凭据。', actions: [{kind: 'reauthorize', label: '重新扫码'}]},
    scopeStep(status),
    connectionStep(agent),
    event.state === 'ok'
      ? {id: 'event', title: '事件订阅', status: '已订阅接收消息', tone: 'success', done: true, detail: event.missingOptional?.length ? '有几项可选事件没订阅，不影响收消息。' : undefined, items: event.missingOptional, actions: [], warnings: botAdded}
      : event.state === 'missing'
        ? {id: 'event', title: '事件订阅', status: '缺少接收消息事件', tone: 'warning', done: false, detail: '在事件设置里选"使用长连接接收事件"，添加"接收消息"（im.message.receive_v1），再发布一个新版本。', actions: [eventSettings], warnings: botAdded}
        : event.state === 'unpublished'
          ? {id: 'event', title: '事件订阅', status: '上线后才能确认', tone: 'neutral', done: false, detail: '在事件设置里选"使用长连接接收事件"，添加"接收消息"（im.message.receive_v1）。版本上线后这里会自动确认。', actions: [eventSettings]}
          : {id: 'event', title: '事件订阅', status: '无法确认', tone: 'neutral', done: false, detail: event.reason, actions: [eventSettings]},
    status.cardCallback.confirmed
      ? {id: 'callback', title: '卡片回调', status: '已勾选', tone: 'success', done: true, actions: [{kind: 'confirmCallback', label: '取消勾选', confirmed: false}]}
      : {id: 'callback', title: '卡片回调', status: '请手动确认', tone: 'neutral', done: false, detail: '飞书没有接口能查这一项。在"事件与回调"的回调配置里，同样选长连接，添加"卡片回传交互"（card.action.trigger），配好后勾上。', actions: [eventSettings, {kind: 'confirmCallback', label: '我已配置', confirmed: true}]},
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

function connectionStep(agent: Agent): SetupStep {
  const base = {id: 'connection', title: '长连接'} as const;
  if (agent.readError) return {...base, status: '读取失败', tone: 'warning', done: false, detail: agent.readError, actions: []};
  if (!agent.enabled) return {...base, status: '没有启用', tone: 'warning', done: false, detail: '启用后 Bot 会连上飞书，事件设置页才能保存长连接方式。', actions: [{kind: 'enable', label: '启用 Bot'}]};
  if (agent.connection === 'connected') return {...base, status: '已连接', tone: 'success', done: true, actions: []};
  if (agent.connection === 'connecting' || agent.connection === 'reconnecting') return {...base, status: '连接中', tone: 'neutral', done: false, actions: []};
  return {...base, status: '未连接', tone: 'warning', done: false, detail: '凭据有效但连不上时，检查网络，或重新扫码。', actions: []};
}

/** Steps that only Feishu can answer; when they are all done the poller stops. */
export function remoteStepsDone(status: AdminSetupStatus | undefined): boolean {
  return Boolean(status && status.credentials.ok && status.scopes.missingRequired?.length === 0 && status.event.state === 'ok' && status.cardCallback.confirmed);
}

export type ToolSteps = {steps: SetupStep[]; ready: boolean};
/** Codex or Claude: either one installed, signed in and new enough is enough. */
export function toolSteps(tools: readonly ToolState[]): ToolSteps {
  const codex = tools.find(tool => tool.tool === 'codex');
  const claude = tools.find(tool => tool.tool === 'claude');
  const steps = [codexStep(codex), claudeStep(claude)];
  return {steps, ready: steps.some(step => step.done)};
}

function codexStep(tool: ToolState | undefined): SetupStep {
  const base = {id: 'codex', title: 'Codex'} as const;
  const version = tool?.version ? ` · ${tool.version}` : '';
  if (!tool || tool.installation === 'unknown') return {...base, status: '无法确认', tone: 'neutral', done: false, detail: tool?.message, actions: [{kind: 'environment', label: '去本机环境'}]};
  if (tool.installation === 'missing') return {...base, status: '未安装', tone: 'neutral', done: false, detail: '可以在本机环境里装托管副本（要用本机的 Node.js 和 npm）。没装 Node.js 的话，装 ChatGPT 或 Codex 桌面应用，或者用 Homebrew 装 Codex。', actions: [{kind: 'environment', label: '去本机环境'}]};
  const compatibility = tool.compatibility;
  if (compatibility?.status === 'tooOld') return {...base, status: `版本太旧${version}`, tone: 'warning', done: false, detail: `最低要 ${compatibility.minimum}，请在本机环境更新。`, actions: [{kind: 'environment', label: '去本机环境'}]};
  if (tool.authentication === 'signedOut') return {...base, status: `未登录${version}`, tone: 'warning', done: false, detail: tool.message, actions: [{kind: 'codexLogin', label: '登录 Codex'}]};
  if (tool.authentication === 'unknown') return {...base, status: `登录状态无法确认${version}`, tone: 'neutral', done: false, detail: tool.message, actions: [{kind: 'environment', label: '去本机环境'}]};
  const newer = compatibility?.status === 'newer' ? `比验证过的 ${compatibility.verified} 新，一般能用。` : undefined;
  return {...base, status: `可用${version}`, tone: 'success', done: true, detail: newer, actions: []};
}

function claudeStep(tool: ToolState | undefined): SetupStep {
  const base = {id: 'claude', title: 'Claude'} as const;
  const version = tool?.version ? ` · ${tool.version}` : '';
  if (!tool || tool.installation === 'unknown') return {...base, status: '无法确认', tone: 'neutral', done: false, detail: tool?.message, actions: [{kind: 'environment', label: '去本机环境'}]};
  if (tool.installation === 'missing') return {...base, status: '未安装', tone: 'neutral', done: false, detail: '要用 Claude，在本机环境里安装 Claude Agent SDK。', actions: [{kind: 'environment', label: '去本机环境'}]};
  if (tool.authentication === 'signedIn' || tool.authentication === 'notRequired') return {...base, status: `已登录${version}`, tone: 'success', done: true, detail: tool.message, actions: [{kind: 'claudeLogin', label: '检查登录'}]};
  const status = tool.authentication === 'signedOut' ? '未登录' : '登录状态无法确认';
  return {...base, status: `${status}${version}`, tone: tool.authentication === 'signedOut' ? 'warning' : 'neutral', done: false, detail: tool.message ?? '在终端运行 claude 并登录，然后点"检查登录"。', actions: [{kind: 'claudeLogin', label: '检查登录'}]};
}
