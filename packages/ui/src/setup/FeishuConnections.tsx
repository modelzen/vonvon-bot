import {GlowButton} from '../GlowButton';
import {useState} from 'react';
import {ArrowRight, ArrowUpRight, Check, RefreshCw} from 'lucide-react';
import {botSteps, type Agent, type AgentId, type StepAction} from '@vonvon/protocol';
import {AgentAvatar} from '../AgentAvatar';
import {Button, IconButton, StatusBadge} from '../reference/components/ui';
import {useClient, useShellCapabilities} from '../client-context';
import {openExternalUrl} from '../url-actions';
import {PrivateChatButton} from './PrivateChatButton';
import {stepDescription, type SetupChecklistProps} from './SetupChecklist';
import {useSetupStatus, type SetupRead} from './useSetupStatus';
import './feishu-connections.css';

type Props = SetupChecklistProps & {onOpenGroups?: () => void; initialAgentId?: AgentId};

function botSummary(agent: Agent, read: SetupRead | undefined): string {
  if (!agent.enabled) return '未启用';
  if (read?.problem) return read.status ? '结果待更新' : '检测失败';
  if (!read?.status) return '正在检测…';
  const left = botSteps(agent, read.status).filter(step => !step.done).length;
  return left ? `待完成 ${left} 项` : '配置已完成';
}

/** Existing bindings use the compact management view; first-time setup keeps its checklist. */
export function FeishuConnections({snapshot, ready, busy, run, onRegister, onOpenGroups, onNotice, initialAgentId}: Props) {
  const {reads, recheck} = useSetupStatus(snapshot.agents.map(agent => agent.id));
  const [selected, setSelected] = useState<AgentId | undefined>(initialAgentId ?? snapshot.agents[0]?.id);
  const [working, setWorking] = useState<string>();
  const client = useClient();
  const shell = useShellCapabilities();
  const agent = selected ? snapshot.agents.find(agent => agent.id === selected) : snapshot.agents[0];
  const read = agent ? reads[agent.id] : undefined;
  const credentialsRejected = read?.status?.credentials.ok === false && !read.status.credentials.unreachable;
  const steps = (agent ? botSteps(agent, read?.status, read?.problem) : []).map(step =>
    credentialsRejected && step.id === 'callback' && !step.done
      ? {...step, status: '等待凭据恢复', tone: 'neutral' as const, detail: '先完成飞书应用的重新扫码，再检测卡片回调配置。', actions: []}
      : step);

  async function act(action: StepAction, agentId: AgentId) {
    const key = `${agentId}:${action.kind}`;
    setWorking(key);
    try {
      switch (action.kind) {
        case 'reauthorize': onRegister(agentId); break;
        case 'open': await openExternalUrl(action.url, action.target, shell); break;
        case 'enable': await run({type: 'setAgentEnabled', agentId, enabled: true}); break;
        case 'confirmCallback':
          await client.admin({type: 'confirmCardCallback', agentId, confirmed: action.confirmed});
          await recheck(agentId);
          break;
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '操作没有完成，请重试。', true);
    } finally {
      setWorking(current => current === key ? undefined : current);
    }
  }

  return <section className="welcome-setup feishu-connections" aria-label="飞书连接">
    <div className="feishu-connections__sticky">
      <header className="feishu-connections__heading">
        <div className="welcome-setup__intro"><h1>飞书连接</h1><p>管理 Bot 的连接与权限。</p></div>
        <div className="welcome-setup__actions">
          <GlowButton disabled={!ready || busy} onClick={() => onRegister()}>添加 Bot</GlowButton>
          {agent && <PrivateChatButton agent={agent} status={read?.status} onNotice={onNotice}/>}
          {onOpenGroups && <Button size="sm" variant="primary" disabled={!ready || busy} onClick={onOpenGroups}
            icon={<ArrowRight size={15} aria-hidden="true"/>}>连接群聊</Button>}
        </div>
      </header>
      <div className="feishu-connections__bots" role="group" aria-label="选择 Bot">
        {snapshot.agents.map(bot => <button key={bot.id} type="button"
          className={`feishu-connections__bot${!bot.enabled ? ' is-disabled' : ''}`}
          aria-pressed={bot.id === agent?.id} title={bot.name} onClick={() => setSelected(bot.id)}>
          <AgentAvatar agent={bot}/>
          <span className="feishu-connections__bot-copy"><strong>{bot.name}</strong><small>{botSummary(bot, reads[bot.id])}</small></span>
        </button>)}
      </div>
    </div>
    {agent ? <section className="feishu-connections__checks" aria-label={`${agent.name} 的配置检查`}>
      <div className="feishu-connections__checks-heading">
        <div className="feishu-connections__checks-title">
          <h2>配置检查</h2>
          <span className="feishu-connections__count">{read?.problem ? '检测结果待更新' : read?.status
            ? `已完成 ${steps.filter(step => step.done).length} / ${steps.length}` : '正在读取飞书配置…'}</span>
        </div>
        <div className="feishu-connections__check-actions">
          <IconButton size="sm" variant="ghost" label="重新检测" title="重新检测" loading={read?.checking}
            disabled={!ready} onClick={() => void recheck(agent.id)}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>
        </div>
      </div>
      {read?.status && read.problem && <p role="status" className="feishu-connections__stale">上次检测失败：{read.problem}</p>}
      <ol className="feishu-connections__steps" key={agent.id}>
        {steps.map((step, index) => {
          const detailed = Boolean(step.detail || step.items?.length || step.warnings?.length || step.commands?.length);
          const needsAttention = !step.done || Boolean(step.items?.length || step.warnings?.length)
            || (step.id === 'callback' && read?.status?.cardCallback.configuration?.state === 'unchecked');
          const blockedByCredentials = credentialsRejected && ['scopes', 'event', 'callback', 'publish'].includes(step.id);
          const actions = (needsAttention && !blockedByCredentials ? step.actions : []).map(action => <Button key={action.kind + action.label} size="sm"
            variant={action.kind === 'confirmCallback' && action.confirmed ? 'primary' : undefined}
            aria-label={action.label} title={action.label}
            disabled={!ready || busy} loading={working === `${agent.id}:${action.kind}`}
            onClick={() => void act(action, agent.id)}>
            {action.kind === 'open' && action.target === 'event-settings' ? '配置' : action.label}
            {action.kind === 'open' && <ArrowUpRight size={12} strokeWidth={1.7} aria-hidden="true"/>}
          </Button>);
          return <li className={`feishu-connections__step${!step.done ? ' is-pending' : ''}${actions.length ? ' has-actions' : ''}`} key={step.id}>
            <span className={`feishu-connections__number${step.done ? ' is-done' : ''}`} aria-hidden="true">
              {step.done ? <Check size={12} strokeWidth={2}/> : index + 1}
            </span>
            <div className="feishu-connections__step-content">
              <div className="feishu-connections__step-heading">
                <h3>{step.title}</h3>
                <div className="feishu-connections__step-result">
                  <StatusBadge tone={step.tone}>{step.status}</StatusBadge>
                  {actions.length > 0 && <div className="feishu-connections__inline-actions">{actions}</div>}
                </div>
              </div>
              {detailed && <div className="feishu-connections__description">{stepDescription(step)}</div>}
            </div>
          </li>;
        })}
      </ol>
    </section> : <p role="status">所选 Bot 暂不可用。请等待列表更新，或在上方选择其他 Bot。</p>}
    <p className="feishu-connections__footnote">企业租户里新权限可能要管理员审核。</p>
  </section>;
}
