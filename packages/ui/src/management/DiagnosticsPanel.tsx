import type {ReactNode} from 'react';
import {
  CUSTOM_PROMPT_NOTICE, NOT_REPLIED_TEXT, OPTIONAL_SCOPE_EFFECTS, SCOPE_DENIAL_PLACE_TEXT, backendLabel, botSteps, connectionStep, crashText, formatTime, toolSteps,
  type AdminSetupStatus, type Agent, type Command, type CommandResult, type CrashEntry, type DesktopSnapshot, type DirectoryProblem, type Membership, type NotReplied, type SetupStep, type StepAction, type StepTone,
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
import {KeyDiagnosticsRows, useSecrets} from './SecretsPanel';
import './diagnostics.css';

const badge = (status: string, tone: StepTone) => <StatusBadge tone={tone} variant="pill">{status}</StatusBadge>;

/** 连接: the checklist's 长连接 step, plus a paused bot or daemon, a child that is down or a switch waiting for a restart. */
function connectionView(agent: Agent, hostPaused: boolean): Pick<SetupStep, 'status' | 'tone' | 'detail'> {
  if (agent.enabled && agent.paused) return {status: '已暂停', tone: 'danger', detail: `10 分钟内崩溃了 ${agent.paused.crashes} 次，见上面的红条。`};
  if (agent.enabled && agent.lockHeld) return {status: '等待占用的进程退出', tone: 'warning', detail: agent.lockHeld.message ?? `另一个进程${agent.lockHeld.pid ? `（PID ${agent.lockHeld.pid}）` : ''}占着这个 Bot；它退出后会自动接上。`};
  if (!agent.readError && agent.enabled && !agent.running) return {status: '没在运行', tone: 'warning', detail: hostPaused ? 'daemon 已暂停，见上面的红条。' : '可能正在崩溃重启，或者要重启 daemon 才生效；一直这样时看下面的日志。'};
  if (!agent.readError && !agent.enabled && agent.running) return {status: '待生效', tone: 'neutral', detail: '停用要重启 daemon 后才生效。'};
  if (agent.enabled && agent.connection === 'reconnecting') return {status: '重连中', tone: 'neutral'};
  return connectionStep(agent);
}

/** 缺的权限: what the console shows missing and what Feishu refused while running; a failed read as in 飞书设置 above. */
export function scopeView(status: AdminSetupStatus | undefined, agent: Agent, now: number, problem?: string) {
  const required = status?.scopes.missingRequired;
  const optional = status?.scopes.missingOptional?.filter(scope => scope in OPTIONAL_SCOPE_EFFECTS) ?? [];
  const missing = new Set([...required ?? [], ...optional]);
  const lines: ReactNode[] = [
    ...(required ?? []).map(scope => <li key={`r-${scope}`}><code>{scope}</code> 必需</li>),
    ...optional.map(scope => <li key={`o-${scope}`}><code>{scope}</code> 可选：{OPTIONAL_SCOPE_EFFECTS[scope]}</li>),
    ...(agent.diagnostics?.deniedScopes ?? []).map(denial => <li key={`d-${denial.scope}`}>
      {formatTime(denial.at, {now})} {SCOPE_DENIAL_PLACE_TEXT[denial.where]}被飞书拒绝：<code>{denial.scope}</code>
      {required !== undefined && !missing.has(denial.scope) ? '。后台显示已开，但还没生效：在开发者后台发布一个新版本' : ''}
    </li>),
  ];
  const view = (text: string, tone: StepTone) => ({badge: badge(text, tone), lines});
  if (!status) return problem ? view('读取失败', 'warning') : view('检查中', 'neutral');
  if (required === undefined) return view('暂时读不到已开通的权限', 'neutral');
  if (missing.size) return view(`缺 ${missing.size} 项`, required.length ? 'warning' : 'neutral');
  if (lines.length) return view('被拒过', 'warning');
  return view('没有缺的', 'success');
}

/** 飞书设置: the checklist's Feishu steps still to do, and its warnings about optional events; the
 * scopes step's warning is the 缺的权限 row's. */
export function setupView(agent: Agent, read: SetupRead | undefined): {badge: ReactNode; warnings: string[]} {
  if (!read?.status) return {badge: read?.problem ? badge('读取失败', 'warning') : badge('检查中', 'neutral'), warnings: []};
  const steps = botSteps(agent, read.status);
  const left = steps.filter(step => !step.done);
  const warnings = steps.flatMap(step => step.id === 'scopes' ? [] : step.warnings ?? []);
  return {badge: left.length ? badge(`还差 ${left.length} 步：${left.map(step => step.title).join('、')}`, 'warning') : badge('全部完成', 'success'), warnings};
}

function NotRepliedList({records, agent, snapshot, now}: {records: readonly NotReplied[]; agent: Agent; snapshot: DesktopSnapshot; now: number}) {
  if (!records.length) return <>暂无未回复记录。<details className="diagnostics-note"><summary>记录范围</summary><p>记录被 @、群设置要求回复、智能判断后未回复，以及主动接话后未发送的消息。重启后台服务后清空。</p></details></>;
  const groups = new Map(snapshot.groups.map(group => [group.id as string, group.name]));
  return <ul className="diagnostics-replies">{records.map(record => {
    const text = NOT_REPLIED_TEXT[record.reason];
    const where = [
      groups.get(record.groupId) ?? `没绑定的群（尾号 ${record.groupId.slice(-6)}）`,
      record.place === 'topic' ? '话题' : '主区',
      record.sender,
      record.ref && `消息尾号 ${record.ref}`,
    ].filter(Boolean).join(' · ');
    return <li key={`${record.at}-${record.ref ?? ''}-${record.reason}`}>
      <span className="diagnostics-replies__head"><time>{formatTime(record.at, {now})}</time><strong>{text.reason(record)}</strong>{record.count > 1 && <span>{record.count} 次</span>}</span>
      <span>{where}</span>
      <span>{text.next(record, {id: agent.id, several: snapshot.agents.length > 1})}</span>
    </li>;
  })}</ul>;
}

/** Why a directory an older version gave a group is wrong (s36c2d). */
export const DIRECTORY_PROBLEM_TEXT: Record<DirectoryProblem, string> = {
  botRoot: '用的是某个 Bot 自己的目录，这个 Bot 的群目录都在它下面',
  projectsRoot: '用的是工作区的默认位置本身，所有 Bot 的目录都在它下面',
  dataDir: '在 Vonvon 的数据目录里（projects/ 以外），这里不能当工作区',
  dataDirParent: '用的是 Vonvon 数据目录的上级文件夹，这里不能当工作区',
};

/** 群目录: groups an older version put in a wrong place; nothing is moved for them. */
function DirectoryProblems({members}: {members: readonly Membership[]}) {
  return <>
    <ul className="diagnostics-scopes">{members.map(member => <li key={member.id}>「{member.name}」{DIRECTORY_PROBLEM_TEXT[member.directoryProblem!]}：<code>{member.directory}</code></li>)}</ul>
    请在群设置的「工作区」中更换目录。原文件不会自动迁移。
  </>;
}

/** 最近的崩溃 (s18a): the last day's records, newest first; absent when the daemon is older than s18a. */
function CrashList({records, now}: {records: readonly CrashEntry[]; now: number}) {
  if (!records.length) return <>最近 24 小时没有崩溃。</>;
  return <ul className="diagnostics-replies">{records.map(record => <li key={`${record.at}-${record.kind}-${record.reason}`}>
    <span className="diagnostics-replies__head"><time>{formatTime(record.at, {now})}</time><strong>{crashText(record)}</strong></span>
  </li>)}</ul>;
}

function SmartDiagnostics({agent, snapshot, now}: {agent: Agent; snapshot: DesktopSnapshot; now: number}) {
  const groups = snapshot.memberships.filter(member => member.agentId === agent.id && member.conversation === 'smart');
  if (!groups.length) return null;
  return <>
    <SettingsRow title="智能群关注状态" description={<ul className="diagnostics-scopes">{groups.map(member => {
      const state = agent.running && agent.enabled && !member.stale ? agent.diagnostics?.attention?.find(item => item.groupId === member.groupId) : undefined;
      const main = state?.main ? `主区${state.main.mode === 'focus' ? '专注' : `留意（间隔 ${state.main.intervalMs / 1000} 秒）`}` : '主区尚无关注状态';
      const budget = state?.budget && state.budget.until > now ? state.budget.kind === 'no-glance' ? '；判断预算已到 45 次，暂停扫一眼' : '；判断预算已到 60 次，仅真人 @、引用或回答它的根消息仍判断' : '';
      return <li key={member.id}>{member.name}：{!agent.enabled || !agent.running ? 'Bot 未运行' : member.stale ? '群状态暂不可读' : !agent.diagnostics?.attention ? 'daemon 未提供关注状态' : `${main}；话题专注 ${state?.focusedTopics ?? 0} 个、留意 ${state?.watchedTopics ?? 0} 个${budget}`}</li>;
    })}</ul>}/>
    {groups.some(member => agent.diagnostics?.customPromptGroups?.includes(member.groupId)) && <SettingsRow title="自定义智能提示词" description={<ul className="diagnostics-scopes">{groups.filter(member => agent.diagnostics?.customPromptGroups?.includes(member.groupId)).map(member => <li key={member.id}>{member.name}：{CUSTOM_PROMPT_NOTICE}</li>)}</ul>}/>}
  </>;
}

function BotDiagnostics({agent, snapshot, read, tools, onOpenSetup, onError}: {
  agent: Agent; snapshot: DesktopSnapshot; read: SetupRead | undefined; tools: readonly SetupStep[];
  onOpenSetup: () => void; onError: (message: string) => void;
}) {
  const shell = useShellCapabilities();
  const now = Date.now();
  const records = agent.diagnostics?.notReplied ?? [];
  const total = records.reduce((sum, record) => sum + record.count, 0);
  const connection = connectionView(agent, Boolean(snapshot.application.crashes?.paused));
  const crashes = snapshot.application.crashes?.records.filter(record => record.appId === agent.id);
  const scopes = scopeView(read?.status, agent, now, read?.problem);
  const setup = setupView(agent, read);
  const grantUrl = read?.status?.scopes.grantUrl;
  const counts = new Map<string, number>();
  for (const member of snapshot.memberships) if (member.agentId === agent.id) counts.set(member.backend, (counts.get(member.backend) ?? 0) + 1);
  const misplaced = snapshot.memberships.filter(member => member.agentId === agent.id && member.directoryProblem);
  const toolText = [...counts].map(([backend, count]) => {
    const step = tools.find(item => item.title === backendLabel(backend));
    return `${backendLabel(backend)}${step ? ` ${step.status}` : ''}（${count} 个群）`;
  }).join('；');
  return <SettingsGroup id={settingAnchor(diagnosticsSection(agent.id))}
    label={<span className="diagnostics-bot"><AgentAvatar agent={agent}/>{agent.name}{total > 0 && <StatusBadge tone="warning">{`${total} 条没回`}</StatusBadge>}</span>}>
    <SettingsRow title="连接" description={connection.detail} trailing={badge(connection.status, connection.tone)}/>
    <SettingsRow title="飞书设置" description={read?.problem && !read.status ? read.problem
      : setup.warnings.length ? <ul className="diagnostics-scopes">{setup.warnings.map(text => <li key={text}>{text}</li>)}</ul> : undefined}
      trailing={<span className="setup-step-trailing">{setup.badge}<Button size="sm" onClick={onOpenSetup}>检查连接</Button></span>}/>
    <SettingsRow title="缺的权限" description={scopes.lines.length ? <ul className="diagnostics-scopes">{scopes.lines}</ul> : undefined}
      trailing={<span className="setup-step-trailing">{scopes.badge}{grantUrl && scopes.lines.length > 0 && <Button size="sm"
        onClick={() => void openExternalUrl(grantUrl, 'app-console', shell).catch(error => onError(error instanceof Error ? error.message : '无法打开开发者后台。'))}>一键开权限</Button>}</span>}/>
    <SettingsRow title="Provider" description={toolText || '尚未连接群聊'}/>
    {misplaced.length > 0 && <SettingsRow title="群目录" description={<DirectoryProblems members={misplaced}/>} trailing={badge(`${misplaced.length} 个群放错了位置`, 'warning')}/>}
    <SmartDiagnostics agent={agent} snapshot={snapshot} now={now}/>
    <SettingsRow title="最近没回的消息" description={<NotRepliedList records={records} agent={agent} snapshot={snapshot} now={now}/>}/>
    {crashes && <SettingsRow title="最近的崩溃" description={<CrashList records={crashes} now={now}/>}/>}
  </SettingsGroup>;
}

/** The red bars (3.10): the paused daemon's alone, whose 恢复运行 restarts it with a new chain that ends the bots' pauses
 * too; otherwise one per paused bot, whose 恢复运行 starts that bot alone again. */
export function crashBars(snapshot: DesktopSnapshot): Array<{key: string; text: string; command: Command}> {
  const host = snapshot.application.crashes?.paused;
  if (host) return [{key: 'daemon', text: `daemon 已暂停：10 分钟内崩溃了 ${host.crashes} 次，Bot 都没有启动。查完下面的崩溃记录后点「恢复运行」。`, command: {type: 'restartHost'}}];
  return snapshot.agents.flatMap(agent => agent.enabled && agent.paused ? [{key: agent.id, command: {type: 'setAgentEnabled', agentId: agent.id, enabled: true},
    text: `「${agent.name}」10 分钟内崩溃了 ${agent.paused.crashes} 次，已停止自动重启，别的 Bot 照常。查完下面的崩溃记录后点「恢复运行」。`}] : []);
}

function CrashBars({snapshot, ready, busy, run}: {snapshot: DesktopSnapshot; ready: boolean; busy: boolean; run: (command: Command) => Promise<CommandResult>}) {
  return <>{crashBars(snapshot).map(bar => <div key={bar.key} role="alert" className="diagnostics-alert">
    <span>{bar.text}</span><Button size="sm" disabled={busy || !ready} onClick={() => void run(bar.command)}>恢复运行</Button>
  </div>)}</>;
}

/** The daemon log at the bottom of the page, scrolled to and focused. */
function showLog() {
  const section = document.getElementById(settingAnchor('daemon 日志'));
  if (!section) return;
  section.tabIndex = -1;
  section.scrollIntoView({block: 'start'});
  section.focus({preventScroll: true});
}

/** 状态与诊断 (product.md 3.1 item 8): the red bar of a crash pause, this machine's tools, its decision models' keys
 * (s23g2) and the daemon's crashes, then each bot's connection, setup, scopes, tools, misplaced group directories,
 * recent not-replied messages and crashes, then the daemon log. */
export function DiagnosticsPanel({snapshot, ready, busy, run, onOpenSetup, onOpenEnvironment, onOpenSecrets, onNotice}: {
  snapshot: DesktopSnapshot; ready: boolean; busy: boolean;
  run: (command: Command) => Promise<CommandResult>;
  onOpenSetup: () => void; onOpenEnvironment: () => void; onOpenSecrets: () => void;
  onNotice: (message: string, error: boolean) => void;
}) {
  const client = useClient();
  const secrets = useSecrets();
  const {reads, recheck} = useSetupStatus(snapshot.agents.map(agent => agent.id), {poll: false});
  const claudeLogin = useClaudeLoginCheck(snapshot.tools, message => onNotice(message, true));
  const tools = toolSteps(snapshot.tools, {claudeChecking: claudeLogin.checking}).steps;
  const host = snapshot.host;
  const checking = Object.values(reads).some(read => read?.checking);
  async function recheckAll() {
    // No CLI is started: the snapshot is rebuilt and each bot's Feishu settings are read once more.
    await run({type: 'refresh'});
    await Promise.all([...snapshot.agents.map(agent => recheck(agent.id)), secrets.reader.read()]);
  }
  function act(action: StepAction) {
    if (action.kind === 'claudeLogin') void claudeLogin.check(true);
    else if (action.kind === 'codexLogin') void run({type: 'startCodexLogin'}).catch(() => undefined);
    else onOpenEnvironment();
  }
  function toolAction(step: SetupStep) {
    const action = step.actions[0];
    if (!action) return null;
    return <Button size="sm" loading={action.kind === 'claudeLogin' && claudeLogin.checking} disabled={busy || !ready} onClick={() => act(action)}>{action.label}</Button>;
  }
  const crashes = snapshot.application.crashes;
  return <div className="page-stack diagnostics-page">
    <CrashBars snapshot={snapshot} ready={ready} busy={busy} run={run}/>
    <SettingsGroup label="这台电脑" id={settingAnchor('这台电脑')}
      action={<Button size="sm" loading={checking} disabled={busy || !ready} onClick={() => void recheckAll().catch(error => onNotice(error instanceof Error ? error.message : '重新检查没有完成。', true))}>重新检查</Button>}
      footer="后端每分钟检查一次；Claude 的登录在打开这一页或点「检查登录」时检查。">
      <SettingsRow title="daemon 版本" value={host.kind === 'connected' ? host.version : '未知'}/>
      {tools.map(step => <SettingsRow key={step.id} title={step.title} description={stepDescription(step)}
        trailing={<span className="setup-step-trailing">{badge(step.status, step.tone)}{toolAction(step)}</span>}/>)}
      <KeyDiagnosticsRows read={secrets.read} onOpenSecrets={onOpenSecrets} onShowLog={showLog}/>
      <SettingsRow title="数据目录" value={<code>{snapshot.application.dataPath}</code>}/>
      <SettingsRow title="最近读取" value={snapshot.observedAt ? formatTime(snapshot.observedAt) : '尚未读取'}/>
      {crashes && <SettingsRow title="最近的崩溃" description={<CrashList records={crashes.records.filter(record => !record.appId)} now={Date.now()}/>}/>}
    </SettingsGroup>
    {snapshot.agents.map(agent => <BotDiagnostics key={agent.id} agent={agent} snapshot={snapshot} read={reads[agent.id]} tools={tools}
      onOpenSetup={onOpenSetup} onError={message => onNotice(message, true)}/>)}
    <LogPanel request={client.machine}/>
  </div>;
}
