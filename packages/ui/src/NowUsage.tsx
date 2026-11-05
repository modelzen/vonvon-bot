import {useEffect, useRef, useState} from 'react';
import {Tabs} from '@base-ui/react/tabs';
import type {VonvonClient} from '@vonvon/client/browser';
import type {BackendAccount} from '@vonvon/protocol';
import {useClient} from './client-context';
import {UsageAccount, UsageProfile} from './management/UsageContent';
import {readUsage, type Usage} from './management/usage-data';
import {JudgeUsageGroup} from './management/JudgeUsage';
import './now-usage.css';

type ReaderClient = Pick<VonvonClient, 'environment' | 'collaboration'>;
export type NowProvider = {id: string; name: string; account: BackendAccount; data?: Usage; loading?: boolean; problem?: string};
type ProviderUpdate = {kind: 'provider'; provider: NowProvider} | {kind: 'remove'; id: string} | {kind: 'failed'; id: string; problem: string};

/** Catalog is discovery only. Login evidence, not installation, admits an account. */
export async function readNowProviders(client: ReaderClient, publish: (update: ProviderUpdate) => void): Promise<string[]> {
  const catalog = await client.environment({type: 'backendCatalog'});
  if (catalog.kind !== 'backends') throw new Error('暂时无法读取 Provider。');
  await Promise.all(catalog.entries.map(async entry => {
    if (entry.depState !== 'installed') {publish({kind: 'remove', id: entry.id}); return;}
    try {
      const login = await client.environment({type: 'backendLogin', id: entry.id, refresh: false});
      if (login.kind !== 'backendLogin' || login.id !== entry.id) throw new Error('账户状态暂无法确认。');
      if (login.state === 'signedOut') {publish({kind: 'remove', id: entry.id}); return;}
      const configuredApi = login.state === 'unknown' && login.account?.kind === 'api' && !!login.account.apiProvider;
      if (login.state !== 'signedIn' && login.state !== 'notRequired' && !configuredApi) throw new Error('账户状态暂无法确认。');
      const account = login.account ?? {kind: 'unknown' as const};
      const provider: NowProvider = {id: entry.id, name: entry.displayName, account, ...(configuredApi ? {problem: '账户状态暂无法确认。'} : {})};
      const readsUsage = (entry.id === 'codex-appserver' || entry.id === 'claude-agent') && account.kind !== 'api';
      publish({kind: 'provider', provider: {...provider, loading: readsUsage}});
      if (!readsUsage) return;
      try {
        const data = await readUsage(request => client.collaboration(request), false, entry.id === 'claude-agent' ? 'claude-agent' : undefined);
        publish({kind: 'provider', provider: {...provider, data}});
      } catch (error) {
        publish({kind: 'provider', provider: {...provider, problem: error instanceof Error ? error.message : '暂无法刷新额度与用量。'}});
      }
    } catch {
      publish({kind: 'failed', id: entry.id, problem: `${entry.displayName} 账户状态暂无法确认。`});
    }
  }));
  return catalog.entries.map(entry => entry.id);
}

export function mergeNowProvider(previous: NowProvider[], update: ProviderUpdate): NowProvider[] {
  const old = previous.find(provider => provider.id === (update.kind === 'provider' ? update.provider.id : update.id));
  if (update.kind === 'remove') return previous.filter(provider => provider.id !== update.id);
  if (update.kind === 'failed') return previous.map(provider => provider.id === update.id ? {...provider, loading: false, problem: update.problem} : provider);
  const next = update.provider;
  // Keep a failed read as explicitly old data; never carry quota across an auth-mode change.
  const sameAccount = old && JSON.stringify(old.account) === JSON.stringify(next.account);
  const merged = sameAccount && !next.data && (next.loading || next.problem) ? {...next, data: old.data, problem: next.problem ?? (next.loading ? old.problem : undefined)} : next;
  return old ? previous.map(provider => provider.id === next.id ? merged : provider) : [...previous, merged];
}

