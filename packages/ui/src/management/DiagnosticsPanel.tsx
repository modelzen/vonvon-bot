import type {SetupProvider} from '../setup/provider-state';
import {ChevronDown, RefreshCw} from 'lucide-react';
import {useRef, useState, type ReactNode} from 'react';
import {
  CUSTOM_PROMPT_NOTICE, FEISHU_TOOL_SCOPE_EFFECTS, NOT_REPLIED_TEXT, OPTIONAL_SCOPE_EFFECTS, SCOPE_DENIAL_PLACE_TEXT, backendLabel, botSteps, connectionStep, crashText, formatTime, toolSteps,
  type AdminSetupStatus, type Agent, type AgentId, type Command, type CommandResult, type CrashEntry, type DesktopSnapshot, type DirectoryProblem, type Membership, type NotReplied, type SetupStep, type StepAction, type StepTone,
} from '@vonvon/protocol';
import {useActiveDevice, useClient, useShellCapabilities} from '../client-context';
import {diagnosticsToolsFooter, onDeviceText, toolStepsOn, whereName} from '../device-copy';
import {AgentAvatar} from '../AgentAvatar';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, IconButton, StatusBadge} from '../reference/components/ui';
import {diagnosticsSection, settingAnchor} from '../search';
import {stepDescription} from '../setup/SetupChecklist';
import {useClaudeLoginCheck} from '../setup/useClaudeLoginCheck';
import {useSetupStatus, type SetupRead} from '../setup/useSetupStatus';
import {openExternalUrl} from '../url-actions';
import {LogPanel} from './LogPanel';
import {KeyDiagnosticsRows, useSecrets} from './SecretsPanel';
import {nowGroupAttention} from '../now-attention';
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

