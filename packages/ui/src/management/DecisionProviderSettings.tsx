import {ChevronDown, RefreshCw} from 'lucide-react';
import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {DECISION_API_PROVIDERS, JUDGE_PROVIDER_IDS, decisionApiProviderLabel, decisionEndpointProblem, type HostSettingsView, type SecretService, type SettingsReply} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {IconButton, InlineNotice} from '../reference/components/ui';
import {Editor} from '../settings/SettingsPanel';
import {decisionProviderSection, settingAnchor} from '../search';

import {DecisionPicker, decisionApiModels, isDecisionApiProvider, type DecisionCatalogs, type DecisionKeyState, type DecisionPickerService} from '../settings/DecisionPicker';
import {useDecisionCatalogs} from '../settings/useDecisionCatalogs';
import './decision-provider-settings.css';

type Configuration = NonNullable<HostSettingsView['sections']['judge']>['stored'];

/** Keep the fields mounted so search can reveal their native disclosure ancestors. */
export function revealDecisionConnection(target: HTMLElement | null): void {
  let ancestor = target;
  while (ancestor) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    ancestor = ancestor.parentElement;
  }
}

export function DecisionServiceDisclosure({provider, service, children}: {provider: string; service?: SecretService; children: ReactNode}) {
  const status = !service ? '正在读取…' : service.status === 'set' ? '已配置' : service.status === 'missing' ? '未配置' : service.status === 'invalid' ? '需重新添加' : '读取失败';
  return <details className="decision-service-disclosure" name="decision-service-connection" id={settingAnchor(decisionProviderSection(provider))}>
    <summary>
      <span className="decision-service-name">{provider === 'custom' ? '自定义接口' : decisionApiProviderLabel(provider)}</span>
      <span className="decision-service-summary"><span data-status={service?.status}>{status}</span><ChevronDown size={15} aria-hidden="true"/></span>
    </summary>
    <div className="decision-service-fields">{children}</div>
  </details>;
}

function DecisionConnections({services, children, action}: {services?: SecretService[]; children: ReactNode; action?: ReactNode}) {
  const configured = services?.filter(service => service.status === 'set') ?? [];
  const problem = services?.some(service => service.status === 'invalid' || service.status === 'unreadable');
  return <details className="decision-connections" id={settingAnchor('决策模型')}>
    <summary>
      <span className="decision-connections-copy"><span>决策服务</span><small>{configured.length ? `已配置 ${configured.map(service => decisionApiProviderLabel(service.provider)).join('、')}` : '使用 Jev 时，按需连接一个服务。'}</small></span>
      <span className="decision-service-summary"><span>{problem ? '需检查' : configured.length ? `${configured.length} 个已配置` : '可选'}</span><ChevronDown size={16} aria-hidden="true"/></span>
    </summary>
    <div className="decision-connections-body">
      <div className="decision-connections-toolbar"><span>选择要配置的服务</span>{action}</div>
      {children}
    </div>
  </details>;
}

/** A single default selection for newly created groups; existing groups keep their own choice. */
export function DecisionProviderFields({value, defaults, catalogs, services, disabled, onChange, onOpenProviders, onManageKey, customKeyContent, keyContent, keyUses, keyAction, modelAction}: {
  value: Configuration; defaults: Configuration; catalogs: DecisionCatalogs; services?: SecretService[]; disabled: boolean;
  onChange: (value: Configuration) => void; onOpenProviders?: () => void; onManageKey?: (provider?: string) => void;
  customKeyContent?: ReactNode; keyContent?: ReactNode; keyUses?: ReactNode; keyAction?: ReactNode; modelAction?: ReactNode;
}) {
  const provider = value.defaultProvider ?? defaults.defaultProvider;
  const profile = provider ? value.byProvider[provider] ?? defaults.byProvider[provider] : undefined;
  const service = services?.find(item => item.provider === 'typesafe');
  const customProfile = value.byProvider.custom ?? defaults.byProvider.custom ?? {model: 'jev-latest'};
  const decisionServices: DecisionPickerService[] = DECISION_API_PROVIDERS.map(provider => {
    const service = services?.find(item => item.provider === provider);
    return {provider, displayName: service?.displayName, endpointConfigured: provider === 'custom' ? !decisionEndpointProblem(customProfile.endpoint) : undefined,
      models: provider === 'custom' ? [{id: customProfile.model, displayName: 'Jev / System One'}] : service?.models ?? decisionApiModels[provider],
      keyState: service?.status === 'set' ? 'ready' : service?.status ?? (services ? 'unreadable' : 'loading')};
  });
  function changeCustom(patch: {endpoint?: string; model?: string}) {
    const custom = {...customProfile, ...patch};
    if (patch.endpoint === '') delete custom.endpoint;
    if (!disabled) onChange({...value, byProvider: {...value.byProvider, custom}});
  }
  const keyState: DecisionKeyState = service?.status === 'set' ? 'ready' : service?.status ?? (services ? 'unreadable' : 'loading');
  return <>
    <SettingsGroup label="默认决策模型" action={modelAction}>
      <div id={settingAnchor(decisionProviderSection())}><span id={settingAnchor(decisionProviderSection('codex-appserver'))}/><span id={settingAnchor(decisionProviderSection('claude-agent'))}/><DecisionPicker value={provider && profile ? {provider, ...profile} : undefined} catalogs={catalogs} jevModels={service?.models} decisionServices={decisionServices}
        keyState={keyState} context="global" disabled={disabled} onOpenProviders={onOpenProviders} onManageKey={onManageKey}
        onChange={selection => {
          if (disabled || !JUDGE_PROVIDER_IDS.some(provider => provider === selection.provider)) return;
          const {provider: selected, ...profile} = selection;
          onChange({...value, defaultProvider: selected as Configuration['defaultProvider'], byProvider: {...value.byProvider, [selected]: isDecisionApiProvider(selected) ? {...(selected === 'custom' && customProfile.endpoint !== undefined ? {endpoint: customProfile.endpoint} : {}), model: profile.model} : profile}});
        }}/></div>
    </SettingsGroup>
    <DecisionConnections services={services} action={keyAction}>
      {keyContent}
      <DecisionServiceDisclosure provider="custom" service={services?.find(service => service.provider === 'custom')}>
      <SettingsRow title="接口地址" description="填写服务商提供的完整 Jev 请求地址，包含路径。"
        trailing={<input key={`endpoint:${customProfile.endpoint ?? ''}`} className="settings-field decision-connection-input" aria-label="自定义决策请求地址" placeholder="https://example.com/v1/systemone" type="url" defaultValue={customProfile.endpoint ?? ''} disabled={disabled}
          onBlur={event => {const endpoint = event.currentTarget.value.trim(); if (endpoint !== (customProfile.endpoint ?? '')) changeCustom({endpoint});}}/>}/>
      <SettingsRow title="模型 ID" description="填写服务商提供的模型 ID，已有群保持原来的选择。"
        trailing={<input key={`model:${customProfile.model}`} className="settings-field decision-connection-input" aria-label="自定义接口模型 ID" placeholder="jev-latest" defaultValue={customProfile.model} disabled={disabled}
          onBlur={event => {const model = event.currentTarget.value.trim(); if (model !== customProfile.model) changeCustom({model});}}/>}/>
      {customKeyContent}
      <p className="decision-connection-note">此接口与密钥供本机使用该服务的 Bot 和群共用。</p>
      </DecisionServiceDisclosure>
      {keyUses}
    </DecisionConnections>
  </>;
}