export function nowAccountLabel(account: BackendAccount): string {
  const plans: Record<string, string> = {go: 'ChatGPT Go', plus: 'ChatGPT Plus', pro: 'Pro', prolite: 'Pro Lite', max: 'Max', claude_ultra: 'Claude Ultra', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu'};
  if (account.kind === 'free') return '免费账户';
  if (account.kind === 'api') return 'API 接入';
  if (account.kind === 'subscription') return account.planType ? plans[account.planType] ?? account.planType : '订阅账户';
  if (account.planType === 'self_serve_business_usage_based' || account.planType === 'enterprise_cbp_usage_based') return '按用量计费';
  return '账户类型未知';
}

/** Poll only while this page is connected and visible; login probes retain daemon TTLs. */
export function NowUsage({disabled = false, onOpenUsage}: {disabled?: boolean; onOpenUsage: () => void}) {
  const client = useClient();
  const clientRef = useRef(client);
  const [providers, setProviders] = useState<NowProvider[]>([]);
  const [selected, setSelected] = useState('');
  const [pointerMotion, setPointerMotion] = useState(false);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  useEffect(() => {
    let active = true, running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (clientRef.current !== client) {clientRef.current = client; setProviders([]); setSelected(''); setLoading(true); setProblem(''); setCatalogUnavailable(false);}
    if (disabled) return;
    const refresh = async () => {
      if (!active || running || document.hidden) return;
      running = true;
      let partialProblem = '';
      try {
        const ids = await readNowProviders(client, update => {
          if (!active) return;
          if (update.kind === 'failed') partialProblem = '部分 Provider 的账户状态暂无法确认。';
          setProviders(previous => mergeNowProvider(previous, update));
        });
        if (active) {setProviders(previous => previous.filter(provider => ids.includes(provider.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))); setProblem(partialProblem); setCatalogUnavailable(false);}
      } catch {if (active) {setProblem('暂时无法刷新 Provider。'); setCatalogUnavailable(true);}}
      finally {
        running = false;
        if (active) {setLoading(false); timer = setTimeout(() => void refresh(), 60_000);}
      }
    };
    const visible = () => {if (!document.hidden) {clearTimeout(timer); void refresh();}};
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => {active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visible);};
  }, [client, disabled]);
  const provider = providers.find(item => item.id === selected) ?? providers[0];
  const active = selected === 'jev' ? 'jev' : provider?.id ?? (loading ? '' : 'jev');
  return <Tabs.Root render={<section/>} className="today-home-section now-usage" aria-label="用量" value={active} onValueChange={value => setSelected(String(value))}
    data-pointer-motion={pointerMotion} onPointerDownCapture={event => setPointerMotion(event.pointerType === 'mouse')} onKeyDownCapture={() => setPointerMotion(false)}>
    <header><h2>用量</h2><Tabs.List className="now-provider-tabs" aria-label="选择 Provider" activateOnFocus>
      {providers.map(item => <Tabs.Tab key={item.id} value={item.id} className="now-provider-tab">
        {(item.id === 'codex-appserver' || item.id === 'claude-agent') && <img src={item.id === 'codex-appserver' ? './agent-icons/codex-light.png' : './agent-icons/claude-code.svg'} alt=""/>}{item.name}
      </Tabs.Tab>)}
      <Tabs.Tab value="jev" className="now-provider-tab">Jev</Tabs.Tab>
      <Tabs.Indicator className="now-provider-indicator"/>
    </Tabs.List><button type="button" className="now-usage-details-link" onClick={onOpenUsage}>查看详情<span aria-hidden="true">›</span></button></header>
    {!active && <p className="now-usage-empty">{disabled ? '连接恢复后更新用量。' : '正在读取 Provider…'}</p>}
    {provider && providers.map(item => <Tabs.Panel className="now-usage-panel" value={item.id} key={item.id}>
      {item.id === active && <NowUsageBody provider={item} stale={disabled || catalogUnavailable}/>}
    </Tabs.Panel>)}
    <Tabs.Panel className="now-usage-panel now-jev-panel" value="jev">
      {active === 'jev' && <JudgeUsageGroup dailySource={{kind: 'decision'}} disabled={disabled} refreshInterval={60_000}/>}
    </Tabs.Panel>
    {active !== 'jev' && problem && !provider?.problem && <p className="now-usage-notice" role="status">{problem}</p>}
  </Tabs.Root>;
}

export function NowUsageBody({provider, stale = false}: {provider: NowProvider; stale?: boolean}) {
  const data = provider.data;
  return <div className="now-usage-content" data-has-usage={!!data} data-stale={stale || !!provider.problem}>
    {data ? <>
      <UsageAccount data={data} provider={provider.name}/>
      <UsageProfile profile={data.profile} provider={provider.name} showDetails={false}/>
    </> : <div className="usage-account"><header className="usage-account-heading"><div className="usage-account-identity"><strong>{provider.name}</strong><span>{nowAccountLabel(provider.account)}</span></div></header><p className="now-usage-empty">{provider.loading ? '正在读取用量…' : provider.problem || (provider.account.kind === 'api' ? 'API 接入暂无法读取额度与每日用量。' : provider.account.kind === 'unknown' ? '暂无账户类型与用量信息。' : '暂无法读取额度与每日用量。')}</p></div>}
    {data && (provider.problem || stale) && <p className="now-usage-notice" role="status">{provider.problem ? '暂无法更新，显示上次读取的数据。' : '连接恢复后更新，当前为上次读取的数据。'}</p>}
  </div>;
}
