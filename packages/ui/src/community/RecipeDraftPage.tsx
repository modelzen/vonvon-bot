import {useEffect, useRef, useState} from 'react';
import type {CommunityShell, RecipeDraft} from '@vonvon/protocol';
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
  onBack: () => void;
  onContinueInChat?: (draft: RecipeDraft) => void;
};
type Read = {kind: 'loading'} | {kind: 'ready'; draft: RecipeDraft} | {kind: 'failed'; message: string; draft?: RecipeDraft};

export function RecipeDraftPage(props: Props) {
  return <DraftSession key={`${props.accountId}:${props.draftId}`} {...props}/>;
}

function DraftSession({shell, accountId, draftId, onBack, onContinueInChat}: Props) {
  const authoring = useShellCapabilities()?.recipeAuthoring;
  const [read, setRead] = useState<Read>({kind: 'loading'});
  const [refresh, setRefresh] = useState(0);
  const [deletion, setDeletion] = useState<RecipeDraft>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const requiredRevision = useRef(0);
  const draft = 'draft' in read ? read.draft : undefined;
  const current = read.kind === 'ready';
  const alive = useRef(true);
  const deletionRequest = useRef<{revision: number; requestId: string} | undefined>(undefined);
  const deletionActive = useRef(false);
  useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  useEffect(() => authoring?.onSaved?.(event => {
    if (event.accountId !== accountId || event.draftId !== draftId || event.revision <= requiredRevision.current) return;
    requiredRevision.current = event.revision;
    setDeletion(undefined);
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
    {draft && <>
      <RecipeDetails draft recipe={draft} heading={<header className="community-detail-heading recipe-draft-heading">
        <RecipeMark name={draft.public.name} logo={draft.format === 'rich-v2' ? draft.logo : undefined}/>
        <div><h1>{draft.public.name || '未命名配方'}</h1><p>创作中 · 仅自己可见</p>{draft.public.summary && <p>{draft.public.summary}</p>}</div>
        <div className="community-actions"><GlowButton variant="dark" disabled={!current || deleting || !onContinueInChat} onClick={() => onContinueInChat?.(draft)}>在飞书继续创作</GlowButton></div>
      </header>}/>
      {!onContinueInChat && <p className="community-muted">请在已关联的 Bot 私聊中继续创作。</p>}
      <div className="recipe-draft-footer"><Button variant="ghost" disabled={!current || deleting} onClick={() => {setDeleteError(undefined); setDeletion(draft);}}>删除未发布配方</Button></div>
    </>}
    <Dialog open={Boolean(deletion)} title="删除未发布配方？" onClose={() => {if (!deleting) setDeletion(undefined);}} footer={<>
      <Button disabled={deleting} onClick={() => setDeletion(undefined)}>保留配方</Button>
      <Button variant="danger" disabled={deleting || !current || deletion?.revision !== draft?.revision} onClick={() => void discard()}>{deleting ? '正在删除…' : '删除'}</Button>
    </>}>
      <p>「{deletion?.public.name || '未命名配方'}」的未发布内容将被删除。来源群聊的配置和已发布版本会保留。</p>
      {deleteError && <p role="alert">{deleteError}</p>}
    </Dialog>
  </div>;
}
