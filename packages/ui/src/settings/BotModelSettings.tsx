import {useEffect, useRef, useState} from 'react';
import type {AgentSettingsView, ModelCatalog, SettingsReply, TitlePolicy} from '@vonvon/protocol';
import {useClient} from '../client-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button, InlineNotice, Toggle} from '../reference/components/ui';
import {settingAnchor} from '../search';
import {useDraft} from './DraftGuard';
import {Editor} from './SettingsPanel';
import {NativeModelPicker, nativeModelProviders, type NativeModelValue} from './NativeModelPicker';
import {useBotModelCatalogs} from './useBotModelCatalogs';
import './bot-model-settings.css';

type Save = (section: 'titles' | 'comments', patch: object, revision: string) => Promise<SettingsReply>;

// Intent: a Bot owner picks a model once, with the same searchable menu as decisions.
// Existing neutral surfaces, subtle borders, system type and 4px spacing preserve the
// settings hierarchy: model first, effort second, status and inheritance underneath.
export function BotTitleSettings({view, save}: {view: AgentSettingsView; save: Save}) {
  const {catalogs, refresh} = useBotModelCatalogs(view.scope.botId, 'titles');
  return <details className="agent-settings-disclosure bot-model-settings" id={settingAnchor('新会话标题')}>
    <summary><span>会话标题<small>按 Provider 设置自动标题</small></span></summary>
    <p className="bot-model-intro">为新会话生成简短标题。Codex 和 Claude 分别设置，关闭时使用消息首句。</p>
    {nativeModelProviders.map(provider => <Editor key={provider.id} title={`${provider.name} 会话标题`} section={view.sections.titles} autoSave
      save={(patch, revision) => save('titles', {byBackend: {[provider.id]: patch.byBackend?.[provider.id] ?? {enabled: false}}}, revision)}
      render={(draft, set, disabled) => <TitleProviderFields provider={provider} policy={draft.byBackend[provider.id] ?? {enabled: false}}
        catalog={catalogs[provider.id]} disabled={disabled} onRetry={() => void refresh()}
        onChange={policy => set({...draft, byBackend: {...draft.byBackend, [provider.id]: policy}})}/>}/>)}
  </details>;
}

export function TitleProviderFields({provider, policy, catalog, disabled, onChange, onRetry}: {
  provider: {id: string; name: string}; policy: TitlePolicy; catalog?: ModelCatalog; disabled: boolean;
  onChange: (value: TitlePolicy) => void; onRetry: () => void;
}) {
  const remembered = useRef<Extract<TitlePolicy, {enabled: true}> | undefined>(undefined);
  useEffect(() => {if (policy.enabled) remembered.current = policy;}, [policy]);
  const models = catalog?.state !== 'unavailable' ? catalog?.models.filter(model => !model.hidden) ?? [] : [];
  const initial = models.find(model => model.isDefault) ?? models[0];
  const enable = remembered.current ?? (initial ? {enabled: true as const, model: initial.id,
    effort: catalog?.titleEfforts.includes(initial.defaultEffort) ? initial.defaultEffort : catalog?.titleEfforts[0] ?? 'medium'} : undefined);
  const value: NativeModelValue = {backend: provider.id, selection: policy.enabled ? {kind: 'explicit', model: policy.model, effort: policy.effort,
    ...(!models.some(model => model.id === policy.model) ? {custom: true} : {})} : {kind: 'default'}};
  return <>
    <SettingsRow title="用模型生成标题" description={policy.enabled ? '模型与思考强度的修改会自动保存。' : '选择模型即可启用，也可以填写自定义模型 ID。'}
      trailing={<Toggle className="settings-row-switch" label={`${provider.name} 自动生成标题`} aria-label={`${provider.name} 自动生成标题`} checked={policy.enabled}
        disabled={disabled || !policy.enabled && !enable} onChange={event => {if (disabled) return; if (!event.target.checked) onChange({enabled: false}); else if (enable) onChange(enable);}}/>}/>
    <NativeModelPicker label={`${provider.name} 标题模型`} value={value} catalogs={{[provider.id]: catalog}} providerIds={[provider.id]} allowCustom disabled={disabled} onRetry={onRetry}
      onChange={next => {if (disabled || next.backend !== provider.id || next.selection.kind !== 'explicit') return;
        onChange({enabled: true, model: next.selection.model, effort: next.selection.effort});}}/>
  </>;
}

export function BotCommentSettings({view, save, refresh}: {view: AgentSettingsView; save: Save; refresh: () => Promise<void>}) {
  const {catalogs, refresh: refreshCatalogs} = useBotModelCatalogs(view.scope.botId, 'comments');
  return <details className="agent-settings-disclosure bot-model-settings" id={settingAnchor('云文档评论')}>
    <summary><span>云文档评论<small>模型与回复规则</small></span></summary>
    <p className="bot-model-intro">在同一个列表中选择 Provider 和模型。模型设置自动保存，下一条新评论生效。</p>
    <Editor title="评论模型" section={view.sections.comments} autoSave save={(patch, revision) => save('comments', patch, revision)}
      render={(draft, set, disabled, _commit, resetKey) => <NativeModelPicker key={resetKey} label="评论模型" value={draft} catalogs={catalogs} allowDefault disabled={disabled}
        inherited={draft.backend === view.sections.comments.effective.backend ? {backend: view.sections.comments.effective.backend, selection: view.sections.comments.effective.selection} : undefined} onRetry={() => void refreshCatalogs()}
        onChange={next => {if (!disabled) set({...draft, ...next});}}/>}/>
    <CommentRulesEditor key={view.scope.botId} view={view} refresh={refresh}/>
  </details>;
}

