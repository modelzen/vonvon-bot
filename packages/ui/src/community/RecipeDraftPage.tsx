import {useEffect, useRef, useState} from 'react';
import type {AuthoringPublished, CommunityShell, RecipeDraft} from '@vonvon/protocol';
import {BackButton} from '../BackButton';
import {GlowButton} from '../GlowButton';
import {useShellCapabilities} from '../client-context';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {RecipeDetails, RecipeMark} from './RecipeContent';
import './recipe-draft.css';

type Props = {
  shell: CommunityShell;
  accountId: string;
  draftId: string;
  expectedRevision?: number;
  onBack: () => void;
  onContinueInChat?: (draft: RecipeDraft) => void;
};
type Read = {kind: 'loading'} | {kind: 'ready'; draft: RecipeDraft} | {kind: 'failed'; message: string; draft?: RecipeDraft};
type Confirmation = {reviewId: string; draft: RecipeDraft};
type Publication = {kind: 'idle'} | {kind: 'preparing'} | {kind: 'confirm'; confirmation: Confirmation} |
  {kind: 'publishing'; confirmation: Confirmation} | {kind: 'pending'; draft: RecipeDraft; message?: string} |
  {kind: 'failed'; message: string} | {kind: 'published'; publication: AuthoringPublished};

export function RecipeDraftPage(props: Props) {
  return <DraftSession key={`${props.accountId}:${props.draftId}:${props.expectedRevision ?? 0}`} {...props}/>;
}

