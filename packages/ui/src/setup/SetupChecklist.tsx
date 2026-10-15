import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {AgentId, Command, CommandResult, DesktopSnapshot} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, StatusBadge} from '../reference/components/ui';
import {openExternalUrl} from '../url-actions';
import {botSteps, toolSteps, type SetupStep, type StepAction} from './setupPresentation';
import {useSetupStatus} from './useSetupStatus';
import './setup.css';

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
  // A count, not a flag: the automatic check and a click can overlap.
  const [claudeChecks, setClaudeChecks] = useState(0);
  const [working, setWorking] = useState<string>();
  const claude = snapshot.tools.find(tool => tool.tool === 'claude');
  const askedClaude = useRef(false);
  async function checkClaude(refresh: boolean) {
    setClaudeChecks(count => count + 1);
    // The daemon refreshes the snapshot's tools after this reply, so the row follows it.
    try { await client.environment({type: 'backendLogin', id: 'claude-agent', refresh}); }
    catch (error) { onNotice(error instanceof Error ? error.message : '暂时无法检查 Claude 登录。', true); }
    finally { setClaudeChecks(count => count - 1); }
  }
  useEffect(() => {
    // The snapshot only carries a cached login; ask once so a fresh window has an answer.
    if (askedClaude.current || claude?.installation !== 'installed' || claude.authentication !== 'unknown') return;
    askedClaude.current = true;
    void checkClaude(false);
  }, [claude?.installation, claude?.authentication]);
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
        case 'claudeLogin': await checkClaude(true); break;
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '操作没有完成，请重试。', true);
    } finally {
      setWorking(current => current === key ? undefined : current);
    }
  }
  function stepRow(step: SetupStep, index: number, agentId?: AgentId) {
    return <SettingsRow key={step.id} title={`${index + 1}. ${step.title}`}
      description={step.detail || step.items?.length || step.warnings?.length ? <>
        {step.detail}
        {step.items?.length ? <span className="setup-step-items">{step.items.map(item => <code key={item}>{item}</code>)}</span> : null}
        {step.warnings?.map(warning => <span key={warning} className="setup-step-warning">{warning}</span>)}
      </> : undefined}
      trailing={<span className="setup-step-trailing">
        <StatusBadge tone={step.tone} variant="pill">{step.status}</StatusBadge>
        {step.actions.map(action => <Button key={action.kind + action.label} size="sm"
          loading={working === `${agentId ?? 'tools'}:${action.kind}` || (action.kind === 'claudeLogin' && claudeChecks > 0)}
          disabled={busy || !ready} onClick={() => void act(action, agentId)}>{action.label}</Button>)}
      </span>}/>;
  }
  const tools = toolSteps(snapshot.tools);
  return <div className="page-stack setup-checklist">
    <p className="collaboration-footnote">每一步都会自动检测，做完会变成绿色。飞书那边的设置改完后，几秒内这里会跟着变。</p>
    <SettingsGroup label="执行工具" footer="Codex 或 Claude 至少需要一个可用。"
      action={<StatusBadge tone={tools.ready ? 'success' : 'warning'} variant="pill">{tools.ready ? '可以用了' : '还没有可用的工具'}</StatusBadge>}>
      {tools.steps.map((step, index) => stepRow(step, index))}
    </SettingsGroup>
    {codexJobs}
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
