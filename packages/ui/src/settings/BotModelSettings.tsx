import {useEffect, useRef, useState} from 'react';
import type {AgentSettingsView, ModelCatalog, SettingsReply, GlobalTitlePolicy} from '@vonvon/protocol';
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

// Model choice leads; one surface per setting, with only actionable labels.
export function BotTitleSettings({view, save}: {view: AgentSettingsView; save: Save}) {
  const {catalogs, refresh} = useBotModelCatalogs(view.scope.botId, 'titles');
  return <section className="bot-model-settings bot-title-settings" id={settingAnchor('新会话标题')} aria-label="会话标题">
    <Editor title="会话标题" section={view.sections.titles} autoSave hideEffects save={(patch, revision) => save('titles', patch, revision)}
      renderLayout={editor => <>{editor.content}</>}
      render={(draft, set, disabled) => <TitleFields policy={draft.policy} catalogs={catalogs} disabled={disabled} onRetry={() => void refresh()}
        onChange={policy => set({policy})}/>}/>
  </section>;
}

export function TitleFields({policy, catalogs, disabled, onChange, onRetry}: {
  policy: GlobalTitlePolicy; catalogs: Partial<Record<string, ModelCatalog>>; disabled: boolean;
  onChange: (value: GlobalTitlePolicy) => void; onRetry: () => void;
}) {
  const remembered = useRef<Extract<GlobalTitlePolicy, {enabled: true}> | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {if (policy.enabled) {remembered.current = policy; setChoosing(false);}}, [policy]);
  const initial = nativeModelProviders.flatMap(provider => {
    const catalog = catalogs[provider.id];
    if (!catalog || catalog.backend !== provider.id || catalog.state === 'unavailable') return [];
    const models = catalog.models.filter(model => !model.hidden);
    const model = models.find(model => model.isDefault) ?? models[0];
    return model ? [{enabled: true as const, backend: provider.id, model: model.id,
      effort: catalog.titleEfforts.includes(model.defaultEffort) ? model.defaultEffort : catalog.titleEfforts[0] ?? 'medium'}] : [];
  })[0];
  const enable = remembered.current ?? initial;
  const catalog = policy.enabled ? catalogs[policy.backend] : undefined;
  const value: NativeModelValue = policy.enabled ? {backend: policy.backend, selection: {kind: 'explicit', model: policy.model, effort: policy.effort,
    ...(!catalog?.models.some(model => !model.hidden && model.id === policy.model) ? {custom: true} : {})}} : {backend: 'codex-appserver', selection: {kind: 'default'}};
  return <>
    <SettingsRow title="会话标题" trailing={<Toggle className="settings-row-switch" label="自动生成会话标题" aria-label="自动生成会话标题" checked={policy.enabled || choosing}
      disabled={disabled} onChange={event => {if (disabled) return;
        if (!event.target.checked) {setChoosing(false); if (policy.enabled) onChange({enabled: false});}
        else if (enable) onChange(enable); else setChoosing(true);}}/>}/>
    {(policy.enabled || choosing) && <NativeModelPicker label="标题模型" value={value} catalogs={catalogs} allowCustom disabled={disabled} onRetry={onRetry}
      onChange={next => {if (disabled || next.selection.kind !== 'explicit') return;
        onChange({enabled: true, backend: next.backend, model: next.selection.model, effort: next.selection.effort});}}/>}
  </>;
}

export function BotCommentSettings({view, save, refresh}: {view: AgentSettingsView; save: Save; refresh: () => Promise<void>}) {
  const {catalogs, refresh: refreshCatalogs} = useBotModelCatalogs(view.scope.botId, 'comments');
  return <details className="agent-settings-disclosure bot-model-settings" id={settingAnchor('云文档评论')}>
    <summary><span>云文档评论</span></summary>
    <Editor title="评论模型" section={view.sections.comments} autoSave hideEffects save={(patch, revision) => save('comments', patch, revision)}
      renderLayout={editor => <div id={settingAnchor('评论模型')}>{editor.content}</div>}
      render={(draft, set, disabled, _commit, resetKey) => <NativeModelPicker key={resetKey} label="评论模型" value={draft} catalogs={catalogs} allowDefault disabled={disabled}
        onRetry={() => void refreshCatalogs()} onChange={next => {if (!disabled) set({...draft, ...next});}}/>}/>
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
  const readonly = view.sections.completion.access.kind === 'readonly';
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
  return <SettingsGroup label="回复规则" id={settingAnchor('评论回复规则')}
    action={<Button size="sm" variant="ghost" disabled={disabled || conflict || base.content.kind === 'default' && !dirty} onClick={() => void saveRules('default')}>恢复默认</Button>}
    footer={readonly && view.sections.completion.access.kind === 'readonly' ? view.sections.completion.access.message : undefined}>
    <div className="comment-rules-input"><textarea aria-label="评论回复规则" className="settings-instructions" value={text} maxLength={limit} disabled={disabled || conflict}
      onChange={event => {setText(event.target.value); setError(undefined); setNotice(undefined);}}/>
      {dirty && <span className="comment-rules-count" aria-live="polite">{[...text].length.toLocaleString()} / {limit.toLocaleString()}</span>}</div>
    {(dirty || pending) && <div className="settings-edit-actions"><Button size="sm" disabled={disabled} onClick={discard}>放弃修改</Button>
      <Button size="sm" variant="primary" loading={pending} disabled={disabled || conflict || !text.trim() || [...text].length > limit} onClick={() => void saveRules('custom')}>保存规则</Button></div>}
    {conflict && dirty && <InlineNotice title="规则已在别处更改" tone="warning">当前草稿已保留。<Button size="sm" disabled={pending} onClick={discard}>重新读取并放弃草稿</Button></InlineNotice>}
    {error && <InlineNotice title="规则保存未完成" tone="danger">{error}</InlineNotice>}
    {notice && <p className="settings-save-status" role="status">{notice}</p>}
  </SettingsGroup>;
}
