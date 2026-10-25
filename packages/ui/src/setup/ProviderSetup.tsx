import {useEffect, useState} from 'react';
import {ArrowRight, Check, ChevronRight, LoaderCircle, RefreshCw, Package, KeyRound} from 'lucide-react';
import type {CollaborationReply, Command, CommandResult, DesktopSnapshot, ToolState} from '@vonvon/protocol';
import {ConfirmDialog} from '../reference/components/ui/Dialog';
import {Button, IconButton} from '../reference/components/ui';
import {useClient, useShellCapabilities} from '../client-context';
import {openExternalUrl} from '../url-actions';
import {settingAnchor} from '../search';
import {preferredProvider, providerBackends, providerIcons, providerInstalled, providerAuthenticated, providerNames, providerSignature, type SetupProvider} from './provider-state';
import {useProviderSetup} from './useProviderSetup';
import './provider-setup.css';

type Props = {snapshot: DesktopSnapshot; ready: boolean; busy: boolean; run: (command: Command) => Promise<CommandResult>; onContinue?: (provider: SetupProvider) => void; initialProvider?: SetupProvider};
export function SetupProgress({step}: {step: 1 | 2 | 3}) {
  return <ol className="provider-progress" aria-label="开始使用">
    {['准备 Provider', '创建 Bot', '连接群'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined} data-complete={step > index + 1 || undefined}>
      <span>{step > index + 1 ? <Check size={11} aria-hidden="true"/> : index + 1}</span>{label}
    </li>)}
  </ol>;
}
export function ProviderSetup(props: Props) {
  const [choice, setChoice] = useState<SetupProvider>();
  const selected = choice ?? props.initialProvider ?? preferredProvider(props.snapshot.tools);
  return <section className="provider-setup" aria-label="准备 Provider">
    <header className="provider-heading"><h1>先准备一个 Provider</h1><p>选择 Codex 或 Claude，即可开始。</p></header>
    <div className="provider-choices" role="group" aria-label="选择 Provider">
      {(['codex', 'claude'] as const).map(id => <button key={id} type="button" className="provider-choice" aria-pressed={selected === id} onClick={() => setChoice(id)}>
        <img src={providerIcons[id]} alt=""/><strong>{providerNames[id]}</strong><span>{id === 'codex' ? 'OpenAI' : 'Anthropic'}</span>
        <span className="provider-choice__mark" aria-hidden="true">{selected === id && <Check size={10}/>}</span>
      </button>)}
    </div>
    <ProviderPreparation key={selected} {...props} provider={selected}/>
  </section>;
}
export function ProviderManager(props: Props & {reveal?: 'codex' | 'claude'}) {
  const [selected, setSelected] = useState<SetupProvider | null>();
  useEffect(() => {if (props.reveal) setSelected(props.reveal);}, [props.reveal]);
  const provider = selected === undefined ? props.reveal : selected;
  if (provider) return <section className={provider === 'codex' ? 'provider-setup provider-detail--compact' : 'provider-setup'} aria-label="Provider" id={settingAnchor(providerNames[provider])}>
    <header className="provider-detail-heading"><img src={providerIcons[provider]} alt=""/><div><nav className="provider-breadcrumb" aria-label="Provider 路径"><button type="button" onClick={() => setSelected(null)}>Provider</button><ChevronRight size={14} aria-hidden="true"/><h1 aria-current="page">{providerNames[provider]}</h1></nav><p>{provider === 'codex' ? 'OpenAI' : 'Anthropic'}</p></div></header>
    <ProviderPreparation key={provider} {...props} provider={provider} management/>
  </section>;
  return <section className="provider-setup" aria-label="Provider" id={settingAnchor('Provider')}>
    <header className="provider-heading"><h1>Provider</h1></header>
    <div className="provider-list">{(['codex', 'claude'] as const).map(id => {
      const tool = props.snapshot.tools.find(item => item.tool === id);
      const status = tool?.installation === 'missing' ? (id === 'claude' ? '缺少运行组件' : '未安装') : !providerInstalled(tool) ? '需要检查' : providerAuthenticated(tool) ? '已就绪' : tool?.authentication === 'signedOut' ? '待连接账号' : '待检查';
      return <div className="provider-list-item" key={id}><button type="button" className="provider-list-row" onClick={() => setSelected(id)}>
        <img src={providerIcons[id]} alt=""/><span><strong>{providerNames[id]}</strong><small>{tool?.version ? `${id === 'claude' ? 'Agent SDK · ' : ''}${tool.version}` : (id === 'codex' ? 'OpenAI' : 'Anthropic')}</small></span><span className="provider-list-status">{status}</span><ChevronRight size={15}/>
      </button><ProviderModelPreview provider={id} tool={tool} ready={props.ready}/></div>;
    })}</div>
  </section>;
}

