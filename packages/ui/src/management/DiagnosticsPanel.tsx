import type {ReactNode} from 'react';
import {
  NOT_REPLIED_TEXT, OPTIONAL_SCOPE_EFFECTS, SCOPE_DENIAL_PLACE_TEXT, botSteps, connectionStep, toolSteps,
  type AdminSetupStatus, type Agent, type Command, type CommandResult, type DesktopSnapshot, type NotReplied, type SetupStep, type StepTone,
} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from '../client-context';
import {AgentAvatar} from '../AgentAvatar';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, StatusBadge} from '../reference/components/ui';
import {diagnosticsSection, settingAnchor} from '../search';
import {stepDescription} from '../setup/SetupChecklist';
import {useClaudeLoginCheck} from '../setup/useClaudeLoginCheck';
import {useSetupStatus, type SetupRead} from '../setup/useSetupStatus';
import {openExternalUrl} from '../url-actions';
import {LogPanel} from './LogPanel';
import './diagnostics.css';

/** `14:02` today, `10月14日 14:02` on another day. */
export function shortTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false});
  return date.toDateString() === new Date(now).toDateString() ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

const badge = (status: string, tone: StepTone) => <StatusBadge tone={tone} variant="pill">{status}</StatusBadge>;
const TOOL_NAMES: Record<string, string> = {'codex-appserver': 'Codex', 'claude-agent': 'Claude'};

/** 连接: the checklist's 长连接 step, plus a child that is down or a switch waiting for a restart. */
function connectionView(agent: Agent): Pick<SetupStep, 'status' | 'tone' | 'detail'> {
  if (!agent.readError && agent.enabled && !agent.running) return {status: '没在运行', tone: 'warning', detail: '可能正在崩溃重启，或者要重启 daemon 才生效；一直这样时看下面的日志。'};
  if (!agent.readError && !agent.enabled && agent.running) return {status: '待生效', tone: 'neutral', detail: '停用要重启 daemon 后才生效。'};
  if (agent.enabled && agent.connection === 'reconnecting') return {status: '重连中', tone: 'neutral'};
  return connectionStep(agent);
}

/** 缺的权限: what the developer console shows missing, and what Feishu refused while running. */
export function scopeView(status: AdminSetupStatus | undefined, agent: Agent, now: number) {
  const required = status?.scopes.missingRequired;
  const optional = status?.scopes.missingOptional?.filter(scope => scope in OPTIONAL_SCOPE_EFFECTS) ?? [];
  const missing = new Set([...required ?? [], ...optional]);
  const lines: ReactNode[] = [
    ...(required ?? []).map(scope => <li key={`r-${scope}`}><code>{scope}</code> 必需</li>),
    ...optional.map(scope => <li key={`o-${scope}`}><code>{scope}</code> 可选：{OPTIONAL_SCOPE_EFFECTS[scope]}</li>),
    ...(agent.diagnostics?.deniedScopes ?? []).map(denial => <li key={`d-${denial.scope}`}>
      {shortTime(denial.at, now)} {SCOPE_DENIAL_PLACE_TEXT[denial.where]}被飞书拒绝：<code>{denial.scope}</code>
      {required !== undefined && !missing.has(denial.scope) ? '。后台显示已开，但还没生效：在开发者后台发布一个新版本' : ''}
    </li>),
  ];
  const view = (text: string, tone: StepTone) => ({badge: badge(text, tone), lines});
  if (!status) return view('检查中', 'neutral');
  if (required === undefined) return view('暂时读不到已开通的权限', 'neutral');
  return missing.size ? view(`缺 ${missing.size} 项`, required.length ? 'warning' : 'neutral') : lines.length ? view('被拒过', 'warning') : view('没有缺的', 'success');
}

function NotRepliedList({records, snapshot, now}: {records: readonly NotReplied[]; snapshot: DesktopSnapshot; now: number}) {
  if (!records.length) return <>最近没有没回的消息。这里只记 @ 了这个 bot、或者按群设置该它回却没回的消息；daemon 重启后清空。</>;
  const groups = new Map(snapshot.groups.map(group => [group.id as string, group.name]));
  return <ul className="diagnostics-replies">{records.map(record => {
    const text = NOT_REPLIED_TEXT[record.reason];
    const where = [groups.get(record.groupId) ?? `没绑定的群（尾号 ${record.groupId.slice(-6)}）`, record.place === 'topic' ? '话题' : '主区', record.sender, record.ref && `消息尾号 ${record.ref}`].filter(Boolean).join(' · ');
    return <li key={`${record.at}-${record.ref ?? ''}-${record.reason}`}>
      <span className="diagnostics-replies__head"><time>{shortTime(record.at, now)}</time><strong>{text.reason(record)}</strong>{record.count > 1 && <span>{record.count} 次</span>}</span>
      <span>{where}</span>
      <span>{text.next(record)}</span>
    </li>;
  })}</ul>;
}