export function DecisionProviderSettings({services, onOpenProviders, onManageKey, customKeyContent, keyContent, keyUses, keyAction}: {services?: SecretService[]; onOpenProviders?: () => void; onManageKey?: (provider?: string) => void; customKeyContent?: ReactNode; keyContent?: ReactNode; keyUses?: ReactNode; keyAction?: ReactNode}) {
  const client = useClient();
  const [view, setView] = useState<HostSettingsView>();
  const {catalogs, refresh: refreshCatalogs} = useDecisionCatalogs();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const serial = useRef(0);
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
  useEffect(() => {void refresh(); return () => {serial.current++;};}, [refresh]);
  async function save(patch: Partial<Configuration>, revision: string): Promise<SettingsReply> {
    const reply = await client.settings({type: 'save', edit: {scope: {kind: 'host'}, section: 'judge', revision, patch}});
    if (reply.kind === 'saved' && reply.result.kind === 'saved') await refresh();
    return reply;
  }
  const section = view?.sections.judge;
  const modelAction = <IconButton size="sm" variant="ghost" label="重新读取配置与模型" title="重新读取配置与模型" disabled={loading} onClick={() => {void refresh(); void refreshCatalogs();}}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>;
  return <>
    {error && <InlineNotice tone="warning" title="配置读取失败" actions={<IconButton size="sm" variant="ghost" label="重试" title="重新读取 Provider 配置" loading={loading} onClick={() => void refresh()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}>{error}</InlineNotice>}
    {section ? <Editor title="模型配置" section={section} autoSave save={save}
      validate={value => {
        const provider = value.defaultProvider ?? section.effective.defaultProvider;
        if (!provider) return '请选择默认决策模型。';
        if (!(value.byProvider[provider] ?? section.effective.byProvider[provider])?.model.trim()) return '请填写模型 ID。';
        const custom = value.byProvider.custom ?? section.effective.byProvider.custom;
        if (custom && !custom.model.trim()) return '请填写自定义接口的模型 ID。';
        if (provider === 'custom' || custom?.endpoint) {const problem = decisionEndpointProblem(custom?.endpoint); if (problem) return problem;}
        if (isDecisionApiProvider(provider) && services?.find(service => service.provider === provider)?.status !== 'set') return `请先配置可用的 ${decisionApiProviderLabel(provider)} 密钥。`;
        return undefined;
      }}
      renderLayout={editor => <div className="decision-model-editor" data-writable={section.access.kind === 'writable'}>{editor.content}</div>}
      render={(value, change, disabled) => <DecisionProviderFields value={value} defaults={section.effective} catalogs={catalogs} services={services} disabled={disabled} onChange={change} onOpenProviders={onOpenProviders} onManageKey={onManageKey} customKeyContent={customKeyContent} keyContent={keyContent} keyUses={keyUses} keyAction={keyAction} modelAction={modelAction}/>}/>
      : <><SettingsGroup label="Provider 配置"><SettingsRow title={loading ? '正在读取配置…' : '当前服务暂不支持统一配置'} description={loading ? undefined : '请更新并重新连接本机服务。'}/></SettingsGroup><DecisionConnections services={services} action={keyAction}>{keyContent}{customKeyContent && <DecisionServiceDisclosure provider="custom" service={services?.find(service => service.provider === 'custom')}>{customKeyContent}</DecisionServiceDisclosure>}{keyUses}</DecisionConnections></>}
  </>;
}