function ProviderModelPreview({provider, tool, ready}: {provider: SetupProvider; tool?: ToolState; ready: boolean}) {
  const client = useClient();
  const signature = providerSignature(tool);
  const available = ready && providerInstalled(tool) && providerAuthenticated(tool);
  const [retry, setRetry] = useState(0);
  const [catalog, setCatalog] = useState<{signature: string; reply?: Extract<CollaborationReply, {kind: 'providerModels'}>}>();
  useEffect(() => {
    let current = true;
    setCatalog(undefined);
    if (available) void client.collaboration({action: 'providerModels', backend: providerBackends[provider]}).then(reply => {
      if (current) setCatalog({signature, ...(reply.kind === 'providerModels' ? {reply} : {})});
    }).catch(() => {if (current) setCatalog({signature});});
    return () => {current = false;};
  }, [client, provider, available, signature, retry]);
  if (!available) return null;
  const result = catalog?.signature === signature ? catalog : undefined;
  const models = result?.reply?.state === 'ready' ? result.reply.models : undefined;
  return <div className="provider-list-models" aria-label={`${providerNames[provider]} 可用模型`}>
    <span className="provider-list-models__label">可用模型</span>
    {models?.length ? <ul>{models.map(model => <li key={model.id} title={model.id}>{model.displayName || model.id}</li>)}</ul>
      : <span className="provider-list-models__state" role="status">{result ? '暂时无法读取' : '正在读取…'}{result && <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button>}</span>}
  </div>;
}

