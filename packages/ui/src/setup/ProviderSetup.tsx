import {useEffect, useRef, useState} from 'react';
import {ArrowRight, Check, ChevronRight, RefreshCw, Package, KeyRound} from 'lucide-react';
import type {CollaborationReply, Command, CommandResult, DesktopSnapshot, ToolState} from '@vonvon/protocol';
import {backendInstallProgress} from '@vonvon/protocol';
import {ConfirmDialog} from '../reference/components/ui/Dialog';
import {Button, IconButton} from '../reference/components/ui';
import {useActiveDevice, useClient} from '../client-context';
import {configureProvider, onDeviceText, remoteToolsNote, whereName} from '../device-copy';
import {settingAnchor} from '../search';
import {OperationActivity} from '../management/OperationActivity';
import {preferredProvider, providerBackends, providerIcons, providerInstalled, providerAuthenticated, providerNames, providerSignature, type SetupProvider} from './provider-state';
import {useProviderSetup} from './useProviderSetup';
import './provider-setup.css';

type Props = {snapshot: DesktopSnapshot; ready: boolean; busy: boolean; run: (command: Command) => Promise<CommandResult>; onContinue?: (provider: SetupProvider) => void; initialProvider?: SetupProvider};
export function SetupProgress({step}: {step: 1 | 2 | 3}) {
  return <ol className="provider-progress" aria-label="开始使用">
    {['准备 Provider', '添加 Bot', '连接群'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined} data-complete={step > index + 1 || undefined}>
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
  const where = useActiveDevice();
  const remoteNote = where.isRemote && <p className="provider-check" role="note">{remoteToolsNote(where)}</p>;
  const [selected, setSelected] = useState<SetupProvider | null>();
  useEffect(() => {if (props.reveal) setSelected(props.reveal);}, [props.reveal]);
  const provider = selected === undefined ? props.reveal : selected;
  if (provider) return <section className="provider-setup provider-detail--compact" aria-label="Provider" id={settingAnchor(providerNames[provider])}>
    <header className="provider-detail-heading"><img src={providerIcons[provider]} alt=""/><div><nav className="provider-breadcrumb" aria-label="Provider 路径"><button type="button" onClick={() => setSelected(null)}>Provider</button><ChevronRight size={14} aria-hidden="true"/><h1 aria-current="page">{providerNames[provider]}</h1></nav><p>{provider === 'codex' ? 'OpenAI' : 'Anthropic'}</p></div></header>
    {remoteNote}
    <ProviderPreparation key={provider} {...props} provider={provider} management/>
  </section>;
  return <section className="provider-setup" aria-label="Provider" id={settingAnchor('Provider')}>
    <header className="provider-heading"><h1>Provider</h1></header>
    {remoteNote}
    <div className="provider-list">{(['codex', 'claude'] as const).map(id => {
      const tool = props.snapshot.tools.find(item => item.tool === id);
      const status = tool?.installation === 'missing' ? (id === 'claude' ? '缺少运行组件' : '未安装') : !providerInstalled(tool) ? '需要检查' : providerAuthenticated(tool) ? '已就绪' : tool?.authentication === 'signedOut' ? '待配置' : '待检查';
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
  const readRetry = useRef(0);
  const [catalog, setCatalog] = useState<{signature: string; reply?: Extract<CollaborationReply, {kind: 'providerModels'}>; stale?: boolean; refreshing?: boolean}>();
  useEffect(() => {
    let current = true;
    setCatalog(previous => provider === 'codex' && previous?.signature === signature ? {...previous, refreshing: true} : undefined);
    const refresh = retry > readRetry.current;
    readRetry.current = retry;
    if (available) void client.collaboration({action: 'providerModels', backend: providerBackends[provider], ...(refresh ? {refresh: true} : {})}).then(reply => {
      if (current) setCatalog(previous => provider === 'claude'
        ? {signature, ...(reply.kind === 'providerModels' ? {reply} : {})}
        : reply.kind === 'providerModels' && reply.state === 'ready' && reply.models.length
          ? {signature, reply} : {signature, reply: previous?.signature === signature ? previous.reply : undefined, stale: true});
    }).catch(() => {if (current) setCatalog(previous => provider === 'claude' ? {signature} : {signature, reply: previous?.signature === signature ? previous.reply : undefined, stale: true});});
    return () => {current = false;};
  }, [client, provider, available, signature, retry]);
  if (!available) return null;
  const result = catalog?.signature === signature ? catalog : undefined;
  const models = result?.reply?.state === 'ready' ? result.reply.models : undefined;
  return <div className="provider-list-models" aria-label={`${providerNames[provider]} 可用模型`}>
    <span className="provider-list-models__label">可用模型{provider === 'codex' ? result?.refreshing ? ' · 正在刷新…' : result?.stale ? ' · 上次读取，刷新失败' : '' : ''}{provider === 'codex' && <IconButton size="sm" variant="ghost" label="刷新 Codex 模型" title="刷新 Codex 模型" disabled={Boolean(result?.refreshing)} onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}</span>
    {models?.length ? <ul>{models.map(model => <li key={model.id} title={model.id}>{model.displayName || model.id}</li>)}</ul>
      : <span className="provider-list-models__state" role="status">{result ? '暂时无法读取' : '正在读取…'}{result && <IconButton size="sm" variant="ghost" label="重试" title="重新读取可用模型" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}</span>}
  </div>;
}

export function ProviderPreparation({provider, snapshot, ready, busy, run, onContinue, management = false}: Props & {provider: SetupProvider; management?: boolean}) {
  const compact = management;
  const where = useActiveDevice();
  const state = useProviderSetup(provider, snapshot, ready, run);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [cliUninstall, setCliUninstall] = useState(false);
  const [managementNotice, setManagementNotice] = useState('');
  const name = providerNames[provider];
  const componentName = provider === 'claude' ? 'Claude Agent SDK' : name;
  const installed = providerInstalled(state.tool);
  const auth = providerAuthenticated(state.tool);
  const detectionUnknown = !state.tool || state.tool.installation === 'unknown';
  const needsUpdate = !detectionUnknown && state.tool?.compatibility?.status === 'tooOld';
  const checking = state.check?.state === 'checking';
  const installing = Boolean(state.activeInstall || state.relevantToolInstall);
  const connecting = Boolean(state.activeLogin);
  const disabled = !ready || busy || state.working;
  const source = state.tools.find(item => item.tool === provider);
  // A managed copy is on no PATH: the terminal steps name what starts it (0.9.0 Linux acceptance).
  const command = source?.command ?? provider;
  const codexSource = provider === 'codex' ? source : undefined;
  const managedCodex = codexSource?.installation === 'managed' && codexSource.source !== 'explicit';
  const externalCodex = codexSource?.installation === 'external' || codexSource?.source === 'explicit';
  const codexCanInstall = provider !== 'codex' || managedCodex || codexSource?.installation === 'missing' || state.tool?.installation === 'missing' && !externalCodex;
  // The configuration, the install and the fix are the shown device's: 「X」 on a remote one, 本机 here (review 246-2).
  const here = whereName(where);
  const existing = where.isRemote ? `${here}上已有` : '本机已有';
  const codexSourceLabels: Record<string, string> = {app: 'Codex App', npm: 'npm', homebrew: 'Homebrew', standalone: '独立安装', explicit: '显式指定', managed: 'Vonvon 管理', unknown: existing};
  const codexSourceLabel = codexSource?.source === 'explicit' ? '显式指定' : codexSource?.installation === 'managed' ? 'Vonvon 管理' : codexSource?.installation === 'external'
    ? codexSourceLabels[codexSource.source ?? 'unknown'] ?? existing : '未安装';
  const currentVersion = provider === 'codex'
    ? source ? source.version : detectionUnknown ? null : state.tool?.version?.replace(/^codex-cli\s+/, '') ?? null
    : detectionUnknown ? null : state.tool?.version?.replace(/^codex-cli\s+/, '') ?? source?.version ?? null;
  const latestVersion = source?.latestVersion;
  const cliFailed = provider === 'claude' && source?.runtimeStatus === 'failed';
  const cliLabel = !source ? '正在检测…' : source.installation === 'missing' ? '未检测到' : cliFailed ? '无法启动' : source.runtimeStatus === 'unknown' ? '暂时无法确认' : '已安装';
  const installOutput = state.activeInstall?.replay.flatMap(item => item.type === 'log' ? [item.chunk] : []).join('') ?? '';
  const installLabel = installing ? state.activeInstall ? installOutput.includes(backendInstallProgress.verifying) ? '正在校验安装结果…' : installOutput ? '正在下载并安装组件，可能需要几分钟…' : '正在准备安装…' : '正在安装，请稍候…' : installed ? `已安装${currentVersion ? ` · ${currentVersion}` : ''}` : needsUpdate ? '需要更新' : state.tool?.installation === 'missing' ? '未安装' : checking || !state.check && !state.issue ? '正在检测…' : '检测异常';
  const authLabel = detectionUnknown ? '等待检测结果' : !installed ? externalCodex ? '更新后检测' : '安装后检测' : state.check?.state === 'checking' ? '正在检查…' : auth ? where.isRemote ? `已读取${here}上的配置` : '已读取本机配置' : state.tool?.authentication === 'signedOut' ? '未检测到可用配置' : '暂时无法确认';
  async function checkVersion() {
    if (provider === 'codex') {
      const scanned = await state.request({type: 'scan'});
      if (scanned?.kind !== 'tools') setManagementNotice('暂时无法刷新安装信息，请重新检测。');
      else setManagementNotice('');
      return;
    }
    const reply = await state.request({type: 'backendVersion', id: 'claude-agent'});
    if (reply?.kind === 'backendVersion') {
      setManagementNotice(reply.latest ? `验证版本：${reply.latest}` : '暂时无法查询最新版本。');
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
    <div className="provider-steps">
      <div className="provider-step"><span className={`provider-step__number${installed && !installing ? ' is-complete' : ''}`}>{compact ? <Package size={16}/> : installed && !installing ? <Check size={13}/> : '1'}</span>
        <div className="provider-step__copy"><strong>{compact ? componentName : `${detectionUnknown || externalCodex ? '检测' : '安装'} ${componentName}`}</strong>{installing ? <OperationActivity label={installLabel}/> : <span>{installLabel}</span>}</div>
        {installing ? <Button size="sm" disabled={!ready} onClick={() => void state.cancelInstall()}>取消</Button>
          : detectionUnknown ? <IconButton size="sm" variant="ghost" label="重新检测" title="重新检测" disabled={disabled || checking} onClick={() => void state.verify()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>
          : !installed ? codexCanInstall ? <Button size="sm" disabled={disabled} onClick={() => void state.installProvider(needsUpdate)}>{needsUpdate ? (provider === 'claude' ? '更新 SDK' : '更新') : (provider === 'claude' ? '安装 SDK' : '安装')}</Button>
            : <IconButton size="sm" variant="ghost" label="重新检测" title="重新检测" disabled={disabled || checking} onClick={() => void state.verify()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>
          : compact ? null : <Check size={16} className="provider-ready-icon" aria-label="已安装"/>}
      </div>
      <div className="provider-step"><span className={`provider-step__number${auth && installed ? ' is-complete' : ''}`}>{compact ? <KeyRound size={16}/> : auth && installed ? <Check size={13}/> : '2'}</span>
        <div className="provider-step__copy"><strong>{where.isRemote ? `${here}上的配置` : '本机配置'}</strong><span>{authLabel}</span></div>
        {!detectionUnknown && <Button size="sm" disabled={disabled || !installed || installing || state.check?.state === 'checking'} onClick={() => void state.verify()}>{auth ? '重新检测' : '检测配置'}</Button>}
      </div>
    </div>
    {externalCodex && needsUpdate && !management && <p className="provider-check">{onDeviceText(where, codexSource?.updateInstructions || '请通过原安装方式更新 Codex，完成后点「重新检测」。')}</p>}
    <p className="provider-config-guide">{configureProvider(where, provider)}{provider === 'codex' ? <>可以用 Codex App 或 <code>{command}</code> 命令行配置。</> : <>可以用 Claude Code（<code>{command}</code>）配置。</>}</p>
    {cliFailed && <div className="provider-problem" role="status">{where.isRemote
      ? <>{here}上的 Claude Code 无法启动。请先在{here}的终端运行 <code>{command}</code>，修复问题并确认可以使用，再回来重新检测。Vonvon 会复用{here}上 Claude 的认证或 API 配置。</>
      : <>本机 Claude Code 无法启动。请先在终端运行 <code>{command}</code>，修复问题并确认可以使用，再回来重新检测。Vonvon 会复用本机 Claude 的认证或 API 配置。</>}</div>}
    {state.check?.state === 'checking' && installed && auth && <p className="provider-check"><OperationActivity label="正在读取可用模型…" state="connecting"/></p>}
    {state.canContinue && !compact && <p className="provider-check provider-check--ready" role="status"><Check size={14}/>{name} 已准备好<span>· {state.check?.models?.length ?? 0} 个模型</span></p>}
    {!installing && (state.issue || state.check?.message) && <div className="provider-problem" role="status"><p>{onDeviceText(where, state.issue || state.check?.message || '')}</p>{!detectionUnknown && <IconButton size="sm" variant="ghost" label="重新检测" title="重新检测" disabled={disabled || state.check?.state === 'checking'} onClick={() => {void state.read().catch(() => {}); void state.verify();}}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}</div>}
    {onContinue && <footer className="provider-footer"><Button variant="primary" disabled={!state.canContinue || busy} icon={<ArrowRight size={15}/>} onClick={() => {if (state.canContinue) onContinue(provider);}}>继续</Button></footer>}
    {management && <>
      {provider === 'codex' && installed && <div className="provider-models-heading"><span>可用模型{state.check?.stale ? ' · 上次读取' : ''}</span><Button size="sm" disabled={disabled || state.check?.state === 'checking'} onClick={() => void state.verify()}>刷新模型</Button></div>}
      {state.check?.models?.length && (provider === 'codex' || state.check.state === 'ready') ? <details className="provider-models" open><summary><span>可用模型</span><span>{state.check.models.length}</span></summary><div className="provider-models__list">{state.check.models.map(model => <div key={model.id}><strong title={model.id}>{model.displayName || model.id}</strong></div>)}</div></details> : null}
      {provider === 'codex' && state.check?.state === 'unavailable' && state.check.stale && <p className="provider-check" role="status">模型列表是上次读取的结果；本次刷新失败，请稍后重试。</p>}
      <div className="provider-meta"><h2>{provider === 'claude' ? 'Agent SDK 安装信息' : '安装信息'}</h2><dl><div><dt>安装来源</dt><dd>{detectionUnknown ? checking ? '正在检测…' : '暂时无法确认' : provider === 'claude' ? !state.entry ? '正在检测…' : state.entry.depState === 'installed' ? 'Vonvon 管理' : '未安装' : !source ? '正在检测…' : codexSourceLabel}</dd></div>{provider === 'codex' && <>
        <div><dt>当前版本</dt><dd>{currentVersion ?? (state.tool?.installation === 'missing' ? '未安装' : '暂时无法确认')}</dd></div>
        <div><dt>最新版本</dt><dd>{latestVersion ?? (!source ? '正在检测…' : '暂时无法查询')}</dd></div>
        <div><dt>安装位置</dt><dd><code>{source?.executable ?? '暂时无法确认'}</code></dd></div>
      </>}<div><dt>模型来源</dt><dd>{state.tool?.authentication === 'notRequired' ? '现有 API 配置' : 'Provider 原生配置'}</dd></div></dl>
        <div className="provider-management-actions"><Button size="sm" disabled={disabled || installing} onClick={() => void checkVersion()}>检查版本</Button>
          {installed && (provider === 'claude' || managedCodex) && <Button size="sm" disabled={disabled || installing || connecting} onClick={() => void state.installProvider(true)}>{provider === 'claude' ? '更新 SDK' : `更新 ${name}`}</Button>}
          {(provider === 'codex' ? source?.source !== 'explicit' && source?.canUninstall : state.entry?.canUninstall) && <Button size="sm" disabled={disabled || installing || connecting} onClick={() => setUninstallOpen(true)}>{provider === 'claude' ? '卸载 SDK' : '卸载托管副本'}</Button>}
        </div>{managementNotice && <p className="provider-check" role="status">{onDeviceText(where, managementNotice)}</p>}
        {provider === 'codex' && externalCodex && <p className="provider-check">{onDeviceText(where, codexSource?.updateInstructions || '请通过原安装方式更新 Codex，完成后点击「检查版本」和「刷新模型」。')}</p>}
        {managedCodex && installed && <p className="provider-check">正在执行的任务不会中断；完成后，下一轮对话会使用更新的 Codex。</p>}
        {provider === 'claude' && <p className="provider-check">更新或重装 SDK 后，请到「应用与启动」重启后台服务，以加载新版本。</p>}
      </div>
      {provider === 'claude' && <details className="provider-cli"><summary>Claude Code · {cliLabel}</summary><p>在 Claude Code 里配置好账号或自定义 API，Vonvon 用{whereName(where)}上已有的配置。</p>
        <dl><div><dt>安装来源</dt><dd>{!source ? '正在检测…' : source.installation === 'managed' ? 'Vonvon 管理' : source?.installation === 'external' ? existing : '未检测到'}</dd></div>{source?.version && <div><dt>当前版本</dt><dd>{source.version}</dd></div>}{source?.executable && <div><dt>安装位置</dt><dd>{source.executable}</dd></div>}{source?.latestVersion && <div><dt>最新版本</dt><dd>{source.latestVersion}</dd></div>}</dl>
        <div className="provider-management-actions"><Button size="sm" disabled={disabled || installing || !source} onClick={() => void manageCli(source?.installation === 'missing' ? 'install' : 'update')}>{source?.installation === 'missing' ? '安装 Claude Code' : '更新 Claude Code'}</Button>
          <Button size="sm" disabled={disabled || source?.installation === 'missing'} onClick={() => void manageCli('authStatus')}>检查配置</Button>
          {source?.canUninstall && <Button size="sm" disabled={disabled || installing} onClick={() => setCliUninstall(true)}>卸载 Claude Code 托管副本</Button>}
        </div>
      </details>}
      <ConfirmDialog open={cliUninstall} title="卸载 Claude Code 托管副本" description="保留 Claude Agent SDK、账号与群设置。" confirmLabel="卸载" tone="danger" pending={state.working} onCancel={() => setCliUninstall(false)} onConfirm={() => void manageCli('uninstall')}/>
      <ConfirmDialog open={uninstallOpen} title={`卸载 ${componentName}${provider === 'codex' ? ' 托管副本' : ''}`} description={`保留账号与群设置。${where.isRemote ? `${here}上的` : '本机'}其他安装不受影响。`} confirmLabel="卸载" tone="danger" pending={state.working} onCancel={() => setUninstallOpen(false)} onConfirm={() => void uninstall()}/>
    </>}
  </div>;
}
