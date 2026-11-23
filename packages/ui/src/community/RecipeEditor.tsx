import {BackButton} from '../BackButton';
import {GlowButton} from '../GlowButton';
import {RichRecipeEditor} from './RichRecipeEditor';
import {useEffect, useReducer, useRef, useState} from 'react';
import {communityFailureMessages, recipePublicSchema, recipeConfigSchema} from '@vonvon/protocol';
import type {CommunityRequest, CommunityShell, RecipeConfig, RecipeDetail, RecipeDraft, RecipeRoleDraft, RecipePublic} from '@vonvon/protocol';
import {Button, InlineNotice} from '../reference/components/ui';
import {useShellCapabilities} from '../client-context';
import {Dialog} from '../reference/components/ui/Dialog';
import {useDraft, useDraftGuard} from '../settings/DraftGuard';
import {RecipeAuthoringPage} from './authoring/RecipeAuthoring';
import {RecipeConfiguration, RecipeDetails, RecipeOverview} from './RecipeContent';

const blank: {public: RecipePublic; config: RecipeConfig} = {public: {name: '', summary: '', overview: '', version: '1.0', access: 'direct'}, config: {role: ''}};
type DraftContents = Pick<RecipeRoleDraft, 'public' | 'config'>;
type DraftRead = {id: number; draftId: string; baseRevision: number; bufferRevision: number; minimumRevision: number; kind: 'chat' | 'conflict'} & ({status: 'loading'} | {status: 'failed'; error: string});
type EditorDraft = {
  model?: RecipeRoleDraft; contents: DraftContents; bufferRevision: number; dirty: boolean; saved: boolean;
  error?: string; review?: RecipeRoleDraft; latest?: RecipeRoleDraft; remoteUpdate?: RecipeRoleDraft; read?: DraftRead;
};
type DraftAction =
  | {type: 'loaded'; draft: RecipeRoleDraft}
  | {type: 'public'; patch: Partial<RecipePublic>}
  | {type: 'config'; patch: Partial<RecipeConfig>}
  | {type: 'removeLegacyNotes'}
  | {type: 'error'; message?: string}
  | {type: 'discard'}
  | {type: 'saveBase'; draft: RecipeRoleDraft}
  | {type: 'saved'; draft: RecipeRoleDraft; bufferRevision: number}
  | {type: 'review'; draft?: RecipeRoleDraft}
  | {type: 'latest'; draft?: RecipeRoleDraft}
  | {type: 'rebase'}
  | {type: 'readStarted'; id: number; draftId: string; minimumRevision: number; kind: DraftRead['kind']}
  | {type: 'readResolved'; id: number; draft: RecipeRoleDraft}
  | {type: 'readFailed'; id: number; message: string};