function actionFailure(reply: SettingsReply): string | undefined {
  if (reply.kind === 'refused') return reply.message;
  if (reply.kind !== 'acted') return '未收到保存确认，请重试。';
  if (reply.result.kind === 'rejected') return reply.result.fields.map(field => `${field.field}：${field.message}`).join('；');
  if (reply.result.kind === 'conflict') return '规则已在别处更改，当前草稿已保留。请重新读取后确认。';
  if (reply.result.kind === 'unavailable') return reply.result.reason.kind === 'readonly' ? reply.result.reason.message : '当前不可编辑。';
}

export function CommentRulesEditor({view, refresh}: {view: AgentSettingsView; refresh: () => Promise<void>}) {
  const client = useClient();
  const incoming = view.commentInstructions;
  const [base, setBase] = useState(incoming);
  const [text, setText] = useState(incoming.content.text);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const priorRevision = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const dirty = text !== base.content.text;
  const conflict = incoming.revision !== base.revision && incoming.revision !== priorRevision.current;
  const readonly = view.sections.cards.access.kind === 'readonly';
  const disabled = readonly || pending;
  const limit = Math.min(incoming.maxEditLength, 30000);
  useEffect(() => {
    if (conflict && !dirty && !pending) {setBase(incoming); setText(incoming.content.text);}
  }, [incoming, conflict, dirty, pending]);
  function discard() {setBase(incoming); setText(incoming.content.text); setError(undefined); setNotice(undefined);}
  async function saveRules(kind: 'custom' | 'default'): Promise<boolean> {
    if (disabled || saving.current || conflict || kind === 'custom' && (!text.trim() || [...text].length > limit)) return false;
    saving.current = true; setPending(true); setError(undefined); setNotice(undefined);
    try {
      const reply = await client.settings({type: 'act', action: {kind: 'commentInstructions', botId: view.scope.botId, revision: base.revision,
        content: kind === 'default' ? {kind} : {kind, text}}});
      const failure = actionFailure(reply);
      if (failure) {setError(failure); return false;}
      if (reply.kind !== 'acted' || reply.result.kind !== 'saved' || !('commentInstructions' in reply.result.view)) {setError('未收到规则保存确认，请重新读取。'); return false;}
      const canonical = reply.result.view.commentInstructions;
      priorRevision.current = base.revision;
      setBase(canonical); setText(canonical.content.text);
      setNotice(kind === 'default' ? '已恢复默认规则。' : '规则已保存。');
      await refresh();
      return true;
    } catch (failure) {setError(failure instanceof Error ? failure.message : '保存失败，请重试。'); return false;}
    finally {saving.current = false; setPending(false);}
  }
  useDraft(dirty || pending, {title: '评论回复规则', save: () => saveRules('custom'), discard});
  return <SettingsGroup label="评论回复规则" id={settingAnchor('评论回复规则')}
    footer={readonly && view.sections.cards.access.kind === 'readonly' ? view.sections.cards.access.message : '保存后同步已有评论目录，下一条新评论使用新规则。'}>
    <div className="comment-rules-toolbar"><span>{base.content.kind === 'default' ? '默认规则' : '自定义规则'}</span>
      <Button size="sm" variant="ghost" disabled={disabled || conflict || base.content.kind === 'default' && !dirty} onClick={() => void saveRules('default')}>恢复默认</Button></div>
    <div className="comment-rules-input"><textarea aria-label="评论回复规则" className="settings-instructions" value={text} maxLength={limit} disabled={disabled || conflict}
      onChange={event => {setText(event.target.value); setError(undefined); setNotice(undefined);}}/>
      <span className="comment-rules-count" aria-live="polite">{[...text].length.toLocaleString()} / {limit.toLocaleString()}</span></div>
    {(dirty || pending) && <div className="settings-edit-actions"><Button size="sm" disabled={disabled} onClick={discard}>放弃修改</Button>
      <Button size="sm" variant="primary" loading={pending} disabled={disabled || conflict || !text.trim() || [...text].length > limit} onClick={() => void saveRules('custom')}>保存规则</Button></div>}
    {conflict && dirty && <InlineNotice title="规则已在别处更改" tone="warning">当前草稿已保留。<Button size="sm" disabled={pending} onClick={discard}>重新读取并放弃草稿</Button></InlineNotice>}
    {error && <InlineNotice title="规则保存未完成" tone="danger">{error}</InlineNotice>}
    {notice && <p className="settings-save-status" role="status">{notice}</p>}
  </SettingsGroup>;
}
