import {useEffect, useRef, useState} from 'react';
import {MessageCircle, Upload} from 'lucide-react';
import {communityFailureMessages, newRichMetadataRequestId, recipePublicSchema} from '@vonvon/protocol';
import type {CommunityRequest, CommunityResponses, CommunityShell, RecipeDetail, RecipePublic, RecipeRichDraft} from '@vonvon/protocol';
import {BackButton} from '../BackButton';
import {GlowButton} from '../GlowButton';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {useShellCapabilities} from '../client-context';
import {useDraft, useDraftGuard, type DraftDiscardEligibility} from '../settings/DraftGuard';
import {RecipeDetails, RecipeMarkdown, RecipeMark, type RecipeSection} from './RecipeContent';
import {acceptMetadataSave, beginMetadataSave, editLogo, editMetadata, hasMetadataChanges, metadataBuffer, metadataInput, refreshMetadata, rejectMetadataSave, type LogoInput, type MetadataBuffer} from './metadata-buffer';
import './rich-draft-editor.css';

export type RichDraftContinuationProps = {
  onContinueInChat?: (draft: RecipeRichDraft) => Promise<void> | void;
  chatContinuationUnavailable?: string;
};
type Props = RichDraftContinuationProps & {shell: CommunityShell; accountId: string; draft: RecipeRichDraft; initialRecovery?: CommunityResponses['recoverRichDraftMetadata']; minimumRevision?: number; onBack: () => void; onPublished: (recipe: RecipeDetail & {firstCode?: string}) => void};
type MetadataRequest = Extract<CommunityRequest, {type: 'saveRichDraftMetadata'}>;
type LogoRead = {kind: 'idle'} | {kind: 'reading'; finished: Promise<boolean>};
type SaveOutcome = 'none' | 'current' | 'earlier';
type EditorOperation = 'idle' | 'save' | 'action';
type DraftRefresh = {revision: number; manifestSha256?: string};
type DeleteConfirmation = {kind: 'closed'} | {kind: 'confirming'; draft: RecipeRichDraft; readSequence: number};
async function manifestSha256(canonical: string) {
  const binary = atob(canonical.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function RichRecipeEditor(props: Props) {
  return <RichRecipeEditorSession key={`${props.accountId}:${props.draft.draftId}`} {...props}/>;
}

function RichRecipeEditorSession({shell, accountId, draft: initial, initialRecovery, minimumRevision = 0, onBack, onPublished, onContinueInChat, chatContinuationUnavailable}: Props) {
  const [draft, setDraft] = useState(initial);
  const [buffer, renderBuffer] = useState(() => metadataBuffer(initial.public));
  const bufferRef = useRef(buffer);
  function updateBuffer(next: MetadataBuffer) {bufferRef.current = next; renderBuffer(next);}
  const {publicInfo, logo} = metadataInput(buffer);
  const [editing, setEditing] = useState(false);
  const [section, setSection] = useState<RecipeSection>('概览');
  const [review, setReview] = useState<RecipeRichDraft>();
  const [operation, setOperation] = useState<EditorOperation>('idle');
  const busy = operation !== 'idle';
  const [error, setError] = useState<string>();
  const [remoteNotice, setRemoteNotice] = useState(false);
  const [saved, setSaved] = useState<SaveOutcome>('none');
  const [logoRead, setLogoRead] = useState<LogoRead>({kind: 'idle'});
  const logoReadRef = useRef(logoRead);
  const [uncertain, setUncertain] = useState(false);
  const [recovery, setRecoveryState] = useState<'checking' | 'uncertain' | 'ready'>('checking');
  const recoveryRef = useRef(recovery);
  function setRecovery(next: typeof recovery) {recoveryRef.current = next; setRecoveryState(next);}
  const [refreshNeeded, setRefreshNeededState] = useState<DraftRefresh>();
  const refreshNeededRef = useRef<DraftRefresh | undefined>(undefined);
  function setRefreshNeeded(value: DraftRefresh | undefined) {refreshNeededRef.current = value; setRefreshNeededState(value);}
  const [deleting, setDeleting] = useState<DeleteConfirmation>({kind: 'closed'});
  const live = useRef(true);
  const busyRef = useRef(false);
  const logoSequence = useRef(0);
  const readSequence = useRef(0);
  const requiredRevision = useRef(Math.max(initial.revision, minimumRevision));
  const receiptVerification = useRef<{revision: number; manifestSha256: string} | undefined>(undefined);
  const pendingSave = useRef<MetadataRequest | undefined>(undefined);
  const requestKeys = useRef(new Map<string, string>());
  const draftRef = useRef(draft); draftRef.current = draft;
  const dirty = hasMetadataChanges(buffer) || logoRead.kind === 'reading';
  function hasUnsavedInput() {return hasMetadataChanges(bufferRef.current) || logoReadRef.current.kind === 'reading';}
  const authoring = useShellCapabilities()?.recipeAuthoring;
  const {navigate} = useDraftGuard();
  useEffect(() => {live.current = true; return () => {live.current = false; ++logoSequence.current; ++readSequence.current;};}, []);

  function discard() {
    ++logoSequence.current;
    logoReadRef.current = {kind: 'idle'}; setLogoRead(logoReadRef.current);
    updateBuffer(metadataBuffer(bufferRef.current.baseline));
    setSaved('none'); setRemoteNotice(false); setReview(undefined);
  }
  async function reload(minimum = draftRef.current.revision, expectedHash?: string, supplied?: RecipeRichDraft) {
    const sequence = ++readSequence.current;
    const target = draftRef.current;
    const requestedRevision = minimum;
    minimum = Math.max(minimum, requiredRevision.current, target.revision);
    setRefreshNeeded({revision: minimum, manifestSha256: expectedHash});
    const next = supplied ?? await shell.request({type: 'draft', accountId, draftId: target.draftId});
    if (!live.current || sequence !== readSequence.current) return;
    if (next.format !== 'rich-v2' || next.draftId !== target.draftId || next.revision < minimum) throw new Error('尚未读取到此草稿的新修订，请重新读取。');
    const verification = receiptVerification.current ?? (expectedHash ? {revision: requestedRevision, manifestSha256: expectedHash} : undefined);
    if (verification && next.revision === verification.revision && await manifestSha256(next.rich.canonical) !== verification.manifestSha256) throw new Error('保存后的草稿尚未核对完成，请重新读取。');
    if (!live.current || sequence !== readSequence.current || next.revision < draftRef.current.revision) return;
    receiptVerification.current = undefined;
    draftRef.current = next;
    const rebased = refreshMetadata(bufferRef.current, next.public);
    updateBuffer(rebased); setDraft(next); setReview(undefined); setRefreshNeeded(undefined);
    if (!hasMetadataChanges(rebased)) setRemoteNotice(false);
    else if (next.revision > target.revision) setRemoteNotice(true);
    return next;
  }
  const reloadRef = useRef(reload); reloadRef.current = reload;
  useEffect(() => authoring?.onSaved?.(receipt => {
    if (receipt.accountId !== accountId || receipt.draftId !== initial.draftId || receipt.revision <= draftRef.current.revision) return;
    requiredRevision.current = Math.max(requiredRevision.current, receipt.revision);
    setReview(undefined); setRefreshNeeded({revision: requiredRevision.current});
    void reloadRef.current(receipt.revision).catch(cause => {if (live.current) setError(cause instanceof Error ? cause.message : '新修订尚未读取。');});
  }), [authoring, accountId, initial.draftId]);

  async function reconcile(loaded?: CommunityResponses['recoverRichDraftMetadata']): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true; setOperation('action'); setRecovery('checking'); setError(undefined);
    try {
      const result = loaded ?? await shell.request({type: 'recoverRichDraftMetadata', accountId, draftId: initial.draftId});
      if (!live.current) return false;
      if (result.status === 'uncertain') {setRecovery('uncertain'); setError('此前保存尚未核对完成。可以稍后回来继续核对，已提交的保存不会因离开而取消。'); return false;}
      if (result.status === 'committed') {
        if (result.receipt.draftId !== initial.draftId) throw new Error('保存回执与草稿不匹配，请重试核对。');
        requiredRevision.current = Math.max(requiredRevision.current, result.receipt.revision);
        receiptVerification.current = result.receipt;
        setSaved('current'); setRefreshNeeded(result.receipt);
      }
      const fresh = await reload(requiredRevision.current, result.status === 'committed' ? result.receipt.manifestSha256 : undefined,
        result.status === 'current' ? result.draft : result.status === 'committed' ? result.draft : undefined);
      if (!live.current) return false;
      if (!fresh) {setRecovery('uncertain'); return false;}
      setRecovery('ready');
      if (result.status === 'rejected') setError(communityFailureMessages[result.code]);
      return true;
    } catch (cause) {
      if (live.current) {setRecovery('uncertain'); setError(cause instanceof Error ? cause.message : '草稿尚未核对完成，请重试。');}
      return false;
    } finally {busyRef.current = false; if (live.current) setOperation('idle');}
  }
  useEffect(() => {void reconcile(initialRecovery);}, []);

  async function save(): Promise<boolean> {
    if (busyRef.current) return false;
    if (recoveryRef.current !== 'ready') return reconcile();
    if (refreshNeededRef.current && !pendingSave.current) {setError('草稿尚未核对，请先重新读取，再继续保存。'); return false;}
    busyRef.current = true; setOperation('save'); setError(undefined); setSaved('none');
    try {
      const image = logoReadRef.current;
      if (image.kind === 'reading' && !await image.finished) return false;
      if (!live.current) return false;
      if (!pendingSave.current && !hasUnsavedInput()) {setEditing(false); return true;}
      if (!pendingSave.current && !recipePublicSchema.safeParse(metadataInput(bufferRef.current).publicInfo).success) {setError('请检查发布信息。名称最多 60 字、简介 240 字、版本 40 字，概览不超过 32 KiB。'); return false;}
      if (!pendingSave.current) {
        const base = draftRef.current;
        const input = metadataInput(bufferRef.current);
        updateBuffer(beginMetadataSave(bufferRef.current));
        const hash = await manifestSha256(base.rich.canonical);
        if (!live.current) return false;
        if (draftRef.current !== base) {setError('云端已有新修订，请核对当前输入后重新保存。'); return false;}
        const request: MetadataRequest = {type: 'saveRichDraftMetadata', accountId, requestId: newRichMetadataRequestId(), draftId: base.draftId, revision: base.revision, baseManifestSha256: hash, public: input.publicInfo,
          logo: input.logo.kind === 'replace' ? {kind: 'replace', base64: input.logo.base64} : input.logo};
        pendingSave.current = request;
      }
      const pending = pendingSave.current;
      const result = await shell.request(pending);
      if (!live.current) return false;
      if (result.status === 'uncertain') {setUncertain(true); setError('保存结果尚未确认。修改仍保留，请重试核对同一次保存。'); return false;}
      if (result.status === 'rejected') {pendingSave.current = undefined; updateBuffer(rejectMetadataSave(bufferRef.current)); setUncertain(false); setError(communityFailureMessages[result.code]); return false;}
      if (result.receipt.requestId !== pending.requestId || result.receipt.draftId !== pending.draftId || result.receipt.revision !== pending.revision + 1) {setUncertain(true); setError('保存回执尚未与本次修改匹配。输入仍保留，请重试核对。'); return false;}
      pendingSave.current = undefined; setUncertain(false);
      updateBuffer(acceptMetadataSave(bufferRef.current, result.receipt.revision >= draftRef.current.revision ? pending.public : draftRef.current.public));
      requiredRevision.current = Math.max(requiredRevision.current, result.receipt.revision);
      receiptVerification.current = result.receipt;
      setSaved(hasUnsavedInput() ? 'earlier' : 'current'); setReview(undefined); setRefreshNeeded(result.receipt);
      try {
        const fresh = await reload(result.receipt.revision, result.receipt.manifestSha256, result.draft);
        if (fresh && !hasUnsavedInput()) setEditing(false);
      } catch {if (live.current) setError('修改已保存，最新草稿尚未读取。请重新读取后再预览发布。');}
      const currentSaved = !hasUnsavedInput();
      setSaved(currentSaved ? 'current' : 'earlier');
      return currentSaved;
    } catch (cause) {
      if (live.current) {setUncertain(Boolean(pendingSave.current)); setError(cause instanceof Error ? cause.message : '保存结果尚未确认，请重试。');}
      return false;
    } finally {
      if (live.current && !pendingSave.current && bufferRef.current.submitted) updateBuffer(rejectMetadataSave(bufferRef.current));
      busyRef.current = false; if (live.current) setOperation('idle');
    }
  }
  function discardEligibility(): DraftDiscardEligibility {
    if (busyRef.current) return {kind: 'blocked', reason: '正在处理保存，请完成后再离开。'};
    return {kind: 'allowed'};
  }
  const awaitingRecovery = recovery !== 'ready';
  const pendingDescription = uncertain || awaitingRecovery ? '已提交的保存不会因离开而取消。未提交的新输入将放弃；稍后重新打开此草稿可继续核对保存结果。' : undefined;
  useDraft(dirty || uncertain || awaitingRecovery || operation === 'save', {title: '配方发布信息', save, discard, discardEligibility, leaveDescription: pendingDescription, leaveLabel: pendingDescription ? '稍后核对并离开' : undefined});
  async function run(action: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true; setOperation('action'); setError(undefined);
    try {await action();} catch (cause) {if (live.current) setError(cause instanceof Error ? cause.message : '操作尚未完成。');}
    finally {busyRef.current = false; if (live.current) setOperation('idle');}
  }
  function chooseLogo(file?: File) {
    if (!file) return;
    if (file.size > 2097152 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {setError('请选择不超过 2 MiB 的 PNG、JPEG 或 WebP 图片。'); return;}
    const sequence = ++logoSequence.current;
    setReview(undefined); setSaved('none'); setError(undefined);
    const finished = (async () => {
      try {
        await Promise.resolve();
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!live.current || sequence !== logoSequence.current) return false;
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        const base64 = btoa(binary);
        const next: LogoInput = {kind: 'replace', base64, preview: `data:${file.type};base64,${base64}`};
        updateBuffer(editLogo(bufferRef.current, next));
        return true;
      } catch {
        if (live.current && sequence === logoSequence.current) setError('图片尚未读取，请重新选择。');
        return false;
      } finally {
        if (live.current && sequence === logoSequence.current) {
          logoReadRef.current = {kind: 'idle'}; setLogoRead(logoReadRef.current);
        }
      }
    })();
    logoReadRef.current = {kind: 'reading', finished}; setLogoRead(logoReadRef.current);
  }
  function meta<K extends keyof RecipePublic>(key: K, value: RecipePublic[K]) {
    updateBuffer(editMetadata(bufferRef.current, key, value)); setReview(undefined); setSaved('none');
  }
  const previewLogo = logo.kind === 'remove' ? undefined : logo.kind === 'replace' ? logo.preview : draft.logo;
  const hasLogo = logo.kind === 'replace' || logo.kind === 'keep' && Boolean(draft.logo || draft.rich.content.finalLogo);
  const detail: RecipeDetail = {recipeId: draft.recipeId ?? draft.draftId, versionId: draft.draftId, revision: draft.revision, public: draft.public, owned: true, acquired: false, format: 'rich-v2', rich: draft.rich, logo: draft.logo};
  const key = (action: string, revision = draft.revision) => {const name = `${action}:${revision}`; const existing = requestKeys.current.get(name); if (existing) return existing; const next = crypto.randomUUID(); requestKeys.current.set(name, next); return next;};
  const deleteTarget = deleting.kind === 'confirming' ? deleting.draft : undefined;
  const deleteEligible = () => Boolean(deleting.kind === 'confirming' && deleting.readSequence === readSequence.current && deleteTarget && deleteTarget === draftRef.current && deleteTarget.revision >= requiredRevision.current && !busyRef.current && !pendingSave.current && !receiptVerification.current && !refreshNeededRef.current);
  const blocked = busy || dirty || uncertain || awaitingRecovery || Boolean(refreshNeeded);
  const heading = <header className="community-detail-heading rich-draft-heading"><RecipeMark name={draft.public.name} logo={draft.logo}/><div><h1>{draft.public.name || '未命名配方'}</h1><p>配方草稿</p></div><div className="community-actions"><Button disabled={busy || awaitingRecovery} onClick={() => {if (editing) void save(); else {setSection('概览'); setEditing(true);}}}>{editing ? '完成编辑' : '编辑发布信息'}</Button><GlowButton disabled={blocked} variant="dark" onClick={() => void run(async () => {const current = await reload(); if (live.current && current && !hasUnsavedInput()) setReview(current);})}>预览发布</GlowButton></div></header>;
  const metadata = <form className="rich-draft-metadata" onSubmit={event => {event.preventDefault(); void save();}}>
    <p className="rich-draft-help">以下 Logo、名称、简介和概览会向所有人公开，包括没有分享码的访客。</p>
    <div className="rich-draft-logo"><RecipeMark name={publicInfo.name} logo={previewLogo}/><div><strong>配方 Logo <span>选填</span></strong><div className="community-actions"><label className="rich-draft-upload"><Upload size={14}/>选择图片<input aria-label="上传配方 Logo" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || uncertain} onChange={event => {void chooseLogo(event.target.files?.[0]); event.target.value = '';}}/></label>{hasLogo && <Button type="button" variant="ghost" disabled={busy || uncertain} onClick={() => {++logoSequence.current; logoReadRef.current = {kind: 'idle'}; setLogoRead(logoReadRef.current); const next: LogoInput = draft.logo || draft.rich.content.finalLogo ? {kind: 'remove'} : {kind: 'keep'}; updateBuffer(editLogo(bufferRef.current, next)); setReview(undefined); setSaved('none');}}>移除</Button>}</div><small>PNG、JPG 或 WebP，最大 2 MB。图片将居中裁成正方形。</small></div></div>
    <fieldset disabled={uncertain || Boolean(refreshNeeded)}><div className="rich-draft-fields"><label>配方名称<input aria-label="配方名称" value={publicInfo.name} maxLength={120} onChange={event => meta('name', event.target.value)}/></label><label>版本<input aria-label="版本" value={publicInfo.version} maxLength={80} onChange={event => meta('version', event.target.value)}/></label></div>
      <label>一句话简介<input aria-label="公开简介" value={publicInfo.summary} maxLength={480} onChange={event => meta('summary', event.target.value)}/></label>
      <label>概览正文（选填，支持 Markdown）<textarea aria-label="公开概览" value={publicInfo.overview} rows={8} onChange={event => meta('overview', event.target.value)}/></label><details className="rich-draft-markdown-preview"><summary>预览正文</summary><RecipeMarkdown text={publicInfo.overview}/></details>
      <label className="rich-draft-access">获取方式<select aria-label="获取方式" value={publicInfo.access} onChange={event => meta('access', event.target.value === 'coded' ? 'coded' : 'direct')}><option value="direct">直接获取</option><option value="coded">凭分享码获取</option></select></label>{publicInfo.access === 'coded' && <p className="rich-draft-help">发布后会生成一个一次性分享码，可在「管理分享码」中追加。</p>}
    </fieldset><div className="rich-draft-save"><Button type="button" disabled={busy || uncertain} onClick={() => {discard(); setEditing(false);}}>取消</Button><GlowButton type="submit" variant="dark" disabled={busy || Boolean(refreshNeeded) && !uncertain}>{busy ? '正在保存…' : uncertain ? '重试保存' : '保存'}</GlowButton></div>
  </form>;
  const continuation = <div className="rich-draft-continuation"><Button disabled={blocked || !onContinueInChat || Boolean(chatContinuationUnavailable)} onClick={() => void run(async () => {await onContinueInChat?.(draftRef.current);})}><MessageCircle size={15}/>在飞书私聊中修改</Button>{(chatContinuationUnavailable || !onContinueInChat) && <p>{chatContinuationUnavailable ?? '此草稿的来源暂不可用，仍可在这里编辑发布信息。'}</p>}{dirty && <p>先保存发布信息，再继续修改群聊配置。</p>}</div>;
  return <div className="community-page rich-draft-page" aria-busy={busy}><BackButton onClick={() => navigate(onBack)} label="返回创作中心"/>
    {awaitingRecovery && <InlineNotice title={saved === 'current' ? '发布信息已保存，正在核对草稿' : '核对此前保存'} actions={<Button disabled={busy} onClick={() => void reconcile()}>重试核对保存</Button>}>{recovery === 'checking' ? '正在读取草稿并核对本机记录的保存结果…' : '核对完成后可编辑或发布。可以先离开，稍后重新打开此草稿继续核对。'}{error && <> {error}</>}</InlineNotice>}
    {error && !awaitingRecovery && <InlineNotice tone="warning" title={saved === 'current' ? '发布信息已保存' : saved === 'earlier' ? '先前提交已保存，当前输入仍未保存' : '草稿操作未完成'} actions={<Button disabled={busy} onClick={() => void run(() => reload(refreshNeeded?.revision, refreshNeeded?.manifestSha256))}>重新读取</Button>}>{error}</InlineNotice>}
    {remoteNotice && <InlineNotice title="云端已有新修订" actions={<Button disabled={busy || uncertain} onClick={discard}>采用已保存版本</Button>}>你的未保存输入仍保留，请核对后再保存。</InlineNotice>}
    {saved !== 'none' && !error && <p className="rich-draft-status" role="status">{saved === 'current' ? '发布信息已保存' : '先前提交已保存，当前输入仍未保存'}</p>}
    <RecipeDetails draft recipe={detail} heading={heading} section={section} onSectionChange={setSection} overview={editing ? metadata : undefined} overviewFooter={continuation}/>
    <div className="rich-draft-delete"><Button variant="ghost" disabled={busy || uncertain || awaitingRecovery || Boolean(refreshNeeded)} onClick={() => setDeleting({kind: 'confirming', draft: draftRef.current, readSequence: readSequence.current})}>删除草稿</Button></div>
    <Dialog open={Boolean(review)} title="确认发布到社区" size="lg" onClose={busy ? undefined : () => setReview(undefined)} footer={<><Button disabled={busy} onClick={() => setReview(undefined)}>继续编辑</Button><GlowButton variant="dark" disabled={blocked || review?.revision !== draft.revision} onClick={() => void run(async () => {if (!review) return; const result = await shell.request({type: 'publishDraft', format: 'rich-v2', canonical: review.rich.canonical, accountId, draftId: review.draftId, revision: review.revision, requestId: key('publish')}); if (live.current) onPublished({...result, owned: true, acquired: false, rich: review.rich});})}>发布到社区</GlowButton></>}>{review && <><p>发布后此版本内容固定。请再次核对对外介绍与全部配置。</p><RecipeDetails draft recipe={{...detail, revision: review.revision, public: review.public, rich: review.rich, logo: review.logo}}/></>}{error && <InlineNotice title="发布未完成" tone="warning">{error}</InlineNotice>}</Dialog>
    <Dialog open={deleting.kind === 'confirming'} title="删除私人草稿" onClose={busy ? undefined : () => setDeleting({kind: 'closed'})} footer={<><Button disabled={busy} onClick={() => setDeleting({kind: 'closed'})}>保留</Button><Button disabled={!deleteEligible()} onClick={() => {
      if (!deleteEligible() || !deleteTarget) return;
      void run(async () => {await shell.request({type: 'deleteDraft', accountId, draftId: deleteTarget.draftId, revision: deleteTarget.revision, requestId: key('delete', deleteTarget.revision)}); if (live.current) {discard(); onBack();}});
    }}>删除草稿</Button></>}><p>删除后无法恢复，已发布版本仍保留。</p>{deleteTarget && !busy && !deleteEligible() && <p>草稿需要重新核对，请读取最新内容后，重新确认删除。</p>}</Dialog>
  </div>;
}