function editorDraft(state: EditorDraft, action: DraftAction): EditorDraft {
  switch (action.type) {
    case 'loaded': return {...state, model: action.draft, contents: {public: action.draft.public, config: action.draft.config}, bufferRevision: state.bufferRevision + 1};
    case 'public': return {...state, contents: {...state.contents, public: {...state.contents.public, ...action.patch}}, bufferRevision: state.bufferRevision + 1, dirty: true, saved: false, review: undefined};
    case 'config': return {...state, contents: {...state.contents, config: {...state.contents.config, ...action.patch}}, bufferRevision: state.bufferRevision + 1, dirty: true, saved: false, review: undefined};
    case 'removeLegacyNotes': {
      const {setup: _setup, ...config} = state.contents.config;
      return {...state, contents: {...state.contents, config}, bufferRevision: state.bufferRevision + 1, dirty: true, saved: false, review: undefined};
    }
    case 'error': return {...state, error: action.message};
    case 'discard': return {...state, dirty: false, bufferRevision: state.bufferRevision + 1};
    case 'saveBase': case 'saved': {
      const next = action.draft;
      if (state.model && (next.draftId !== state.model.draftId || next.revision < state.model.revision)) return state;
      const unchanged = action.type === 'saved' && action.bufferRevision === state.bufferRevision;
      const read = state.read && state.read.minimumRevision > next.revision ? {...state.read, status: 'failed' as const, error: '云端还有更新，请重新读取。'} : undefined;
      return {...state, model: next, ...(unchanged ? {contents: {public: next.public, config: next.config}, dirty: false, saved: true, bufferRevision: state.bufferRevision + 1} : {}),
        read, error: undefined, review: undefined, latest: undefined, remoteUpdate: state.remoteUpdate && state.remoteUpdate.revision > next.revision ? state.remoteUpdate : undefined};
    }
    case 'review': {
      if (!action.draft) return {...state, review: undefined};
      if (state.dirty || action.draft.draftId !== state.model?.draftId || action.draft.revision !== state.model.revision || (state.read?.minimumRevision ?? 0) > action.draft.revision || (state.remoteUpdate?.revision ?? 0) > action.draft.revision) return {...state, error: '云端有新修订或本地输入尚未保存，请先核对后再预览发布。'};
      return {...state, review: action.draft};
    }
    case 'latest': return action.draft && (action.draft.draftId !== state.model?.draftId || action.draft.revision < state.model.revision) ? state : {...state, latest: action.draft, remoteUpdate: action.draft ? undefined : state.remoteUpdate};
    case 'rebase': return state.latest ? {...state, model: state.latest, latest: undefined, remoteUpdate: undefined, read: undefined, error: undefined, review: undefined, dirty: true, saved: false, bufferRevision: state.bufferRevision + 1} : state;
    case 'readStarted': {
      if (!state.model || action.draftId !== state.model.draftId || action.kind === 'chat' && action.minimumRevision <= state.model.revision) return state;
      return {...state, read: {id: action.id, draftId: action.draftId, baseRevision: state.model.revision, bufferRevision: state.bufferRevision,
        minimumRevision: Math.max(action.minimumRevision, state.read?.minimumRevision ?? 0, state.remoteUpdate?.revision ?? 0), kind: action.kind, status: 'loading'}, review: undefined};
    }
    case 'readResolved': case 'readFailed': {
      const read = state.read;
      if (!read || read.id !== action.id || state.model?.draftId !== read.draftId || state.model.revision !== read.baseRevision) return state;
      if (action.type === 'readFailed') return {...state, read: {...read, status: 'failed', error: action.message}};
      const next = action.draft;
      if (next.draftId !== read.draftId || next.revision < read.minimumRevision) return {...state, read: {...read, status: 'failed', error: '尚未读取到目标草稿的新修订，请重新读取。'}};
      if (read.kind === 'conflict') return {...state, read: undefined, latest: next, remoteUpdate: undefined, error: undefined};
      if (state.dirty || state.bufferRevision !== read.bufferRevision) return {...state, read: undefined, remoteUpdate: next};
      return {...state, model: next, contents: {public: next.public, config: next.config}, bufferRevision: state.bufferRevision + 1, read: undefined, remoteUpdate: undefined, latest: undefined, error: undefined, saved: true};
    }
  }
}
export function RecipeEditor(props: Parameters<typeof RoleRecipeEditor>[0]) {
  const [read, setRead] = useState<RecipeDraft>();
  const [error, setError] = useState<string>();
  const [retry,setRetry]=useState(0);
  useEffect(() => {if (!props.draftId) return; let active=true; void props.shell.request({type:'draft',accountId:props.accountId,draftId:props.draftId}).then(value => {if(active)setRead(value);},e => {if(active)setError(e instanceof Error?e.message:'草稿读取失败。');}); return () => {active=false;};},[props.shell,props.accountId,props.draftId,retry]);
  if (props.draftId && !read) return <><p role="status">{error ?? '正在读取私人草稿…'}</p>{error&&<Button onClick={()=>{setError(undefined);setRetry(value=>value+1);}}>重试读取</Button>}<BackButton onClick={props.onBack} label="返回创作中心"/></>;
  if (read?.format==='rich-v2') return <RichRecipeEditor {...props} draft={read}/>;
  if (props.source?.format === 'rich-v2') return <><InlineNotice title="从来源群准备新版">请回到已应用此配方的群，核对本地来源并准备新版。富配方不会转换成仅角色草稿。</InlineNotice><BackButton onClick={props.onBack} label="返回创作中心"/></>;
  return <RoleRecipeEditor {...props} initialDraft={read}/>;
}
function RoleRecipeEditor({shell, accountId, draftId, source, onBack, onPublished, initialDraft}: {
  shell: CommunityShell; accountId: string; draftId?: string; source?: RecipeDetail; initialDraft?: RecipeRoleDraft; onBack: () => void; onPublished: (recipe: RecipeDetail & {firstCode?: string}) => void;
}) {
  const sourceAllowed = !source || source.owned || source.public.access === 'direct';
  const [{model, contents, bufferRevision, dirty, saved, error, review, latest, remoteUpdate, read}, dispatch] = useReducer(editorDraft, undefined, (): EditorDraft => ({
    model: initialDraft,
    contents: initialDraft ? {public:initialDraft.public,config:initialDraft.config} : source ? {public: {...source.public, summary: source.public.summary ?? '', overview: source.public.overview ?? '', version: ''}, config: source.config ?? blank.config} : blank,
    bufferRevision: 0, dirty: Boolean(source), saved: false,
  }));
  const [editing, setEditing] = useState(!draftId);
  const [loading, setLoading] = useState(Boolean(draftId && !initialDraft));
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const keys = useRef(new Map<string, string>());
  const pendingSave = useRef<Extract<CommunityRequest, {type: 'saveDraft'}> | undefined>(undefined);
  const live = useRef(true);
  const readSequence = useRef(0);
  const setError = (message?: string) => dispatch({type: 'error', message});
  const {navigate} = useDraftGuard();
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  useEffect(() => {
    if (!draftId || initialDraft) return;
    let active = true;
    void shell.request({type: 'draft', accountId, draftId}).then(value => {
      if (!active) return;if(value.format==='rich-v2'){setError('草稿格式已变化，请重新打开。');setLoading(false);return;} dispatch({type: 'loaded', draft: value}); setLoading(false);
    }, e => {if (active) {setError(e instanceof Error ? e.message : '草稿读取失败。'); setLoading(false);}});
    return () => {active = false;};
  }, [shell, accountId, draftId]);
  const key = (logical: string) => {if (!keys.current.has(logical)) keys.current.set(logical, crypto.randomUUID()); return keys.current.get(logical)!;};
  const changePublic = (patch: Partial<RecipePublic>) => dispatch({type: 'public', patch});
  const changeConfig = (patch: Partial<RecipeConfig>) => dispatch({type: 'config', patch});
  async function save(): Promise<RecipeRoleDraft | undefined> {
    if (!sourceAllowed) {setError('其他作者的受限配方不能改编或重新发布。请分享原版本链接。'); return;}
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
      if (JSON.stringify({public: request.public, config: request.config}) !== JSON.stringify(contents)) {
        dispatch({type: 'saveBase', draft: next});
        const followup = {type: 'saveDraft' as const, accountId, requestId: key('save:' + next.draftId + ':' + next.revision + ':' + JSON.stringify(contents)), target: {kind: 'existing' as const, draftId: next.draftId, revision: next.revision}, ...contents};
        pendingSave.current = followup;
        next = await shell.request(followup);
        if (!live.current) return;
        pendingSave.current = undefined;
      }
      dispatch({type: 'saved', draft: next, bufferRevision}); return next;
    } catch (e) {if (e instanceof Error && (Object.values(communityFailureMessages) as string[]).includes(e.message)) pendingSave.current = undefined; if (live.current) setError(e instanceof Error ? e.message : '保存未完成，输入仍保留。');}
  }
  useDraft(dirty, {title: '配方草稿', save: async () => Boolean(await save()), discard: () => dispatch({type: 'discard'})});
  async function run(action: () => Promise<void>) {if (busy) return; setBusy(true); try {await action();} catch (e) {if (live.current) setError(e instanceof Error ? e.message : '操作未完成。');} finally {if (live.current) setBusy(false);}}
  async function preparePublish() {
    if (!contents.public.name.trim() || !contents.public.summary.trim() || !contents.public.version.trim()) {setError('先填写名称、简介和版本，再预览发布。'); return;}
    const next = await save(); if (next) dispatch({type: 'review', draft: next});
  }
  async function publish() {
    if (!review) return;
    const result = await shell.request({type: 'publishDraft', accountId, draftId: review.draftId, revision: review.revision, requestId: key(`publish:${review.draftId}:${review.revision}`)});
    if (!live.current) return;
    dispatch({type: 'discard'}); dispatch({type: 'review'});
    onPublished({...result, owned: true, acquired: false, config: review.config});
  }
  async function readDraft(id: string, minimumRevision: number, kind: DraftRead['kind']) {
    if (!live.current || !model || model.draftId !== id || kind === 'chat' && minimumRevision <= model.revision) return;
    const request = ++readSequence.current;
    dispatch({type: 'readStarted', id: request, draftId: id, minimumRevision, kind});
    try {
      const next = await shell.request({type: 'draft', accountId, draftId: id});
      if(next.format==='rich-v2')throw new Error('草稿格式已变化，请重新打开。');
      if (live.current) dispatch({type: 'readResolved', id: request, draft: next});
    } catch (e) {if (live.current) dispatch({type: 'readFailed', id: request, message: e instanceof Error ? e.message : '草稿读取失败。'});}
  }
  const authoringShell = useShellCapabilities()?.recipeAuthoring;
  const readRef = useRef(readDraft); readRef.current = readDraft;
  useEffect(() => authoringShell?.onSaved?.(receipt => {
    if (receipt.accountId === accountId && receipt.draftId === draftId && !chatOpen) void readRef.current(receipt.draftId,receipt.revision,'chat');
  }), [authoringShell,accountId,draftId,chatOpen]);
  const chat = model && <section className="authoring-draft-panel"><div className="community-actions"><Button onClick={() => setChatOpen(value => !value)}>{chatOpen ? '收起聊天设置' : '在飞书继续编辑'}</Button><span className="community-muted">修订 {model.revision} · 与飞书共享同一份私人草稿</span></div>
    {read && <InlineNotice title={read.status === 'loading' ? '正在读取最新草稿' : read.minimumRevision > model.revision ? '云端已保存，但 App 尚未读取最新修订' : '草稿读取未完成'} tone={read.status === 'failed' ? 'warning' : 'info'} actions={read.status === 'failed' && <Button onClick={() => void readDraft(read.draftId, read.minimumRevision, read.kind)}>重新读取新修订</Button>}>
      当前显示修订 {model.revision}。{read.minimumRevision > model.revision && <>云端已保存修订 {read.minimumRevision}。</>}{dirty && '你的未保存输入仍保留。'}{read.status === 'failed' && <p>{read.error}</p>}
    </InlineNotice>}
    {remoteUpdate && <InlineNotice title="飞书已保存新修订" actions={<Button onClick={() => dispatch({type: 'latest', draft: remoteUpdate})}>核对新修订</Button>}>云端已有修订 {remoteUpdate.revision}。当前显示修订 {model.revision}。{dirty ? '你的未保存输入仍保留，请核对后再保存。' : '本地内容仍保留，请核对云端内容后继续。'}</InlineNotice>}
    {chatOpen && <RecipeAuthoringPage draft={{draftId:model.draftId,revision:model.revision}} onSaved={(id,revision) => void readDraft(id,revision,'chat')}/>}
  </section>;
  if (loading) return <p role="status">正在读取私人草稿…</p>;
  if (draftId && !model) return <><InlineNotice title="草稿读取未完成" tone="warning">{error}</InlineNotice><BackButton onClick={onBack} label="返回创作中心"/></>;
  if (!editing && model) return <div className="community-page"><div className="community-actions"><BackButton onClick={onBack} label="返回创作中心"/><GlowButton variant="dark" onClick={() => setEditing(true)}>编辑草稿</GlowButton></div><p className="community-muted">私人草稿 · 仅自己可见</p><RecipeDetails draft recipe={{recipeId: model.recipeId ?? model.draftId, versionId: model.draftId, revision: model.revision, public: model.public, config: model.config, owned: true, acquired: false}}/>{chat}</div>;
  return <div className="community-page"><div className="community-heading"><div><h1>{contents.public.name || '新建私人草稿'}</h1><p>先审核配置，再填写发布信息。保存草稿不会公开。</p></div><div className="community-actions"><BackButton label="返回创作中心" onClick={() => navigate(onBack)}/>{model && <Button disabled={busy} onClick={() => setDeleting(true)}>删除草稿</Button>}</div></div>
    {error && <InlineNotice title="操作未完成" tone="warning" actions={model && <Button disabled={busy} onClick={() => void readDraft(model.draftId, model.revision, 'conflict')}>读取最新草稿</Button>}>{error}</InlineNotice>}{saved && <p role="status" className="community-muted">私人草稿已保存 · 修订 {model?.revision}</p>}
    {source && <InlineNotice title="基于已有配方准备新草稿">来源：{source.public.name} · {source.public.version}。来源关系会保留；请核对你拥有分享权的内容。{!sourceAllowed && '其他作者的受限内容不能重新发布。'}</InlineNotice>}
    <form className="community-editor" onSubmit={event => {event.preventDefault(); void run(async () => {await save();});}}>
      <fieldset disabled={busy}><legend>发布信息</legend><label>名称<input aria-label="配方名称" value={contents.public.name} onChange={event => changePublic({name: event.target.value})}/></label><label>公开简介<textarea aria-label="公开简介" value={contents.public.summary} rows={3} onChange={event => changePublic({summary: event.target.value})}/></label>
        <div className="community-editor-grid"><label>版本<input aria-label="版本" value={contents.public.version} onChange={event => changePublic({version: event.target.value})}/></label><label>获取方式<select aria-label="获取方式" value={contents.public.access} onChange={event => changePublic({access: event.target.value as RecipePublic['access']})}><option value="direct">直接获取</option><option value="coded">凭分享码获取</option></select></label></div>
        <label>公开概览 · Markdown<textarea aria-label="公开概览" value={contents.public.overview} maxLength={32768} onChange={event => changePublic({overview: event.target.value})}/><small className="community-muted">有依赖或需要先运行的技能时，请在介绍中说明。</small></label>
      </fieldset>
      <fieldset disabled={busy}><legend>角色与规则</legend><p className="community-muted">{contents.public.access === 'coded' ? '仅作者与已获取此版本的人可见。' : '这些配置将在社区公开展示。'}请移除凭据、主机路径和私人内容。</p><label>角色与规则<textarea aria-label="角色与规则" value={contents.config.role} maxLength={16384} onChange={event => changeConfig({role: event.target.value})}/></label></fieldset>
      {Boolean(contents.config.setup?.steps.length) && <details className="community-additional-notes"><summary>补充说明</summary>{contents.config.setup!.steps.map((note, index) => <article key={index}><h3>{note.title || `说明 ${index + 1}`}</h3><p>{note.instructions}</p>{note.check && <p>核对方式：{note.check}</p>}</article>)}<Button type="button" disabled={busy} onClick={() => dispatch({type: 'removeLegacyNotes'})}>移除旧补充说明</Button><p className="community-muted">保存后生效，已发布版本不受影响。</p></details>}

      <div className="community-actions"><Button type="submit" disabled={busy || !sourceAllowed}>保存私人草稿</Button><GlowButton type="button" variant="dark" disabled={busy || !sourceAllowed} onClick={() => void run(preparePublish)}>预览发布</GlowButton></div>
    </form>
    {chat}
    <Dialog open={Boolean(latest)} title="核对最新草稿" size="lg" onClose={() => dispatch({type: 'latest'})} footer={<><Button onClick={() => dispatch({type: 'latest'})}>继续核对</Button><GlowButton variant="dark" onClick={() => {pendingSave.current = undefined; dispatch({type: 'rebase'});}}>保留当前输入，使用此修订继续编辑</GlowButton></>}>
      <p>下面是云端最新保存的内容。你的未保存输入仍保留。确认后，再点击保存才会更新这份草稿。</p>{latest && <><h2>{latest.public.name}</h2><p>{latest.public.summary}</p><RecipeOverview recipe={latest}/><RecipeConfiguration config={latest.config} section="能力"/></>}
    </Dialog>
    <Dialog open={Boolean(review)} title="确认发布到社区" size="lg" onClose={busy ? undefined : () => dispatch({type: 'review'})} footer={<><Button disabled={busy} onClick={() => dispatch({type: 'review'})}>继续编辑</Button><GlowButton variant="dark" disabled={busy} onClick={() => void run(publish)}>发布到社区</GlowButton></>}>
      {error && <InlineNotice title="发布未完成" tone="warning">{error}</InlineNotice>}
      {review && <><h2>{review.public.name}</h2><p>{review.public.summary}</p><RecipeOverview recipe={review}/><RecipeConfiguration config={review.config} section="能力"/></>}
    </Dialog>
    <Dialog open={deleting} title="删除私人草稿" onClose={busy ? undefined : () => setDeleting(false)} footer={<><Button onClick={() => setDeleting(false)} disabled={busy}>保留草稿</Button><Button disabled={busy} onClick={() => void run(async () => {if (!model) return; await shell.request({type: 'deleteDraft', accountId, draftId: model.draftId, revision: model.revision, requestId: key(`delete:${model.draftId}:${model.revision}`)}); if (live.current) {dispatch({type: 'discard'}); onBack();}})}>删除草稿</Button></>}><p>删除后无法恢复。已发布版本仍会保留。</p>{error && <InlineNotice title="删除未完成" tone="warning">{error}</InlineNotice>}</Dialog>
  </div>;
}
