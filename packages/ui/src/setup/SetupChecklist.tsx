import {useState, type ReactNode} from 'react';
import type {AgentId, Command, CommandResult, DesktopSnapshot} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, StatusBadge} from '../reference/components/ui';
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

export function SetupChecklist({snapshot, ready, busy, run, onRegister, onOpenEnvironment, onNotice, codexJobs}: {
  snapshot: DesktopSnapshot; ready: boolean; busy: boolean;
  run: (command: Command) => Promise<CommandResult>;
  onRegister: (agentId?: AgentId) => void;
  onOpenEnvironment: () => void;
  onNotice: (message: string, error: boolean) => void;
  codexJobs: ReactNode;
}) {
  const client = useClient();
  const shell = useShellCapabilities();
  const {reads, recheck} = useSetupStatus(snapshot.agents.map(agent => agent.id));
  const claudeLogin = useClaudeLoginCheck(snapshot.tools, message => onNotice(message, true));
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
        case 'codexLogin': await run({type: 'startCodexLogin'}); break;
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
        <StatusBadge tone={step.tone} variant="pill">{step.status}</StatusBadge>
        {step.actions.map(action => <Button key={action.kind + action.label} size="sm" variant={action.kind === 'serviceInstall' && action.primary ? 'primary' : undefined}
          loading={working === `${agentId ?? 'tools'}:${action.kind}` || (action.kind === 'claudeLogin' && claudeLogin.checking)}
          disabled={busy || !ready} onClick={() => void act(action, agentId)}>{action.label}</Button>)}
      </span>}/>;
  }
  const tools = toolSteps(snapshot.tools, {claudeChecking: claudeLogin.checking});
  const linux = snapshot.application.platform === 'linux' ? linuxSteps(snapshot.tools) : [];
  return <div className="page-stack setup-checklist">
    <p className="collaboration-footnote">每一步都会自动检测，做完会变成绿色。飞书那边的设置改完后，几秒内这里会跟着变。</p>
    <SettingsGroup label="执行工具" footer="Codex 或 Claude 至少需要一个可用。"
      action={<StatusBadge tone={tools.ready ? 'success' : 'warning'} variant="pill">{tools.ready ? '可以用了' : '还没有可用的工具'}</StatusBadge>}>
      {tools.steps.map((step, index) => stepRow(step, index))}
    </SettingsGroup>
    {codexJobs}
    {/* Only explains what the qa and write modes need here; not counted in 可以用了 or 还差几步 (s20a). */}
    {linux.length ? <SettingsGroup label="Linux 上的权限档">{linux.map((step, index) => stepRow(step, index))}</SettingsGroup> : null}
    <SettingsGroup label="后台运行" footer={SERVICE_FOOTER[snapshot.application.platform]}>
      {stepRow(serviceStep(snapshot.application), 0)}
    </SettingsGroup>
    {snapshot.agents.map(agent => {
      const read = reads[agent.id];
      const steps = botSteps(agent, read?.status, read?.problem);
      const left = steps.filter(step => !step.done).length;
      return <SettingsGroup key={agent.id} label={<>{agent.name} <StatusBadge tone={left ? 'warning' : 'success'}>{left ? `还差 ${left} 步` : '全部完成'}</StatusBadge></>}
        action={<Button size="sm" loading={read?.checking} disabled={!ready} onClick={() => void recheck(agent.id)}>重新检测</Button>}
        footer={<>企业租户里新权限可能要管理员审核。{read?.status && read.problem ? `上次检测失败：${read.problem}` : ''}</>}>
        {steps.map((step, index) => stepRow(step, index, agent.id))}
      </SettingsGroup>;
    })}
    <SettingsGroup label={snapshot.agents.length ? '再注册一个 Bot' : '第一步'}>
      <SettingsRow title="扫码建飞书应用" description="用飞书扫码，自动建好飞书应用并保存凭据。建好后这里会接着检测权限、事件和发布。"
        trailing={<Button size="sm" variant={snapshot.agents.length ? 'secondary' : 'primary'} disabled={busy || !ready} onClick={() => onRegister()}>注册 Bot</Button>}/>
    </SettingsGroup>
  </div>;
}
