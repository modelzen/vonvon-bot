import {useCallback, useEffect, useRef, useState} from 'react';
import type {CollaborationReply, HostSettingsView, SecretService, SettingsReply} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, InlineNotice, SelectControl} from '../reference/components/ui';
import {Editor} from '../settings/SettingsPanel';

type Configuration = NonNullable<HostSettingsView['sections']['judge']>['stored'];
type Profile = Configuration['byProvider'][string];
type Catalog = Extract<CollaborationReply, {kind: 'providerModels'}>;
type Catalogs = Partial<Record<string, Catalog>>;
const nativeProviders = [{id: 'codex-appserver', name: 'Codex'}, {id: 'claude-agent', name: 'Claude'}] as const;
const customEfforts: Record<string, NonNullable<Profile['effort']>[]> = {
  'codex-appserver': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'claude-agent': ['low', 'medium', 'high', 'max'],
};

/** Each group stores only a Provider reference; these machine-wide profiles supply its next judgement. */
export function DecisionProviderFields({value, defaults, catalogs, services, disabled, onChange, onOpenProviders}: {
  value: Configuration; defaults: Configuration; catalogs: Catalogs; services?: SecretService[]; disabled: boolean;
  onChange: (value: Configuration) => void; onOpenProviders?: () => void;
}) {
  const providers = [...nativeProviders, {id: 'typesafe', name: 'TypeSafe · Jev'}];
  return <>
    <p className="decision-config-note">每个 Provider 配置一份模型与 Effort。群里选择决策 Provider 后，使用这里的统一配置。</p>
    {providers.map(provider => {
      const profile = value.byProvider[provider.id] ?? defaults.byProvider[provider.id];
      if (!profile) return null;
      const native = provider.id !== 'typesafe';
      const catalog = catalogs[provider.id];
      const models = native ? catalog?.models.filter(model => !model.hidden) ?? []
        : services?.find(service => service.provider === provider.id)?.models ?? [{id: 'jev-latest', displayName: 'Jev'}];
      const selected = models.find(model => model.id === profile.model);
      const efforts = native ? profile.custom ? customEfforts[provider.id] ?? [] : catalog?.models.find(model => model.id === profile.model)?.supportedEfforts ?? [] : [];
      const update = (next: Profile) => onChange({byProvider: {...value.byProvider, [provider.id]: next}});
      return <section className="decision-provider-config" aria-label={`${provider.name} 决策配置`} key={provider.id}>
        <div className="decision-provider-heading"><h3>{provider.name}</h3>
        </div>
        <SettingsRow title="模型" trailing={profile.custom
          ? <input className="settings-field" aria-label={`${provider.name} 决策模型 ID`} value={profile.model} disabled={disabled} placeholder="模型 ID" onChange={event => update({...profile, model: event.target.value})}/>
          : <SelectControl label={`${provider.name} 决策模型`} value={profile.model} disabled={disabled || native && catalog?.state !== 'ready'} options={[
            ...models.map(model => ({value: model.id, label: model.displayName})),
            ...(!selected ? [{value: profile.model, label: `${profile.model}（已配置）`, disabled: true}] : []),
          ]} onChange={model => {if (models.some(item => item.id === model)) update({model});}}/>}/>
        {native && <SettingsRow title="Effort" description={!efforts.length && catalog?.state === 'ready' && selected ? '此模型不支持单独设置 Effort。' : undefined} trailing={
          <SelectControl label={`${provider.name} 决策 Effort`} value={profile.effort ?? ''} disabled={disabled || !efforts.length} options={[
            {value: '', label: provider.id === 'claude-agent' ? '关闭思考（推荐）' : '最低支持档位（推荐）'},
            ...efforts.map(effort => ({value: effort, label: effort})),
            ...(profile.effort && !efforts.includes(profile.effort) ? [{value: profile.effort, label: `${profile.effort}（已配置）`, disabled: true}] : []),
          ]} onChange={effort => {const {effort: previous, ...rest} = profile; const chosen = efforts.find(item => item === effort); update({...rest, ...(chosen ? {effort: chosen} : {})});}}/>
        }/>}
        {native ? <div className="decision-config-actions">
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => update({...profile, custom: !profile.custom})}>{profile.custom ? '从目录选择' : '自定义模型 ID'}</Button>
          {catalog?.state !== 'ready' && <><span role="status">{catalog ? catalog.message || '模型目录暂不可用。' : '正在读取模型…'}</span>{onOpenProviders && <Button variant="ghost" size="sm" onClick={onOpenProviders}>设置 Provider</Button>}</>}
          {profile.custom && <span>请确认模型 ID 正确；自定义模型不经过目录校验。</span>}
        </div> : <p className="decision-config-note">Jev 不提供 Effort 设置。</p>}
      </section>;
    })}
  </>;
}