function BotDiagnostics({agent, snapshot, read, tools, onOpenSetup, onError}: {
  agent: Agent; snapshot: DesktopSnapshot; read: SetupRead | undefined; tools: readonly SetupStep[];
  onOpenSetup: () => void; onError: (message: string) => void;
}) {
  const shell = useShellCapabilities();
  const now = Date.now();
  const records = agent.diagnostics?.notReplied ?? [];
  const total = records.reduce((sum, record) => sum + record.count, 0);
  const connection = connectionView(agent);
  const left = read?.status ? botSteps(agent, read.status).filter(step => !step.done) : [];
  const setup = read?.status
    ? left.length ? badge(`还差 ${left.length} 步：${left.map(step => step.title).join('、')}`, 'warning') : badge('全部完成', 'success')
    : badge(read?.problem ? '读取失败' : '检查中', read?.problem ? 'warning' : 'neutral');
  const scopes = scopeView(read?.status, agent, now);
  const grantUrl = read?.status?.scopes.grantUrl;
  const counts = new Map<string, number>();
  for (const member of snapshot.memberships) if (member.agentId === agent.id) counts.set(member.backend, (counts.get(member.backend) ?? 0) + 1);
  const toolText = [...counts].map(([backend, count]) => {
    const step = tools.find(item => item.title === TOOL_NAMES[backend]);
    return `${TOOL_NAMES[backend] ?? backend}${step ? ` ${step.status}` : ''}（${count} 个群）`;
  }).join('；');
  return <SettingsGroup id={settingAnchor(diagnosticsSection(agent.id))}
    label={<span className="diagnostics-bot"><AgentAvatar agent={agent}/>{agent.name}{total > 0 && <StatusBadge tone="warning">{`${total} 条没回`}</StatusBadge>}</span>}>
    <SettingsRow title="连接" description={connection.detail} trailing={badge(connection.status, connection.tone)}/>
    <SettingsRow title="飞书设置" description={read?.problem && !read.status ? read.problem : undefined}
      trailing={<span className="setup-step-trailing">{setup}<Button size="sm" onClick={onOpenSetup}>打开清单</Button></span>}/>
    <SettingsRow title="缺的权限" description={scopes.lines.length ? <ul className="diagnostics-scopes">{scopes.lines}</ul> : undefined}
      trailing={<span className="setup-step-trailing">{scopes.badge}{grantUrl && (scopes.lines.length > 0) && <Button size="sm"
        onClick={() => void openExternalUrl(grantUrl, 'app-console', shell).catch(error => onError(error instanceof Error ? error.message : '无法打开开发者后台。'))}>一键开权限</Button>}</span>}/>
    <SettingsRow title="执行工具" value={toolText || '还没有绑定群'}/>
    <SettingsRow title="最近没回的消息" description={<NotRepliedList records={records} snapshot={snapshot} now={now}/>}/>
  </SettingsGroup>;
}

/** 状态与诊断 (product.md 3.1 item 8): this machine's tools, then each bot's connection, setup, scopes,
 * tools and recent not-replied messages, then the daemon log. s18 puts its red bar above 这台电脑. */
export function DiagnosticsPanel({snapshot, ready, busy, run, onOpenSetup, onOpenEnvironment, onNotice}: {
  snapshot: DesktopSnapshot; ready: boolean; busy: boolean;
  run: (command: Command) => Promise<CommandResult>;
  onOpenSetup: () => void; onOpenEnvironment: () => void;
  onNotice: (message: string, error: boolean) => void;
}) {
  const client = useClient();
  const {reads, recheck} = useSetupStatus(snapshot.agents.map(agent => agent.id), {poll: false});
  const claudeLogin = useClaudeLoginCheck(snapshot.tools, message => onNotice(message, true));
  const tools = toolSteps(snapshot.tools, {claudeChecking: claudeLogin.checking}).steps;
  const host = snapshot.host;
  const checking = Object.values(reads).some(read => read?.checking);
  async function recheckAll() {
    // No CLI is started: the snapshot is rebuilt and each bot's Feishu settings are read once more.
    await run({type: 'refresh'});
    await Promise.all(snapshot.agents.map(agent => recheck(agent.id)));
  }
  function toolAction(step: SetupStep) {
    const action = step.actions[0];
    if (!action) return null;
    const act = action.kind === 'claudeLogin' ? () => void claudeLogin.check(true)
      : action.kind === 'codexLogin' ? () => void run({type: 'startCodexLogin'}).catch(() => undefined) : onOpenEnvironment;
    return <Button size="sm" loading={action.kind === 'claudeLogin' && claudeLogin.checking} disabled={busy || !ready} onClick={act}>{action.label}</Button>;
  }
  return <div className="page-stack diagnostics-page">
    <SettingsGroup label="这台电脑" id={settingAnchor('这台电脑')}
      action={<Button size="sm" loading={checking} disabled={busy || !ready} onClick={() => void recheckAll().catch(error => onNotice(error instanceof Error ? error.message : '重新检查没有完成。', true))}>重新检查</Button>}
      footer="执行工具每分钟检查一次；Claude 的登录在打开这一页或点「检查登录」时检查。">
      <SettingsRow title="daemon 版本" value={host.kind === 'connected' ? host.version : '未知'}/>
      {tools.map(step => <SettingsRow key={step.id} title={step.title} description={stepDescription(step)}
        trailing={<span className="setup-step-trailing">{badge(step.status, step.tone)}{toolAction(step)}</span>}/>)}
      <SettingsRow title="数据目录" value={<code>{snapshot.application.dataPath}</code>}/>
      <SettingsRow title="最近读取" value={snapshot.observedAt ? new Date(snapshot.observedAt).toLocaleTimeString() : '尚未读取'}/>
    </SettingsGroup>
    {snapshot.agents.map(agent => <BotDiagnostics key={agent.id} agent={agent} snapshot={snapshot} read={reads[agent.id]} tools={tools}
      onOpenSetup={onOpenSetup} onError={message => onNotice(message, true)}/>)}
    <LogPanel request={client.machine}/>
  </div>;
}