/** 飞书文档能力: what the Bot's Feishu tools can't do yet. Optional, so it never counts as 飞书设置 left to do. */
export function toolScopeView(status: AdminSetupStatus | undefined): {badge: ReactNode; lines: ReactNode[]; url?: string} | undefined {
  const missing = status?.scopes.missingTools;
  if (!missing) return undefined;
  if (!missing.length) return {badge: badge('没有缺的', 'success'), lines: []};
  const effects = [...new Set(missing.map(scope => FEISHU_TOOL_SCOPE_EFFECTS[scope] ?? scope))];
  return {
    badge: badge(`缺 ${missing.length} 项`, 'neutral'),
    lines: [...effects.map(effect => <li key={effect}>{effect}</li>), <li key="after">开通后要发布新版本才生效；打不开链接，就转给这个飞书应用的管理员。</li>],
    url: status?.scopes.toolsGrantUrl,
  };
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
  // Provider remediation names its settings page and the device being inspected.
  const device = useActiveDevice();
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
      <span>{onDeviceText(device, text.next(record, {id: agent.id, several: snapshot.agents.length > 1}, snapshot.tools.find(tool => tool.tool === (record.backend ?? 'codex'))?.command), record.reason === 'codex-too-old' || record.reason === 'tool-missing' ? 'providers' : 'tools')}</span>
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
function DirectoryProblems({members, onOpenMembership}: {members: readonly Membership[]; onOpenMembership?: (id: Membership['id']) => void}) {
  return <>
    <ul className="diagnostics-scopes">{members.map(member => <li key={member.id}>
      「{member.name}」{DIRECTORY_PROBLEM_TEXT[member.directoryProblem!]}：<code>{member.directory}</code>
      {onOpenMembership && <> <Button size="sm" variant="ghost" onClick={() => onOpenMembership(member.id)}>去更换</Button></>}
    </li>)}</ul>
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
    <SettingsRow title="智能群注意力" description={<ul className="diagnostics-scopes">{groups.map(member => {
      const reading = nowGroupAttention(agent, member, snapshot.host.kind === 'connected', snapshot.stale, now, snapshot.attentionModel === 'group');
      return <li key={member.id}>{member.name}：{reading.score === undefined ? reading.description : `${reading.score} / 100 · ${reading.label}；${reading.description}`}</li>;
    })}</ul>}/>
    {groups.some(member => agent.diagnostics?.customPromptGroups?.includes(member.groupId)) && <SettingsRow title="自定义智能提示词" description={<ul className="diagnostics-scopes">{groups.filter(member => agent.diagnostics?.customPromptGroups?.includes(member.groupId)).map(member => <li key={member.id}>{member.name}：{CUSTOM_PROMPT_NOTICE}</li>)}</ul>}/>}
  </>;
}

function BotDiagnostics({agent, snapshot, read, tools, onOpenSetup, onOpenMembership, onError}: {
  agent: Agent; snapshot: DesktopSnapshot; read: SetupRead | undefined; tools: readonly SetupStep[];
  onOpenSetup: () => void; onOpenMembership?: (id: Membership['id']) => void; onError: (message: string) => void;
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
  const toolScopes = toolScopeView(read?.status);
  const toolsGrantUrl = toolScopes?.url;
  const counts = new Map<string, number>();
  for (const member of snapshot.memberships) if (member.agentId === agent.id) counts.set(member.backend, (counts.get(member.backend) ?? 0) + 1);
  const misplaced = snapshot.memberships.filter(member => member.agentId === agent.id && member.directoryProblem);
  const toolText = [...counts].map(([backend, count]) => {
    const step = tools.find(item => item.title === backendLabel(backend));
    return `${backendLabel(backend)}${step ? ` ${step.status}` : ''}（${count} 个群）`;
  }).join('；');
  const steps = read?.status ? botSteps(agent, read.status) : [];
  const pending = steps.filter(step => !step.done);
  const permissionUnknown = read?.status && read.status.scopes.missingRequired === undefined;
  const disabled = !agent.readError && !agent.enabled && !agent.running;
  const summary = agent.readError ? connection.detail ?? '配置读取失败'
    : read?.problem ? `飞书设置读取失败：${read.problem}`
    : disabled ? '已停用，诊断记录仍可查看'
    : !agent.enabled ? connection.detail ?? connection.status
    : connection.tone === 'danger' || connection.tone === 'warning' ? connection.detail ?? connection.status
    : agent.connection === 'reconnecting' ? '正在重新连接飞书'
    : !read?.status ? '正在读取飞书设置…'
    : misplaced.length ? `${misplaced.length} 个群的工作目录需要调整`
    : (agent.diagnostics?.deniedScopes?.length ?? 0) > 0 ? '有权限曾被飞书拒绝，请查看记录'
    : pending.length ? `待完成：${pending.map(step => step.title).join('、')}`
    : permissionUnknown ? '权限状态暂时读不到'
    : setup.warnings.length ? setup.warnings[0]
    : '飞书设置完成 · 权限完整';
  const needsCheck = agent.enabled && (Boolean(read?.problem || agent.readError) || misplaced.length > 0 || (agent.diagnostics?.deniedScopes?.length ?? 0) > 0 || pending.length > 0 || setup.warnings.length > 0 || ['danger','warning'].includes(connection.tone));
  return <details id={settingAnchor(diagnosticsSection(agent.id))} className={`diag-bot ${!agent.enabled ? 'diag-bot--disabled' : ''}`}>
    <summary aria-label={`查看 ${agent.name} 的诊断`}>
      <AgentAvatar agent={agent}/>
      <span className="diag-bot-copy"><span className="diag-bot-name">{agent.name}</span><span className={`diag-bot-note ${needsCheck ? 'diag-bot-note--warning' : ''}`}>{summary}</span></span>
      <span className="diag-bot-meta">{badge(disabled ? '已停用' : connection.status, disabled ? 'neutral' : connection.tone)}{total > 0 && <span className="diag-record-count">{total} 条未回复记录</span>}</span>
      <ChevronDown className="diag-chevron" size={14} aria-hidden="true"/>
    </summary>
    <div className="diag-bot-body"><SettingsGroup label="详细诊断">
    <SettingsRow title="连接" description={connection.detail} trailing={badge(connection.status, connection.tone)}/>
    <SettingsRow title="飞书设置" description={read?.problem && !read.status ? read.problem
      : setup.warnings.length ? <ul className="diagnostics-scopes">{setup.warnings.map(text => <li key={text}>{text}</li>)}</ul> : undefined}
      trailing={<span className="setup-step-trailing">{setup.badge}<Button size="sm" onClick={onOpenSetup}>检查连接</Button></span>}/>
    <SettingsRow title="缺的权限" description={scopes.lines.length ? <ul className="diagnostics-scopes">{scopes.lines}</ul> : undefined}
      trailing={<span className="setup-step-trailing">{scopes.badge}{grantUrl && scopes.lines.length > 0 && <Button size="sm"
        onClick={() => void openExternalUrl(grantUrl, 'app-console', shell).catch(error => onError(error instanceof Error ? error.message : '无法打开开发者后台。'))}>一键开权限</Button>}</span>}/>
    {toolScopes && <SettingsRow title="飞书文档能力" description={toolScopes.lines.length ? <ul className="diagnostics-scopes">{toolScopes.lines}</ul> : undefined}
      trailing={<span className="setup-step-trailing">{toolScopes.badge}{toolsGrantUrl && <Button size="sm"
        onClick={() => void openExternalUrl(toolsGrantUrl, 'app-console', shell).catch(error => onError(error instanceof Error ? error.message : '无法打开开发者后台。'))}>去开通</Button>}</span>}/>}
    <SettingsRow title="Provider" description={toolText || '尚未连接群聊'}/>
    {misplaced.length > 0 && <SettingsRow title="群目录" description={<DirectoryProblems members={misplaced} onOpenMembership={onOpenMembership}/>} trailing={badge(`${misplaced.length} 个群放错了位置`, 'warning')}/>}
    <SmartDiagnostics agent={agent} snapshot={snapshot} now={now}/>
    <SettingsRow title="最近没回的消息" description={<NotRepliedList records={records} agent={agent} snapshot={snapshot} now={now}/>}/>
    {crashes && <SettingsRow title="最近的崩溃" description={<CrashList records={crashes} now={now}/>}/>}
    </SettingsGroup></div>
  </details>;
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

/** 状态与诊断 (product.md 3.1 item 8): the red bar of a crash pause, the shown device's tools (「X」 on a remote one),
 * its decision models' keys (s23g2) and the daemon's crashes, then each bot's connection, setup, scopes, tools, misplaced
 * group directories, recent not-replied messages and crashes, with the daemon log beside the machine details. */
export function DiagnosticsPanel({snapshot, ready, busy, run, onOpenSetup, onOpenProviders, onOpenSecrets, onOpenMembership, onNotice}: {
  snapshot: DesktopSnapshot; ready: boolean; busy: boolean;
  run: (command: Command) => Promise<CommandResult>;
  onOpenSetup: (agentId: AgentId) => void; onOpenProviders: (provider?: SetupProvider) => void; onOpenSecrets: () => void;
  onOpenMembership?: (id: Membership['id']) => void;
  onNotice: (message: string, error: boolean) => void;
}) {
  const client = useClient();
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLDetailsElement>(null);
  function showLog() {
    const section = logRef.current;
    if (!section) return;
    section.open = true;
    setLogOpen(true);
    section.scrollIntoView({block: 'nearest'});
    section.querySelector('summary')?.focus({preventScroll: true});
  }
  const secrets = useSecrets();
  const {reads, recheck} = useSetupStatus(snapshot.agents.map(agent => agent.id), {poll: false});
  const claudeLogin = useClaudeLoginCheck(snapshot.tools, message => onNotice(message, true));
  // The tools are the shown device's: on a remote one each instruction says 「X」 (review 244).
  const where = useActiveDevice();
  const tools = toolStepsOn(where, toolSteps(snapshot.tools, {claudeChecking: claudeLogin.checking}).steps);
  const host = snapshot.host;
  const checking = Object.values(reads).some(read => read?.checking);
  async function recheckAll() {
    // No CLI is started: the snapshot is rebuilt and each bot's Feishu settings are read once more.
    await run({type: 'refresh'});
    await Promise.all([...snapshot.agents.map(agent => recheck(agent.id)), secrets.reader.read()]);
  }
  function act(action: StepAction, provider?: SetupProvider) {
    if (action.kind === 'claudeLogin') void claudeLogin.check(true);
    else onOpenProviders(provider);
  }
  function toolAction(step: SetupStep) {
    const action = step.actions[0];
    if (!action) return null;
    return <Button size="sm" loading={action.kind === 'claudeLogin' && claudeLogin.checking} disabled={busy || !ready} onClick={() => act(action, step.id === 'codex' || step.id === 'claude' ? step.id : undefined)}>{action.label}</Button>;
  }
  const crashes = snapshot.application.crashes;
  return <div className="page-stack diagnostics-page diagnostics-layout">
    <header className="diag-heading today-page-heading" id={settingAnchor('诊断概况')}>
      <div><h1>诊断</h1><p><span data-search-title="daemon 版本">后台 {host.kind === 'connected' ? host.version : '未连接'}</span><span>·</span><span data-search-title="最近读取">最近读取 {snapshot.observedAt ? formatTime(snapshot.observedAt) : '尚未读取'}</span></p></div>
      <div className="diag-heading-actions"><IconButton size="sm" variant="ghost" label="重新检查" title="刷新快照、飞书设置与密钥状态" loading={checking} disabled={busy || !ready} onClick={() => void recheckAll().catch(error => onNotice(error instanceof Error ? error.message : '重新检查没有完成。', true))}><RefreshCw size={16} strokeWidth={1.7} aria-hidden="true"/></IconButton></div>
    </header>
    <CrashBars snapshot={snapshot} ready={ready} busy={busy} run={run}/>
    <SettingsGroup label={whereName(where)} id={settingAnchor('这台电脑')} className="diag-machine"
      footer={diagnosticsToolsFooter(where)}>
      {tools.map(step => <SettingsRow key={step.id} title={step.title} description={stepDescription(step)} trailing={<span className="setup-step-trailing">{badge(step.status, step.tone)}{toolAction(step)}</span>}/>)}
      <KeyDiagnosticsRows read={secrets.read} onOpenSecrets={onOpenSecrets} onShowLog={showLog}/>
      <details className="diag-runtime"><summary>运行详情<ChevronDown size={13} aria-hidden="true"/></summary><div>
        <SettingsRow title="数据目录" value={<code>{snapshot.application.dataPath}</code>}/>
        {crashes && <SettingsRow title="最近的崩溃" description={<CrashList records={crashes.records.filter(record => !record.appId)} now={Date.now()}/>}/>}
      </div></details>
      <details className="diag-log-disclosure" id={settingAnchor('daemon 日志')} ref={logRef} onToggle={event => setLogOpen(event.currentTarget.open)}>
        <summary className="diag-log-disclosure-trigger" data-search-title="后台日志"><span>后台日志</span><ChevronDown size={13} aria-hidden="true"/></summary>
        {logOpen && <LogPanel request={client.machine}/>}
      </details>
    </SettingsGroup>
    <section className="diag-bots" aria-label="Bot 状态"><div className="diag-section-heading"><h2>Bot 状态</h2><span>{snapshot.agents.length} 个 Bot</span></div>
      <div className="diag-bot-list">{!snapshot.agents.length && <p className="diag-empty">尚未添加 Bot。添加后会显示连接状态和诊断记录。</p>}{snapshot.agents.map(agent => <BotDiagnostics key={agent.id} agent={agent} snapshot={snapshot} read={reads[agent.id]} tools={tools} onOpenSetup={() => onOpenSetup(agent.id)} onOpenMembership={onOpenMembership} onError={message => onNotice(message, true)}/>)}</div>
    </section>
  </div>;
}
