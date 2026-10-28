import {GlowButton} from '../GlowButton';
import {RefreshCw} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import type {AgentId, Command, CommandResult, DesktopSnapshot} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, IconButton, StatusBadge} from '../reference/components/ui';
import {openExternalUrl} from '../url-actions';
import {botSteps, linuxSteps, serviceStep, toolSteps, type SetupStep, type StepAction} from '@vonvon/protocol';
import {skipService, toggleService} from './service-toggle';
import {useSetupStatus} from './useSetupStatus';
import {useClaudeLoginCheck} from './useClaudeLoginCheck';
import './setup.css';

const SERVICE_FOOTER: Partial<Record<DesktopSnapshot['application']['platform'], string>> = {
  macos: '装成 macOS 的后台服务（LaunchAgent）。',
  linux: 'systemd 用户服务。退出 SSH 后也要在线，安装时打开 linger。',
};

/** A step's detail, its items as code chips, its warnings and its commands; undefined when it has none, so the row stays plain. */
export function stepDescription({detail, items, warnings, commands}: Pick<SetupStep, 'detail' | 'items' | 'warnings' | 'commands'>): ReactNode {
  if (!detail && !items?.length && !warnings?.length && !commands?.length) return undefined;
  return <>
    {detail}
    {items?.length ? <span className="setup-step-items">{items.map(item => <code key={item}>{item}</code>)}</span> : null}
    {warnings?.map(warning => <span key={warning} className="setup-step-warning">{warning}</span>)}
    {commands?.length ? <pre className="setup-step-commands">{commands.join('\n')}</pre> : null}
  </>;
}

export type SetupChecklistProps = {
  snapshot: DesktopSnapshot; ready: boolean; busy: boolean;
  run: (command: Command) => Promise<CommandResult>;
  onRegister: (agentId?: AgentId) => void;
  onOpenEnvironment: () => void;
  onNotice: (message: string, error: boolean) => void;
  codexJobs: ReactNode;
  compact?: boolean;
  botsOnly?: boolean;
};

