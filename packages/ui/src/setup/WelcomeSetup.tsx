import {GlowButton} from '../GlowButton';
import {ArrowRight, QrCode} from 'lucide-react';
import {useState} from 'react';
import {toolSteps, type AgentId} from '@vonvon/protocol';
import {Button} from '../reference/components/ui';
import {BridgeImportPanel} from './BridgeImportPanel';
import {FeishuConnections} from './FeishuConnections';
import {SetupChecklist, type SetupChecklistProps} from './SetupChecklist';
import {ProviderSetup, SetupProgress} from './ProviderSetup';
import {providerIcons, providerNames, providerSignature, type SetupProvider} from './provider-state';
import './welcome-setup.css';

type Props = SetupChecklistProps & {
  onOpenGroups?: () => void;
  onProviderPrepared?: (provider: SetupProvider) => void;
  onCreateBot?: (provider: SetupProvider) => void;
  initialProvider?: SetupProvider;
  initialAgentId?: AgentId;
};
export function WelcomeSetup(props: Props) {
  const hasBots = props.snapshot.agents.length > 0;
  const connected = props.snapshot.memberships.length > 0;
  const [prepared, setPrepared] = useState<{provider: SetupProvider; signature: string}>();
  const selected = prepared?.provider;
  const stillPrepared = Boolean(prepared && prepared.signature === providerSignature(props.snapshot.tools.find(tool => tool.tool === selected)));
  const needsProvider = !connected && (!hasBots ? !stillPrepared : !toolSteps(props.snapshot.tools).ready);
  function next(provider: SetupProvider) {
    setPrepared({provider, signature: providerSignature(props.snapshot.tools.find(tool => tool.tool === provider))});
    props.onProviderPrepared?.(provider);
  }
  // A targeted repair must not become the first-use flow just because no group is bound yet.
  if (props.initialAgentId || (connected && hasBots)) return <FeishuConnections {...props}/>;
  return <div className="welcome-setup">
    {!connected && <BridgeImportPanel ready={props.ready} busy={props.busy} platform={props.snapshot.application.platform}/>}
    {!connected && <SetupProgress step={needsProvider ? 1 : hasBots ? 3 : 2}/>}
    {needsProvider ? <ProviderSetup snapshot={props.snapshot} ready={props.ready} busy={props.busy} run={props.run} initialProvider={props.initialProvider} onContinue={next}/>
      : !hasBots && selected ? <>
        <header className="welcome-setup__intro"><h1>添加你的第一个 Bot</h1></header>
        <div className="welcome-provider-summary"><img src={providerIcons[selected]} alt=""/><span>{providerNames[selected]} 已准备好</span><button type="button" onClick={() => setPrepared(undefined)}>更换</button></div>
        <section className="welcome-setup__connect" aria-label="添加 Bot">
          <span className="welcome-setup__scan-icon"><QrCode size={20} aria-hidden="true"/></span><div className="welcome-setup__connect-copy"><h2>连接飞书 Bot</h2><p>扫码创建新应用或选择已有应用，再完成权限与发布。</p></div>
          <GlowButton disabled={props.busy || !props.ready} onClick={() => props.onCreateBot ? props.onCreateBot(selected) : props.onRegister()}>添加 Bot</GlowButton>
        </section>
      </> : <>
        <header className="welcome-setup__intro"><h1>{connected ? '飞书连接' : '连接到群聊'}</h1><p>{connected ? '管理 Bot 的连接与权限。' : '完成飞书配置，就可以开始对话。'}</p></header>
        <div className="welcome-setup__actions">
          {props.onOpenGroups && <Button variant="primary" disabled={!props.ready || props.busy} onClick={props.onOpenGroups} icon={<ArrowRight size={16} aria-hidden="true"/>}>{connected ? '连接群聊' : '选择群聊'}</Button>}
          <GlowButton disabled={props.busy || !props.ready} onClick={() => props.onRegister()}>添加 Bot</GlowButton>
        </div>
      </>}
    {hasBots && <SetupChecklist {...props} compact botsOnly/>}
  </div>;
}