export function DecisionProviderSettings({services, onOpenProviders}: {services?: SecretService[]; onOpenProviders?: () => void}) {
  const client = useClient();
  const [view, setView] = useState<HostSettingsView>();
  const [catalogs, setCatalogs] = useState<Catalogs>({});
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const serial = useRef(0);
  const catalogSerial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    setLoading(true);
    try {
      const reply = await client.settings({type: 'read', scope: {kind: 'host'}});
      if (request !== serial.current) return;
      if (reply.kind !== 'view' || reply.view.scope.kind !== 'host' || !('runtime' in reply.view)) throw new Error(reply.kind === 'refused' ? reply.message : '无法读取决策模型配置。');
      setView(reply.view); setError(undefined);
    } catch (failure) {if (request === serial.current) setError(failure instanceof Error ? failure.message : '无法读取决策模型配置。');}
    finally {if (request === serial.current) setLoading(false);}
  }, [client]);
  const refreshCatalogs = useCallback(async () => {
    const request = ++catalogSerial.current;
    const results = await Promise.all(nativeProviders.map(async provider => {
      try {
        const reply = await client.collaboration({action: 'providerModels', backend: provider.id});
        return [provider.id, reply.kind === 'providerModels' ? reply : {kind: 'providerModels', backend: provider.id, state: 'unavailable', models: [], message: reply.kind === 'refused' ? reply.message : '模型目录暂不可用。'}] as const;
      } catch {return [provider.id, {kind: 'providerModels', backend: provider.id, state: 'unavailable', models: [], message: '模型目录暂不可用。'}] as const;}
    }));
    if (request === catalogSerial.current) setCatalogs(Object.fromEntries(results) as Catalogs);
  }, [client]);
  useEffect(() => {void refresh(); void refreshCatalogs(); return () => {serial.current++; catalogSerial.current++;};}, [refresh, refreshCatalogs]);
  async function save(patch: Partial<Configuration>, revision: string): Promise<SettingsReply> {
    const reply = await client.settings({type: 'save', edit: {scope: {kind: 'host'}, section: 'judge', revision, patch}});
    if (reply.kind === 'saved' && reply.result.kind === 'saved') await refresh();
    return reply;
  }
  const section = view?.sections.judge;
  return <>
    {error && <InlineNotice tone="warning" title="配置读取失败" actions={<Button size="sm" loading={loading} onClick={() => void refresh()}>重试</Button>}>{error}</InlineNotice>}
    {section ? <Editor title="Provider 配置" section={section} save={save}
      validate={value => Object.values(value.byProvider).some(profile => !profile.model.trim()) ? '请填写模型 ID。' : undefined}
      render={(value, change, disabled) => <DecisionProviderFields value={value} defaults={section.effective} catalogs={catalogs} services={services} disabled={disabled} onChange={change} onOpenProviders={onOpenProviders}/>}/>
      : <SettingsGroup label="Provider 配置"><SettingsRow title={loading ? '正在读取配置…' : '当前服务暂不支持统一配置'} description={loading ? undefined : '请更新并重新连接本机服务。'}/></SettingsGroup>}
    <div className="decision-config-reload"><Button size="sm" disabled={loading} onClick={() => {void refresh(); void refreshCatalogs();}}>重新读取配置与模型</Button></div>
  </>;
}