export function SetupChecklist({snapshot, ready, busy, run, onRegister, onOpenEnvironment, onNotice, codexJobs, compact = false, botsOnly = false}: SetupChecklistProps) {
  const client = useClient();
  const shell = useShellCapabilities();
  const {reads, recheck} = useSetupStatus(snapshot.agents.map(agent => agent.id));
  const claudeLogin = useClaudeLoginCheck(botsOnly ? [] : snapshot.tools, message => onNotice(message, true));
  const [working, setWorking] = useState<string>();
  async function act(action: StepAction, agentId?: AgentId) {
    const key = `${agentId ?? 'tools'}:${action.kind}`;
    setWorking(key);
    try {
      switch (action.kind) {
        case 'reauthorize': onRegister(agentId); break;
        case 'open': await openExternalUrl(action.url, action.target, shell); break;
        case 'enable': if (agentId) await run({type: 'setAgentEnabled', agentId, enabled: true}); break;
        case 'confirmCallback':
          if (agentId) { await client.admin({type: 'confirmCardCallback', agentId, confirmed: action.confirmed}); await recheck(agentId); }
          break;
        case 'environment': onOpenEnvironment(); break;
        case 'codexLogin': onOpenEnvironment(); break;
        case 'claudeLogin': await claudeLogin.check(true); break;
        // Installing from the web page drops the connection for a few seconds; the snapshot shows the result.
        case 'serviceInstall': onNotice(await toggleService(true, client, shell), false); break;
        case 'serviceSkip': onNotice(await skipService(client), false); break;
        // The daemon feeds this read into the snapshot, so the step follows it.
        case 'serviceRecheck': await client.machine({type: 'status'}); break;
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '操作没有完成，请重试。', true);
    } finally {
      setWorking(current => current === key ? undefined : current);
    }
  }
  function stepRow(step: SetupStep, index: number, agentId?: AgentId) {
    return <SettingsRow key={step.id} title={`${index + 1}. ${step.title}`}
      description={stepDescription(step)}
      trailing={<span className="setup-step-trailing">
        <StatusBadge tone={step.tone}>{step.status}</StatusBadge>
        {step.actions.map(action => action.kind === 'serviceRecheck'
          ? <IconButton key={action.kind + action.label} size="sm" variant="ghost" label={action.label} title={action.label}
            loading={working === `${agentId ?? 'tools'}:${action.kind}`} disabled={busy || !ready} onClick={() => void act(action, agentId)}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>
          : <Button key={action.kind + action.label} size="sm" variant={action.kind === 'serviceInstall' && action.primary ? 'primary' : undefined}
          loading={working === `${agentId ?? 'tools'}:${action.kind}` || (action.kind === 'claudeLogin' && claudeLogin.checking)}
          disabled={busy || !ready} onClick={() => void act(action, agentId)}>{action.label}</Button>)}
      </span>}/>;
  }
  const tools = toolSteps(snapshot.tools, {claudeChecking: claudeLogin.checking});
  const linux = snapshot.application.platform === 'linux' ? linuxSteps(snapshot.tools) : [];
  const toolContent = <>
    <SettingsGroup label={compact ? '模型工具' : '后端'} footer="Codex 或 Claude 至少需要一个可用。"
      action={<StatusBadge tone={tools.ready ? 'success' : 'warning'} variant="pill">{tools.ready ? '可以用了' : compact ? '需要准备' : '还没有能用的后端'}</StatusBadge>}>
      {tools.steps.map((step, index) => stepRow(step, index))}
    </SettingsGroup>
    {codexJobs}
    {linux.length ? <SettingsGroup label="Linux 上的权限">{linux.map((step, index) => stepRow(step, index))}</SettingsGroup> : null}
    <SettingsGroup label="后台运行" footer={SERVICE_FOOTER[snapshot.application.platform]}>
      {stepRow(serviceStep(snapshot.application), 0)}
    </SettingsGroup>
  </>;
  return <div className="page-stack setup-checklist">
    {!compact && <p className="collaboration-footnote">自动检测飞书配置。完成卡片回调后，请手动确认。</p>}
    {!compact && !botsOnly && toolContent}
    {snapshot.agents.map(agent => {
      const read = reads[agent.id];
      const steps = botSteps(agent, read?.status, read?.problem);
      const left = steps.filter(step => !step.done).length;
      return <SettingsGroup key={agent.id} label={<>{agent.name} <StatusBadge tone={left ? 'warning' : 'success'}>{left ? `还差 ${left} 步` : '全部完成'}</StatusBadge></>}
        action={<IconButton size="sm" variant="ghost" label="重新检测" title="重新检测" loading={read?.checking} disabled={!ready} onClick={() => void recheck(agent.id)}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}
        footer={<>企业租户里新权限可能要管理员审核。{read?.status && read.problem ? `上次检测失败：${read.problem}` : ''}</>}>
        {steps.map((step, index) => stepRow(step, index, agent.id))}
      </SettingsGroup>;
    })}
    {compact && !botsOnly && <details className="welcome-setup__tools" open={snapshot.agents.length > 0 ? true : undefined}>
      <summary><span>工具与后台运行</span><StatusBadge tone={tools.ready ? 'success' : 'neutral'}>{tools.ready ? '模型工具已就绪' : 'Codex、Claude 与自动运行'}</StatusBadge></summary>
      <div>{toolContent}</div>
    </details>}
    {!compact && !botsOnly && <SettingsGroup label={snapshot.agents.length ? '再注册一个 Bot' : '第一步'}>
      <SettingsRow title="扫码连接飞书应用" description="用飞书扫码，创建新应用或选择已有应用并保存凭据。连接后这里会接着检测权限、事件和发布。"
        trailing={<GlowButton disabled={busy || !ready} onClick={() => onRegister()}>添加 Bot</GlowButton>}/>
    </SettingsGroup>}
  </div>;
}
