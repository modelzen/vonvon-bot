import {useEffect, useRef, useState} from 'react';
import {communityFailureMessages, recipePublicSchema, recipeConfigSchema} from '@vonvon/protocol';
import type {CommunityRequest, CommunityShell, RecipeConfig, RecipeDetail, RecipeDraft, RecipePublic} from '@vonvon/protocol';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {useDraft, useDraftGuard} from '../settings/DraftGuard';
import {RecipeConfiguration, RecipeDetails, RecipeMarkdown, RecipeMetadata} from './RecipeContent';

const blank: {public: RecipePublic; config: RecipeConfig} = {public: {name: '', summary: '', overview: '', version: '1.0', access: 'direct'}, config: {role: ''}};
export function RecipeEditor({shell, accountId, draftId, source, onBack, onPublished}: {
  shell: CommunityShell; accountId: string; draftId?: string; source?: RecipeDetail; onBack: () => void; onPublished: (recipe: RecipeDetail & {firstCode?: string}) => void;
}) {
  const [model, setModel] = useState<RecipeDraft>();
  const [contents, setContents] = useState(() => source ? {public: {...source.public, summary: source.public.summary ?? '', overview: source.public.overview ?? '', version: ''}, config: source.config ?? blank.config} : blank);
  const [editing, setEditing] = useState(!draftId);
  const [dirty, setDirty] = useState(Boolean(source));
  const [loading, setLoading] = useState(Boolean(draftId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [review, setReview] = useState<RecipeDraft>();
  const [deleting, setDeleting] = useState(false);
  const [latest, setLatest] = useState<RecipeDraft>();
  const [saved, setSaved] = useState(false);
  const keys = useRef(new Map<string, string>());
  const pendingSave = useRef<Extract<CommunityRequest, {type: 'saveDraft'}> | undefined>(undefined);
  const live = useRef(true);
  const {navigate} = useDraftGuard();
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  useEffect(() => {
    if (!draftId) return;
    let active = true;
    void shell.request({type: 'draft', accountId, draftId}).then(value => {
      if (!active) return; setModel(value); setContents({public: value.public, config: value.config}); setLoading(false);
    }, e => {if (active) {setError(e instanceof Error ? e.message : '草稿读取失败。'); setLoading(false);}});
    return () => {active = false;};
  }, [shell, accountId, draftId]);
  const key = (logical: string) => {if (!keys.current.has(logical)) keys.current.set(logical, crypto.randomUUID()); return keys.current.get(logical)!;};
  const changePublic = (patch: Partial<RecipePublic>) => {setContents(old => ({...old, public: {...old.public, ...patch}})); setDirty(true); setSaved(false);};
  const changeConfig = (patch: Partial<RecipeConfig>) => {setContents(old => ({...old, config: {...old.config, ...patch}})); setDirty(true); setSaved(false);};
  async function save(): Promise<RecipeDraft | undefined> {
    if (model && !dirty) return model;
    setError(undefined);
    if (!recipePublicSchema.safeParse(contents.public).success || !recipeConfigSchema.safeParse(contents.config).success) {setError('请检查内容长度。名称最多 60 个字符，简介 240 个字符，版本 40 个字符，步骤名称 80 个字符；正文与步骤说明按 UTF-8 字节限制。'); return;}
    try {
      const target = model ? {kind: 'existing' as const, draftId: model.draftId, revision: model.revision} : {kind: 'new' as const, ...(source ? {source: {recipeId: source.recipeId, versionId: source.versionId}} : {})};
      const logical = 'save:' + JSON.stringify({target, ...contents});
      const request = pendingSave.current ?? {type: 'saveDraft' as const, accountId, requestId: key(logical), target, ...contents};
      pendingSave.current = request;
      let next = await shell.request(request);
      if (!live.current) return;
      pendingSave.current = undefined;
      setModel(next);
      if (JSON.stringify({public: request.public, config: request.config}) !== JSON.stringify(contents)) {
        const followup = {type: 'saveDraft' as const, accountId, requestId: key('save:' + next.draftId + ':' + next.revision + ':' + JSON.stringify(contents)), target: {kind: 'existing' as const, draftId: next.draftId, revision: next.revision}, ...contents};
        pendingSave.current = followup;
        next = await shell.request(followup);
        if (!live.current) return;
        pendingSave.current = undefined;
      }
      setModel(next); setContents({public: next.public, config: next.config}); setDirty(false); setSaved(true); return next;
    } catch (e) {if (e instanceof Error && (Object.values(communityFailureMessages) as string[]).includes(e.message)) pendingSave.current = undefined; if (live.current) setError(e instanceof Error ? e.message : '保存未完成，输入仍保留。');}
  }
  useDraft(dirty, {title: '配方草稿', save: async () => Boolean(await save()), discard: () => setDirty(false)});
  async function run(action: () => Promise<void>) {if (busy) return; setBusy(true); try {await action();} catch (e) {if (live.current) setError(e instanceof Error ? e.message : '操作未完成。');} finally {if (live.current) setBusy(false);}}
  async function preparePublish() {
    if (!contents.public.name.trim() || !contents.public.summary.trim() || !contents.public.version.trim()) {setError('先填写名称、简介和版本，再预览发布。'); return;}
    const next = await save(); if (next) setReview(next);
  }
  async function publish() {
    if (!review) return;
    const result = await shell.request({type: 'publishDraft', accountId, draftId: review.draftId, revision: review.revision, requestId: key(`publish:${review.draftId}:${review.revision}`)});
    if (!live.current) return;
    setDirty(false); setReview(undefined);
    onPublished({...result, owned: true, acquired: false, config: review.config});
  }
  if (loading) return <p role="status">正在读取私人草稿…</p>;
  if (draftId && !model) return <><InlineNotice title="草稿读取未完成" tone="warning">{error}</InlineNotice><Button onClick={onBack}>返回创作中心</Button></>;
  if (!editing && model) return <div className="community-page"><div className="community-actions"><Button variant="ghost" onClick={onBack}>返回创作中心</Button><Button variant="primary" onClick={() => setEditing(true)}>编辑草稿</Button></div><p className="community-muted">私人草稿 · 仅自己可见</p><RecipeDetails recipe={{recipeId: model.recipeId ?? model.draftId, versionId: model.draftId, revision: model.revision, public: model.public, config: model.config, owned: true, acquired: false}}/></div>;
  const steps = contents.config.setup?.steps ?? [];
  const updateStep = (i: number, patch: Partial<NonNullable<RecipeConfig['setup']>['steps'][number]>) => changeConfig({setup: {steps: steps.map((step, at) => at === i ? {...step, ...patch} : step)}});
  return <div className="community-page"><div className="community-heading"><div><h1>{contents.public.name || '新建私人草稿'}</h1><p>先审核配置，再填写发布信息。保存草稿不会公开。</p></div><div className="community-actions"><Button variant="ghost" onClick={() => navigate(onBack)}>返回创作中心</Button>{model && <Button disabled={busy} onClick={() => setDeleting(true)}>删除草稿</Button>}</div></div>
    {error && <InlineNotice title="操作未完成" tone="warning" actions={model && <Button disabled={busy} onClick={() => void run(async () => {const current = await shell.request({type: 'draft', accountId, draftId: model.draftId}); if (live.current) setLatest(current);})}>读取最新草稿</Button>}>{error}</InlineNotice>}{saved && <p role="status" className="community-muted">私人草稿已保存</p>}
    <form className="community-editor" onSubmit={event => {event.preventDefault(); void run(async () => {await save();});}}>
      <fieldset disabled={busy}><legend>发布信息</legend><label>名称<input aria-label="配方名称" value={contents.public.name} onChange={event => changePublic({name: event.target.value})}/></label><label>公开简介<textarea aria-label="公开简介" value={contents.public.summary} rows={3} onChange={event => changePublic({summary: event.target.value})}/></label>
        <div className="community-editor-grid"><label>版本<input aria-label="版本" value={contents.public.version} onChange={event => changePublic({version: event.target.value})}/></label><label>获取方式<select aria-label="获取方式" value={contents.public.access} onChange={event => changePublic({access: event.target.value as RecipePublic['access']})}><option value="direct">直接获取</option><option value="coded">凭分享码获取</option></select></label></div>
        <label>公开概览 · Markdown<textarea aria-label="公开概览" value={contents.public.overview} maxLength={32768} onChange={event => changePublic({overview: event.target.value})}/></label>
      </fieldset>
      <fieldset disabled={busy}><legend>角色与规则</legend><p className="community-muted">{contents.public.access === 'coded' ? '仅作者与已获取此版本的人可见。' : '这些配置将在社区公开展示。'}请移除凭据、主机路径和私人内容。</p><label>角色与规则<textarea aria-label="角色与规则" value={contents.config.role} maxLength={16384} onChange={event => changeConfig({role: event.target.value})}/></label></fieldset>
      <fieldset disabled={busy}><legend>使用前准备</legend>{!steps.length && <p className="community-muted">不需要准备时可直接发布。步骤只作为说明，不会自动执行命令。</p>}
        {steps.map((step, i) => <fieldset key={i}><legend>步骤 {i + 1}</legend><div className="community-editor-grid"><label>名称<input value={step.title} onChange={event => updateStep(i, {title: event.target.value})}/></label><label>类型<select value={step.kind} onChange={event => updateStep(i, {kind: event.target.value as typeof step.kind})}><option value="config">配置</option><option value="tool">工具</option><option value="context">上下文</option></select></label></div><label>操作说明<textarea value={step.instructions} maxLength={2048} onChange={event => updateStep(i, {instructions: event.target.value})}/></label><label>检查方式<input value={step.check ?? ''} maxLength={512} onChange={event => updateStep(i, {check: event.target.value})}/></label><label className="community-checkbox"><input type="checkbox" checked={step.required} onChange={event => updateStep(i, {required: event.target.checked})}/>必需步骤</label><Button type="button" onClick={() => {const next = steps.filter((_, at) => at !== i); changeConfig({setup: next.length ? {steps: next} : undefined});}}>移除此步骤</Button></fieldset>)}
        <Button type="button" disabled={steps.length >= 8} onClick={() => changeConfig({setup: {steps: [...steps, {kind: 'config', title: '', instructions: '', required: false}]}})}>添加准备步骤</Button>
      </fieldset>
      <div className="community-actions"><Button type="submit" disabled={busy}>保存私人草稿</Button><Button type="button" variant="primary" disabled={busy} onClick={() => void run(preparePublish)}>预览发布</Button></div>
    </form>
    <Dialog open={Boolean(latest)} title="核对最新草稿" size="lg" onClose={() => setLatest(undefined)} footer={<><Button onClick={() => setLatest(undefined)}>继续核对</Button><Button variant="primary" onClick={() => {if (!latest) return; setModel(latest); pendingSave.current = undefined; setLatest(undefined); setError(undefined); setDirty(true); setSaved(false);}}>保留当前输入，使用此修订继续编辑</Button></>}>
      <p>下面是云端最新保存的内容。你的未保存输入仍保留。确认后，再点击保存才会更新这份草稿。</p>{latest && <><h2>{latest.public.name}</h2><p>{latest.public.summary}</p><RecipeMetadata meta={latest.public}/><RecipeMarkdown text={latest.public.overview}/><RecipeConfiguration config={latest.config} section="能力"/><RecipeConfiguration config={latest.config} section="使用前准备"/></>}
    </Dialog>
    <Dialog open={Boolean(review)} title="确认发布到社区" size="lg" onClose={busy ? undefined : () => setReview(undefined)} footer={<><Button disabled={busy} onClick={() => setReview(undefined)}>继续编辑</Button><Button variant="primary" disabled={busy} onClick={() => void run(publish)}>发布到社区</Button></>}>
      {error && <InlineNotice title="发布未完成" tone="warning">{error}</InlineNotice>}
      {review && <><h2>{review.public.name}</h2><p>{review.public.summary}</p><RecipeMetadata meta={review.public}/><RecipeMarkdown text={review.public.overview}/><RecipeConfiguration config={review.config} section="能力"/><RecipeConfiguration config={review.config} section="使用前准备"/></>}
    </Dialog>
    <Dialog open={deleting} title="删除私人草稿" onClose={busy ? undefined : () => setDeleting(false)} footer={<><Button onClick={() => setDeleting(false)} disabled={busy}>保留草稿</Button><Button disabled={busy} onClick={() => void run(async () => {if (!model) return; await shell.request({type: 'deleteDraft', accountId, draftId: model.draftId, revision: model.revision, requestId: key(`delete:${model.draftId}:${model.revision}`)}); if (live.current) {setDirty(false); onBack();}})}>删除草稿</Button></>}><p>删除后无法恢复。已发布版本仍会保留。</p>{error && <InlineNotice title="删除未完成" tone="warning">{error}</InlineNotice>}</Dialog>
  </div>;
}
