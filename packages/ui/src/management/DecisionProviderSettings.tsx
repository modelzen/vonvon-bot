import {RefreshCw} from 'lucide-react';
import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {type HostSettingsView, type SecretService, type SettingsReply} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {IconButton, InlineNotice} from '../reference/components/ui';
import {Editor} from '../settings/SettingsPanel';
import {decisionProviderSection, settingAnchor} from '../search';

import {DecisionPicker, type DecisionCatalogs, type DecisionKeyState} from '../settings/DecisionPicker';
import {useDecisionCatalogs} from '../settings/useDecisionCatalogs';
import './decision-provider-settings.css';

type Configuration = NonNullable<HostSettingsView['sections']['judge']>['stored'];

/** A single default selection for newly created groups; existing groups keep their own choice. */
export function DecisionProviderFields({value, defaults, catalogs, services, disabled, onChange, onOpenProviders, onManageKey, keyContent, keyUses, keyAction, modelAction}: {
  value: Configuration; defaults: Configuration; catalogs: DecisionCatalogs; services?: SecretService[]; disabled: boolean;
  onChange: (value: Configuration) => void; onOpenProviders?: () => void; onManageKey?: () => void;
  keyContent?: ReactNode; keyUses?: ReactNode; keyAction?: ReactNode; modelAction?: ReactNode;
}) {
  const provider = value.defaultProvider ?? defaults.defaultProvider;
  const profile = provider ? value.byProvider[provider] ?? defaults.byProvider[provider] : undefined;
  const service = services?.find(item => item.provider === 'typesafe');
  const keyState: DecisionKeyState = service?.status === 'set' ? 'ready' : service?.status ?? (services ? 'unreadable' : 'loading');
  return <>
    <SettingsGroup label="默认决策模型" action={modelAction}>
      <div id={settingAnchor(decisionProviderSection())}><span id={settingAnchor(decisionProviderSection('codex-appserver'))}/><span id={settingAnchor(decisionProviderSection('claude-agent'))}/><DecisionPicker value={provider && profile ? {provider, ...profile} : undefined} catalogs={catalogs} jevModels={service?.models}
        keyState={keyState} context="global" disabled={disabled} onOpenProviders={onOpenProviders} onManageKey={onManageKey}
        onChange={selection => {
          if (disabled || !['codex-appserver', 'claude-agent', 'typesafe'].includes(selection.provider)) return;
          const {provider: selected, ...profile} = selection;
          onChange({...value, defaultProvider: selected as Configuration['defaultProvider'], byProvider: {...value.byProvider, [selected]: selected === 'typesafe' ? {model: profile.model} : profile}});
        }}/></div>
    </SettingsGroup>
    <SettingsGroup label="Jev 密钥" id={settingAnchor('决策模型')} action={keyAction}>
      <div id={settingAnchor(decisionProviderSection('typesafe'))}>{keyContent}</div>{keyUses}
    </SettingsGroup>
  </>;
}

export function DecisionProviderSettings({services, onOpenProviders, onManageKey, keyContent, keyUses, keyAction}: {services?: SecretService[]; onOpenProviders?: () => void; onManageKey?: () => void; keyContent?: ReactNode; keyUses?: ReactNode; keyAction?: ReactNode}) {
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
        if (provider === 'typesafe' && services?.find(service => service.provider === provider)?.status !== 'set') return '请先配置可用的 Jev 密钥。';
        return undefined;
      }}
      renderLayout={editor => <div className="decision-model-editor" data-writable={section.access.kind === 'writable'}>{editor.content}</div>}
      render={(value, change, disabled) => <DecisionProviderFields value={value} defaults={section.effective} catalogs={catalogs} services={services} disabled={disabled} onChange={change} onOpenProviders={onOpenProviders} onManageKey={onManageKey} keyContent={keyContent} keyUses={keyUses} keyAction={keyAction} modelAction={modelAction}/>}/>
      : <><SettingsGroup label="Provider 配置"><SettingsRow title={loading ? '正在读取配置…' : '当前服务暂不支持统一配置'} description={loading ? undefined : '请更新并重新连接本机服务。'}/></SettingsGroup><SettingsGroup label="Jev 密钥" id={settingAnchor('决策模型')} action={keyAction}>{keyContent}{keyUses}</SettingsGroup></>}
  </>;
}