function DraftSession({shell, accountId, draftId, expectedRevision, onBack, onContinueInChat}: Props) {
  const authoring = useShellCapabilities()?.recipeAuthoring;
  const [read, setRead] = useState<Read>({kind: 'loading'});
  const [refresh, setRefresh] = useState(0);
  const [deletion, setDeletion] = useState<RecipeDraft>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [publication, setPublication] = useState<Publication>({kind: 'idle'});
  const publicationActive = useRef(false);
  const publicationBusy = publication.kind === 'preparing' || publication.kind === 'publishing';
  const publicationLocked = publicationBusy || publication.kind === 'pending' || publication.kind === 'published';
  const requiredRevision = useRef(expectedRevision ?? 0);
  const draft = 'draft' in read ? read.draft : undefined;
  const current = read.kind === 'ready';
  const displayed = useRef<RecipeDraft | undefined>(undefined);
  displayed.current = current ? draft : undefined;
  const alive = useRef(true);
  const deletionRequest = useRef<{revision: number; requestId: string} | undefined>(undefined);
  const deletionActive = useRef(false);
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  useEffect(() => authoring?.onSaved?.(event => {
    if (event.accountId !== accountId || event.draftId !== draftId || event.revision <= requiredRevision.current) return;
    requiredRevision.current = event.revision;
    setDeletion(undefined);
    setPublication(old => old.kind === 'confirm' || old.kind === 'failed' ? {kind: 'idle'} : old);
    setRead(old => ({kind: 'failed', message: '正在读取私聊中保存的更新…', draft: 'draft' in old ? old.draft : undefined}));
    setRefresh(value => value + 1);
  }), [authoring, accountId, draftId]);
  useEffect(() => {
    let active = true;
    void shell.request({type: 'draft', accountId, draftId}).then(next => {
      if (!active) return;
      if (next.draftId !== draftId || next.revision < requiredRevision.current) throw new Error('尚未读取到最新内容，请重试。');
      requiredRevision.current = next.revision;
      setRead({kind: 'ready', draft: next});
    }).catch(reason => {
      if (active) setRead(old => ({kind: 'failed', message: reason instanceof Error ? reason.message : '暂时无法读取配方。', draft: 'draft' in old ? old.draft : undefined}));
    });
    return () => {active = false;};
  }, [shell, accountId, draftId, refresh]);
  function reload() {
    setPublication({kind: 'idle'});
    setRead(old => ({kind: 'failed', message: '正在读取最新内容…', draft: 'draft' in old ? old.draft : undefined}));
    setRefresh(value => value + 1);
  }
  async function prepare(selected: RecipeDraft) {
    if (!authoring || publicationActive.current) return;
    publicationActive.current = true;
    setPublication({kind: 'preparing'});
    try {
      const result = await authoring.request({type: 'preparePublication', accountId, draft: selected});
      if (!alive.current) return;
      if (result.kind === 'publicationResult') {
        if (result.result.kind === 'published' && (result.result.publication.accountId !== accountId || result.result.publication.draftId !== selected.draftId)) throw new Error('发布回执与这份配方不一致，请重新核对。');
        setPublication(result.result.kind === 'published' ? {kind: 'published', publication: result.result.publication} : {kind: 'pending', draft: selected});
      } else if (result.kind === 'publicationReady' && result.draftId === selected.draftId && result.revision === selected.revision &&
        JSON.stringify(result.public) === JSON.stringify(selected.public) && displayed.current === selected) {
        setPublication({kind: 'confirm', confirmation: {reviewId: result.reviewId, draft: selected}});
      } else {
        setPublication({kind: 'failed', message: '配方内容已变化，请重新读取后再确认发布。'});
      }
    } catch (reason) {
      if (alive.current) setPublication({kind: 'failed', message: reason instanceof Error ? reason.message : '暂时无法准备发布，请重试。'});
    } finally {
      publicationActive.current = false;
    }
  }
  async function confirm(confirmation: Confirmation) {
    if (!authoring || publicationActive.current) return;
    publicationActive.current = true;
    setPublication({kind: 'publishing', confirmation});
    try {
      const result = await authoring.request({type: 'confirmPublication', accountId, reviewId: confirmation.reviewId});
      if (!alive.current) return;
      if (result.kind !== 'publicationResult') throw new Error('发布结果尚未确认。');
      if (result.result.kind === 'published' && (result.result.publication.accountId !== accountId || result.result.publication.draftId !== confirmation.draft.draftId)) throw new Error('发布回执与这份配方不一致，请重新核对。');
      setPublication(result.result.kind === 'published' ? {kind: 'published', publication: result.result.publication} :
        {kind: 'pending', draft: confirmation.draft});
    } catch (reason) {
      if (alive.current) setPublication({kind: 'pending', draft: confirmation.draft,
        message: reason instanceof Error ? reason.message : '发布结果尚未确认。'});
    } finally {
      publicationActive.current = false;
    }
  }
  async function discard() {
    if (!deletion || !current || deletion.revision !== draft?.revision || deletion.revision < requiredRevision.current || deletionActive.current) return;
    deletionActive.current = true;
    setDeleting(true);
    setDeleteError(undefined);
    if (deletionRequest.current?.revision !== deletion.revision) deletionRequest.current = {revision: deletion.revision, requestId: crypto.randomUUID()};
    try {
      const result = await shell.request({type: 'deleteDraft', accountId, draftId, revision: deletion.revision, requestId: deletionRequest.current.requestId});
      if (result.draftId !== draftId) throw new Error('尚未确认此配方的删除结果，请重试同一操作。');
      if (alive.current) onBack();
    } catch (reason) {
      if (alive.current) setDeleteError(reason instanceof Error ? reason.message : '删除未完成，请重试。');
    } finally {
      deletionActive.current = false;
      if (alive.current) setDeleting(false);
    }
  }
  return <div className="community-page recipe-draft-page">
    <BackButton label="返回我的配方" onClick={onBack}/>
    {read.kind === 'loading' && <p role="status">正在读取配方…</p>}
    {read.kind === 'failed' && <InlineNotice title="配方尚未更新" tone="warning" actions={<Button onClick={() => setRefresh(value => value + 1)}>重新读取</Button>}>{read.message}</InlineNotice>}
    {publication.kind === 'failed' && <InlineNotice title="尚未准备好发布" tone="warning" actions={<Button onClick={reload}>重新读取</Button>}>{publication.message}</InlineNotice>}
    {publication.kind === 'pending' && <InlineNotice title="正在核对发布结果" tone="warning" actions={<Button onClick={() => void prepare(publication.draft)}>核对发布结果</Button>}>{publication.message || '本次发布尚未确认。继续核对同一次请求即可。'}</InlineNotice>}
    {publication.kind === 'published' && <InlineNotice title="已发布到社区">这份配方已发布，可以在我的配方中管理版本与分享码。</InlineNotice>}
    {draft && expectedRevision !== undefined && expectedRevision !== draft.revision && <InlineNotice title="配方已有更新">链接指向修订 {expectedRevision}，这里展示当前修订 {draft.revision}。请查看当前内容后再发布。</InlineNotice>}
    {draft && <>
      <RecipeDetails draft recipe={draft} heading={<header className="community-detail-heading recipe-draft-heading">
        <RecipeMark name={draft.public.name} logo={draft.format === 'rich-v2' ? draft.logo : undefined}/>
        <div><h1>{draft.public.name || '未命名配方'}</h1><p>创作中 · 仅自己可见</p>{draft.public.summary && <p>{draft.public.summary}</p>}</div>
        <div className="community-actions"><Button disabled={!current || deleting || publicationLocked || !onContinueInChat} onClick={() => onContinueInChat?.(draft)}>在飞书继续创作</Button><GlowButton variant="dark" disabled={!current || deleting || publicationLocked || !authoring} onClick={() => void prepare(draft)}>{publication.kind === 'preparing' ? '正在准备…' : publication.kind === 'publishing' ? '正在发布…' : publication.kind === 'published' ? '已发布' : '发布到社区'}</GlowButton></div>
      </header>}/>
      {!onContinueInChat && <p className="community-muted">请在已关联的 Bot 私聊中继续创作。</p>}
      <div className="recipe-draft-footer"><Button variant="ghost" disabled={!current || deleting || publicationLocked} onClick={() => {setDeleteError(undefined); setDeletion(draft);}}>删除未发布配方</Button></div>
    </>}
    <Dialog open={publication.kind === 'confirm' || publication.kind === 'publishing'} size="sm" title="发布到社区" onClose={() => {if (!publicationBusy) setPublication({kind: 'idle'});}} footer={<>
      <Button disabled={publicationBusy} onClick={() => setPublication({kind: 'idle'})}>继续检查</Button>
      <GlowButton variant="dark" disabled={publication.kind !== 'confirm' || !current} onClick={() => {if (publication.kind === 'confirm') void confirm(publication.confirmation);}}>{publication.kind === 'publishing' ? '正在发布…' : '确认发布'}</GlowButton>
    </>}>
      {(publication.kind === 'confirm' || publication.kind === 'publishing') && <>
        <p>发布「{publication.confirmation.draft.public.name}」· {publication.confirmation.draft.public.version}</p>
        <p>{publication.confirmation.draft.public.access === 'coded' ? '配方介绍公开展示，完整内容凭分享码获取。' : '发布后，所有人都可以查看完整内容并获取配方。'}</p>
      </>}
    </Dialog>
    <Dialog open={Boolean(deletion)} title="删除未发布配方？" onClose={() => {if (!deleting) setDeletion(undefined);}} footer={<>
      <Button disabled={deleting} onClick={() => setDeletion(undefined)}>保留配方</Button>
      <Button variant="danger" disabled={deleting || !current || deletion?.revision !== draft?.revision} onClick={() => void discard()}>{deleting ? '正在删除…' : '删除'}</Button>
    </>}>
      <p>「{deletion?.public.name || '未命名配方'}」的未发布内容将被删除。来源群聊的配置和已发布版本会保留。</p>
      {deleteError && <p role="alert">{deleteError}</p>}
    </Dialog>
  </div>;
}