export function ProviderPreparation({provider, snapshot, ready, busy, run, onContinue, management = false}: Props & {provider: SetupProvider; management?: boolean}) {
  const compact = management && provider === 'codex';
  const state = useProviderSetup(provider, snapshot, ready, run);
  const shell = useShellCapabilities();
  const [linkError, setLinkError] = useState('');
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [cliUninstall, setCliUninstall] = useState(false);
  const [managementNotice, setManagementNotice] = useState('');
  const [versionCheck, setVersionCheck] = useState<{signature: string; installed: string | null; latest: string | null}>();
  const name = providerNames[provider];
  const componentName = provider === 'claude' ? 'Claude Agent SDK' : name;
  const installed = providerInstalled(state.tool);
  const auth = providerAuthenticated(state.tool);
  const detectionUnknown = !state.tool || state.tool.installation === 'unknown';
  const needsUpdate = !detectionUnknown && state.tool?.compatibility?.status === 'tooOld';
  const checking = state.check?.state === 'checking';
  const installing = Boolean(state.activeInstall || state.relevantToolInstall);
  const connecting = Boolean(state.activeLogin || state.activeCodexJob);
  const disabled = !ready || busy || state.working;
  const source = state.tools.find(item => item.tool === provider);
  const versionSignature = JSON.stringify([providerSignature(state.tool), source?.executable, source?.version]);
  useEffect(() => setVersionCheck(undefined), [versionSignature]);
  const checkedVersion = versionCheck?.signature === versionSignature ? versionCheck : undefined;
  const currentVersion = provider === 'codex' && checkedVersion ? checkedVersion.installed
    : detectionUnknown ? null : state.tool?.version?.replace(/^codex-cli\s+/, '') ?? source?.version ?? null;
  const latestVersion = checkedVersion ? checkedVersion.latest : source?.latestVersion;
  const cliLabel = !source ? '正在检测…' : source.installation === 'missing' ? '未检测到' : '已安装';
  const installLabel = installing ? '正在安装…' : installed ? `已安装${currentVersion ? ` · ${currentVersion}` : ''}` : needsUpdate ? '需要更新' : state.tool?.installation === 'missing' ? '未安装' : checking || !state.check && !state.issue ? '正在检测…' : '检测异常';
  const authLabel = connecting ? '等待授权' : detectionUnknown ? '等待检测结果' : !installed ? (needsUpdate ? '更新后连接' : '安装后连接') : state.check?.state === 'checking' ? '正在检查…' : state.tool?.authentication === 'notRequired' ? '使用现有配置' : auth ? '已连接' : state.tool?.authentication === 'signedOut' ? '尚未连接' : '暂时无法确认';
  async function open(url: string, target: 'authorization' | 'verification') {
    setLinkError('');
    try {await openExternalUrl(url, target, shell);} catch {setLinkError('无法打开授权页面，请重试。');}
  }
  async function checkVersion() {
    const reply = await state.request({type: 'backendVersion', id: provider === 'codex' ? 'codex-appserver' : 'claude-agent'});
    if (reply?.kind === 'backendVersion') {
      if (provider === 'codex') setVersionCheck({signature: versionSignature, installed: reply.installed, latest: reply.latest});
      else setManagementNotice(reply.latest ? `验证版本：${reply.latest}` : '暂时无法查询最新版本。');
    }
  }
  async function manageCli(action: 'install' | 'update' | 'uninstall' | 'authStatus') {
    const reply = await (action === 'install' || action === 'update' ? state.installTool('claude', action === 'update') : state.request({type: action, tool: 'claude'}));
    if (reply?.kind === 'applied' || reply?.kind === 'auth') {setManagementNotice(reply.message); setCliUninstall(false); await state.read(); await state.verify();}
  }
  async function uninstall() {
    const reply = await state.request(provider === 'codex' ? {type: 'uninstall', tool: 'codex'} : {type: 'backendUninstall', id: 'claude-agent'});
    if (reply?.kind === 'applied') {setUninstallOpen(false); setManagementNotice(reply.message); await state.read(); await state.verify();}
  }
  return <div className="provider-preparation">
    {provider === 'claude' && <p className="provider-check">Vonvon 通过 Agent SDK 运行 Claude，可复用本机 Claude Code 登录。</p>}
    <div className="provider-steps">
      <div className="provider-step"><span className={`provider-step__number${installed ? ' is-complete' : ''}`}>{compact ? <Package size={16}/> : installed ? <Check size={13}/> : '1'}</span>
        <div className="provider-step__copy"><strong>{compact ? componentName : `${detectionUnknown ? '检测' : '安装'} ${componentName}`}</strong><span>{installLabel}</span></div>
        {installing ? <Button size="sm" disabled={!ready} onClick={() => void state.cancelInstall()}>取消</Button>
          : detectionUnknown ? <Button size="sm" disabled={disabled || checking} onClick={() => void state.verify()}>重新检测</Button>
          : !installed ? <Button size="sm" disabled={disabled} onClick={() => void state.installProvider(needsUpdate)}>{needsUpdate ? (provider === 'claude' ? '更新 SDK' : '更新') : (provider === 'claude' ? '安装 SDK' : '安装')}</Button>
          : compact ? null : <Check size={16} className="provider-ready-icon" aria-label="已安装"/>}
      </div>
      <div className="provider-step"><span className={`provider-step__number${auth && installed ? ' is-complete' : ''}`}>{compact ? <KeyRound size={16}/> : auth && installed ? <Check size={13}/> : '2'}</span>
        <div className="provider-step__copy"><strong>{state.tool?.authentication === 'notRequired' ? '模型连接' : compact ? '账号连接' : '连接账号'}</strong><span>{authLabel}</span></div>
        {detectionUnknown ? null : auth ? (compact ? <IconButton label="重新检测连接" title="重新检测连接" variant="ghost" disabled={disabled || connecting || state.check?.state === 'checking'} onClick={() => void state.verify()}><RefreshCw size={15}/></IconButton> : <Button size="sm" variant="ghost" disabled={disabled || connecting || state.check?.state === 'checking'} onClick={() => void state.verify()}>重新检测</Button>)
          : <Button size="sm" disabled={disabled || !installed || connecting || installing || state.check?.state === 'checking'} onClick={() => void state.connect()}>连接</Button>}
      </div>
    </div>
    {!auth && installed && !connecting && <div className="provider-existing"><span>已有账号或 API 配置？</span><button type="button" disabled={disabled || state.check?.state === 'checking'} onClick={() => void state.verify()}>检测现有配置</button></div>}
    {state.check?.state === 'checking' && installed && auth && <p className="provider-check" role="status"><LoaderCircle size={14} className="provider-spinner"/>正在读取可用模型…</p>}
    {state.canContinue && !compact && <p className="provider-check provider-check--ready" role="status"><Check size={14}/>{name} 已准备好<span>· {state.check?.models?.length ?? 0} 个模型</span></p>}
    {(state.issue || state.check?.message || linkError) && <div className="provider-problem" role="status"><p>{state.issue || state.check?.message || linkError}</p>{!detectionUnknown && <Button size="sm" disabled={disabled || state.check?.state === 'checking'} onClick={() => {void state.read().catch(() => {}); void state.verify();}}>重新检测</Button>}</div>}
    {state.activeCodexJob && <div className="provider-authorization" role="status">
      {state.activeCodexJob.phase === 'authorizing' ? <><p>在 ChatGPT 授权页面输入此代码。</p><code>{state.activeCodexJob.userCode}</code><Button size="sm" disabled={disabled || !state.activeCodexJob.verificationUrl} onClick={() => {if (state.activeCodexJob?.phase === 'authorizing' && state.activeCodexJob.verificationUrl) void open(state.activeCodexJob.verificationUrl, 'authorization');}}>打开授权页面</Button></> : <p>{'message' in state.activeCodexJob ? state.activeCodexJob.message : '正在连接…'}</p>}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => {if(state.activeCodexJob) void run({type:'cancelJob', jobId:state.activeCodexJob.id});}}>取消连接</Button>
    </div>}
    {state.activeLogin && <div className="provider-authorization" role="status"><p>在 Claude 授权页面完成连接。</p>{state.activeLogin.url ? <Button size="sm" onClick={() => {if(state.activeLogin?.url) void open(state.activeLogin.url, 'verification');}}>打开授权页面</Button> : <span>正在打开授权页面…</span>}<Button size="sm" variant="ghost" disabled={disabled} onClick={() => void state.cancelLogin()}>取消连接</Button></div>}
    {provider === 'codex' && !state.activeCodexJob && snapshot.jobs.filter(job => job.type === 'loginCodex').at(-1)?.phase === 'failed' && <p className="provider-problem" role="status">上次连接未完成，可以重新连接。</p>}
    {onContinue && <footer className="provider-footer"><Button variant="primary" disabled={!state.canContinue || busy} icon={<ArrowRight size={15}/>} onClick={() => {if (state.canContinue) onContinue(provider);}}>继续</Button></footer>}
    {management && <>
      {state.check?.state === 'ready' && <details className="provider-models" open><summary><span>可用模型</span><span>{state.check.models?.length ?? 0}</span></summary><div className="provider-models__list">{state.check.models?.map(model => <div key={model.id}><strong title={model.id}>{model.displayName || model.id}</strong></div>)}</div></details>}
      <div className="provider-meta"><h2>{provider === 'claude' ? 'Agent SDK 安装信息' : '安装信息'}</h2><dl><div><dt>安装来源</dt><dd>{detectionUnknown ? checking ? '正在检测…' : '暂时无法确认' : provider === 'claude' ? !state.entry ? '正在检测…' : state.entry.depState === 'installed' ? 'Vonvon 管理' : '未安装' : !source ? '正在检测…' : source.installation === 'managed' ? 'Vonvon 管理' : source?.installation === 'external' ? '本机已有' : '未安装'}</dd></div>{provider === 'codex' && <>
        <div><dt>当前版本</dt><dd>{currentVersion ?? (state.tool?.installation === 'missing' ? '未安装' : '暂时无法确认')}</dd></div>
        <div><dt>最新版本</dt><dd>{latestVersion ?? (!source && !checkedVersion ? '正在检测…' : '暂时无法查询')}</dd></div>
      </>}<div><dt>模型来源</dt><dd>{state.tool?.authentication === 'notRequired' ? '现有 API 配置' : 'Provider 原生配置'}</dd></div></dl>{source?.executable && provider === 'codex' && <details className="provider-install-path"><summary>安装位置</summary><code>{source.executable}</code></details>}
        <div className="provider-management-actions"><Button size="sm" disabled={disabled || installing} onClick={() => void checkVersion()}>检查版本</Button>
          {installed && auth && <Button size="sm" disabled={disabled || connecting || installing} onClick={() => void state.connect()}>重新连接账号</Button>}
          {installed && <Button size="sm" disabled={disabled || installing || connecting} onClick={() => void state.installProvider(true)}>{provider === 'claude' ? '更新 SDK' : `更新 ${name}`}</Button>}
          {(provider === 'codex' ? source?.canUninstall : state.entry?.canUninstall) && <Button size="sm" disabled={disabled || installing || connecting} onClick={() => setUninstallOpen(true)}>{provider === 'claude' ? '卸载 SDK' : '卸载托管副本'}</Button>}
        </div>{managementNotice && <p className="provider-check" role="status">{managementNotice}</p>}
        {provider === 'claude' && <p className="provider-check">更新或重装 SDK 后，请到「应用与启动」重启后台服务，以加载新版本。</p>}
      </div>
      {provider === 'claude' && <details className="provider-cli"><summary>Claude Code · {cliLabel}</summary><p>用于 Claude 账号授权。</p>
        <dl><div><dt>安装来源</dt><dd>{!source ? '正在检测…' : source.installation === 'managed' ? 'Vonvon 管理' : source?.installation === 'external' ? '本机已有' : '未检测到'}</dd></div>{source?.version && <div><dt>当前版本</dt><dd>{source.version}</dd></div>}{source?.executable && <div><dt>安装位置</dt><dd>{source.executable}</dd></div>}{source?.latestVersion && <div><dt>最新版本</dt><dd>{source.latestVersion}</dd></div>}</dl>
        <div className="provider-management-actions"><Button size="sm" disabled={disabled || installing || !source} onClick={() => void manageCli(source?.installation === 'missing' ? 'install' : 'update')}>{source?.installation === 'missing' ? '安装 Claude Code' : '更新 Claude Code'}</Button>
          <Button size="sm" disabled={disabled || source?.installation === 'missing'} onClick={() => void manageCli('authStatus')}>检查授权</Button>
          {source?.canUninstall && <Button size="sm" disabled={disabled || installing} onClick={() => setCliUninstall(true)}>卸载 Claude Code 托管副本</Button>}
        </div>
      </details>}
      <ConfirmDialog open={cliUninstall} title="卸载 Claude Code 托管副本" description="保留 Claude Agent SDK、账号与群设置。" confirmLabel="卸载" tone="danger" pending={state.working} onCancel={() => setCliUninstall(false)} onConfirm={() => void manageCli('uninstall')}/>
      <ConfirmDialog open={uninstallOpen} title={`卸载 ${componentName}${provider === 'codex' ? ' 托管副本' : ''}`} description="保留账号与群设置。本机其他安装不受影响。" confirmLabel="卸载" tone="danger" pending={state.working} onCancel={() => setUninstallOpen(false)} onConfirm={() => void uninstall()}/>
    </>}
  </div>;
}
