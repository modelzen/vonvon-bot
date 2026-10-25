import {RefreshCw} from 'lucide-react';
import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {defaultCodexDecisionModel, type CollaborationReply, type HostSettingsView, type SecretService, type SettingsReply} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, IconButton, InlineNotice, SelectControl} from '../reference/components/ui';
import {Editor} from '../settings/SettingsPanel';
import {decisionProviderSection, settingAnchor} from '../search';

import {effortChoices} from './decisionEffort';
import './decision-provider-settings.css';

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
export function DecisionProviderFields({value, defaults, catalogs, services, disabled, onChange, onOpenProviders, keyContent, keyUses, keyAction, modelAction}: {
  value: Configuration; defaults: Configuration; catalogs: Catalogs; services?: SecretService[]; disabled: boolean;
  onChange: (value: Configuration) => void; onOpenProviders?: () => void;
  keyContent?: ReactNode; keyUses?: ReactNode; keyAction?: ReactNode; modelAction?: ReactNode;
}) {
  function providerFields(provider: {id: string; name: string}) {
    const catalog = catalogs[provider.id];
    // Only an unsaved profile follows discovery. Preserve every explicit model and effort.
    const profile = value.byProvider[provider.id] ?? (provider.id === 'codex-appserver' && catalog?.state === 'ready'
      ? {model: defaultCodexDecisionModel(catalog.models)} as Profile : defaults.byProvider[provider.id]);
    if (!profile) return null;
    const native = provider.id !== 'typesafe';
    const models = native ? catalog?.models.filter(model => !model.hidden) ?? []
      : services?.find(service => service.provider === provider.id)?.models ?? [{id: 'jev-latest', displayName: 'Jev'}];
    const selected = models.find(model => model.id === profile.model);
    const efforts = native ? profile.custom ? customEfforts[provider.id] ?? [] : catalog?.models.find(model => model.id === profile.model)?.supportedEfforts ?? [] : [];
    const update = (next: Profile) => {if (!disabled) onChange({byProvider: {...value.byProvider, [provider.id]: next}});};
    const effortControl = effortChoices({provider: provider.id, model: profile.model, stored: profile.effort, efforts,
      custom: Boolean(profile.custom), catalogReady: catalog?.state === 'ready' && Boolean(selected)});
    function chooseModel(model: string) {
      const chosenModel = models.find(item => item.id === model);
      if (!chosenModel) return;
      if (!native) {update({model}); return;}
      const choices = effortChoices({provider: provider.id, model, efforts: catalog?.models.find(item => item.id === model)?.supportedEfforts ?? [], catalogReady: true});
      const recommended = customEfforts[provider.id]?.find(effort => effort === choices.recommended);
      update({model, ...(recommended ? {effort: recommended} : {})});
    }
    return <section className={`decision-provider-config${native ? '' : ' decision-provider-config--jev'}`} id={settingAnchor(decisionProviderSection(provider.id))} aria-label={`${provider.name} 决策配置`} key={provider.id}>
      {native && <div className="decision-provider-heading"><h3>{provider.name}</h3></div>}
      <SettingsRow className="decision-model-row" title="模型" trailing={profile.custom
        ? <input className="settings-field" aria-label={`${provider.name} 决策模型 ID`} value={profile.model} disabled={disabled} placeholder="模型 ID" onChange={event => update({...profile, model: event.target.value})}/>
        : <SelectControl presentation="dropdown" label={`${provider.name} 决策模型`} value={profile.model} disabled={disabled || native && catalog?.state !== 'ready'} options={[
          ...models.map(model => ({value: model.id, label: model.displayName})),
          ...(!selected ? [{value: profile.model, label: `${profile.model}（${value.byProvider[provider.id] ? '已配置' : '默认'}）`, disabled: true}] : []),
        ]} onChange={chooseModel}/>}/>
      {native && <SettingsRow className="decision-effort-row" title="思考强度 · Effort" trailing={
        <SelectControl presentation="dropdown" label={`${provider.name} 决策 Effort`} value={effortControl.value} disabled={disabled || !efforts.length} options={effortControl.options}
          onChange={effort => {const {effort: previous, ...rest} = profile; const chosen = efforts.find(item => item === effort); update({...rest, ...(chosen ? {effort: chosen} : {})});}}/>
      }/>}
      {native && <div className="decision-config-actions">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => update({...profile, custom: !profile.custom})}>{profile.custom ? '从目录选择' : '自定义模型 ID'}</Button>
        {catalog?.state !== 'ready' && <><span role="status">{catalog ? catalog.message || '模型目录暂不可用。' : '正在读取模型…'}</span>{onOpenProviders && <Button variant="ghost" size="sm" onClick={onOpenProviders}>设置 Provider</Button>}</>}
        {profile.custom && <span>请确认模型 ID 正确；自定义模型不经过目录校验。</span>}
      </div>}
    </section>;
  }
  return <>
    <SettingsGroup label="Codex 与 Claude" action={modelAction}>
      {nativeProviders.map(providerFields)}
    </SettingsGroup>
    <SettingsGroup label="TypeSafe · Jev" id={settingAnchor('决策模型')} action={keyAction}>
      <div className="decision-jev-fields">
        {providerFields({id: 'typesafe', name: 'TypeSafe · Jev'})}
        <div className="decision-jev-credentials">{keyContent}</div>
      </div>
      {keyUses}
    </SettingsGroup>
  </>;
}

export function DecisionProviderSettings({services, onOpenProviders, keyContent, keyUses, keyAction}: {services?: SecretService[]; onOpenProviders?: () => void; keyContent?: ReactNode; keyUses?: ReactNode; keyAction?: ReactNode}) {
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
  const modelAction = <IconButton size="sm" variant="ghost" label="重新读取配置与模型" title="重新读取配置与模型" disabled={loading} onClick={() => {void refresh(); void refreshCatalogs();}}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>;
  return <>
    {error && <InlineNotice tone="warning" title="配置读取失败" actions={<IconButton size="sm" variant="ghost" label="重试" title="重新读取 Provider 配置" loading={loading} onClick={() => void refresh()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}>{error}</InlineNotice>}
    {section ? <Editor title="模型配置" section={section} save={save}
      validate={value => Object.values(value.byProvider).some(profile => !profile.model.trim()) ? '请填写模型 ID。' : undefined}
      renderLayout={editor => <div className="decision-model-editor" data-writable={section.access.kind === 'writable'}>{editor.content}{(editor.canSave || editor.pending) && <div className="decision-save-bar"><span>模型选择尚未保存</span><Button size="sm" disabled={editor.pending} onClick={editor.discard}>放弃修改</Button><Button size="sm" variant="primary" loading={editor.pending} onClick={() => void editor.submit()}>保存模型配置</Button></div>}</div>}
      render={(value, change, disabled) => <DecisionProviderFields value={value} defaults={section.effective} catalogs={catalogs} services={services} disabled={disabled} onChange={change} onOpenProviders={onOpenProviders} keyContent={keyContent} keyUses={keyUses} keyAction={keyAction} modelAction={modelAction}/>}/>
      : <><SettingsGroup label="Provider 配置"><SettingsRow title={loading ? '正在读取配置…' : '当前服务暂不支持统一配置'} description={loading ? undefined : '请更新并重新连接本机服务。'}/></SettingsGroup><SettingsGroup label="TypeSafe · Jev" id={settingAnchor('决策模型')} action={keyAction}>{keyContent}{keyUses}</SettingsGroup></>}
  </>;
}
