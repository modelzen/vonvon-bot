import {useEffect, useRef, useState} from 'react';
import type {AuthoringPublished, CommunityResponses, CommunityShell, ExactResourceVersion, RecipeLibraryVersion, RecipeDraft} from '@vonvon/protocol';
import {recipePublicationMetadataIssue} from '@vonvon/protocol';
import {BackButton} from '../BackButton';
import {GlowButton} from '../GlowButton';
import {useShellCapabilities} from '../client-context';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {RecipeDetails, RecipeMetadata} from './RecipeContent';
import './recipe-draft.css';

type Props = {
  shell: CommunityShell;
  accountId: string;
  draftId: string;
  expectedRevision?: number;
  onBack: () => void;
  onDeleted: (draftId: string) => void;
  onPublished?: (publication: AuthoringPublished) => void;
  onContinueInChat?: (draft: RecipeDraft) => void;
};
type Read = {kind: 'loading'} | {kind: 'ready'; draft: RecipeDraft} | {kind: 'failed'; message: string; draft?: RecipeDraft};
type Confirmation = {reviewId: string; draft: RecipeDraft};
type PendingContext = {kind: 'displayed'; draft: RecipeDraft} | {kind: 'recovery'};
type Publication = {kind: 'idle'} | {kind: 'preparing'} | {kind: 'confirm'; confirmation: Confirmation} |
  {kind: 'publishing'; confirmation: Confirmation} | {kind: 'pending'; context: PendingContext; message?: string} |
  {kind: 'failed'; message: string} | {kind: 'published'; publication: AuthoringPublished};

export function RecipeDraftPage(props: Props) {
  return <DraftSession key={`${props.accountId}:${props.draftId}:${props.expectedRevision ?? 0}`} {...props}/>;
}

function DraftSession({shell, accountId, draftId, expectedRevision, onBack, onDeleted, onContinueInChat, onPublished}: Props) {
  const authoring = useShellCapabilities()?.recipeAuthoring;
  const [read, setRead] = useState<Read>({kind: 'loading'});
  const [refresh, setRefresh] = useState(0);
  const [deletion, setDeletion] = useState<RecipeDraft>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [publication, setPublication] = useState<Publication>({kind: 'idle'});
  const [publishMode,setPublishMode]=useState<'new'|'version'>('new');
  const [choices,setChoices]=useState<RecipeLibraryVersion[]>();
  const [choiceError,setChoiceError]=useState<string>();
  const [choiceAttempt,setChoiceAttempt]=useState(0);
  const [selectedRecipe,setSelectedRecipe]=useState('');
  const choosingVersion=publication.kind==='confirm' && publishMode==='version';
  useEffect(()=>{
    if(!choosingVersion)return;
    let active=true;
    setChoices(undefined);setChoiceError(undefined);
    async function load(){
      const result:RecipeLibraryVersion[]=[];
      let cursor:string|null=null;
      do {
        const page:CommunityResponses['recipeGroups']=await shell.request({type:'recipeGroups',accountId,scope:'published',...(cursor&&{cursor})});
        if(!active)return;
        for(const group of page.items){
          if(!group.owned)continue;
          if(group.state!=='deleted'){result.push(group);continue;}
          // A deleted latest version can have earlier versions that still belong to the creator.
          if(group.versionCount<2)continue;
          let versionsCursor:string|null=null;
          do {
            const versions:CommunityResponses['recipeGroupVersions']=await shell.request({type:'recipeGroupVersions',accountId,scope:'published',recipeId:group.recipeId,...(versionsCursor&&{cursor:versionsCursor})});
            if(!active)return;
            const eligible=versions.items.find(item=>item.owned&&item.state!=='deleted');
            if(eligible){result.push(eligible);break;}
            versionsCursor=versions.nextCursor;
          }while(versionsCursor);
        }
        cursor=page.nextCursor;
      }while(cursor);
      setChoices(result);
    }
    void load().catch(()=>{if(active)setChoiceError('未能读取已发布配方。');});
    return ()=>{active=false;};
  },[choosingVersion,shell,accountId,choiceAttempt]);
  const chosenVersion=choices?.find(item=>item.recipeId===selectedRecipe);
  const publicationActive = useRef(false);
  const publicationBusy = publication.kind === 'preparing' || publication.kind === 'publishing';
  const publicationLocked = publicationBusy || publication.kind === 'pending' || publication.kind === 'published';
  const requiredRevision = useRef(expectedRevision ?? 0);
  const draft = 'draft' in read ? read.draft : undefined;
  const publicationIssue = draft ? recipePublicationMetadataIssue(draft.public) : undefined;
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
    }).catch(async reason => {
      if (!active) return;
      setRead(old => ({kind: 'failed', message: reason instanceof Error ? reason.message : '暂时无法读取配方。', draft: 'draft' in old ? old.draft : undefined}));
      await recover(() => active && alive.current, true);
    });
    return () => {active = false;};
  }, [shell, accountId, draftId, refresh]);
  function published(receipt: AuthoringPublished) {
    if (receipt.accountId !== accountId || receipt.draftId !== draftId) throw new Error('发布回执与这份配方不一致，请重新核对。');
    setPublication({kind: 'published', publication: receipt});
    onPublished?.(receipt);
  }
  async function recover(active = () => alive.current, automatic = false) {
    if (!authoring || publicationActive.current) return;
    publicationActive.current = true;
    try {
      const reply = await authoring.request({type: 'recoverPublication', accountId, draftId});
      if (!active()) return;
      if (reply.kind !== 'publicationRecovery') throw new Error('发布结果尚未确认。');
      if (reply.result.kind === 'published') published(reply.result.publication);
      else if (reply.result.kind === 'pending') setPublication({kind: 'pending', context: {kind: 'recovery'}});
      else if (!automatic) setPublication({kind: 'failed', message: '未找到已提交的发布请求，请重新读取草稿后确认发布。'});
    } catch (reason) {
      if (active()) setPublication({kind: 'pending', context: {kind: 'recovery'}, message: reason instanceof Error ? reason.message : '发布结果尚未确认。'});
    } finally {
      publicationActive.current = false;
    }
  }
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
        if (result.result.kind === 'published') published(result.result.publication);
        else setPublication({kind: 'pending', context: {kind: 'displayed', draft: selected}});
      } else if (result.kind === 'publicationReady' && result.draftId === selected.draftId && result.revision === selected.revision &&
        JSON.stringify(result.public) === JSON.stringify(selected.public) && displayed.current === selected) {
        setPublishMode(selected.recipeId?'version':'new');setSelectedRecipe(selected.recipeId??'');
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
    const destination:ExactResourceVersion|null|undefined=publishMode==='version'&&chosenVersion
      ? {recipeId:chosenVersion.recipeId,versionId:chosenVersion.versionId}:confirmation.draft.recipeId?null:undefined;
    if(publishMode==='version'&&!chosenVersion){publicationActive.current=false;return;}
    setPublication({kind: 'publishing', confirmation});
    try {
      const result = await authoring.request({type: 'confirmPublication', accountId, reviewId: confirmation.reviewId,...(destination!==undefined&&{destination})});
      if (!alive.current) return;
      if (result.kind !== 'publicationResult') throw new Error('发布结果尚未确认。');
      if (result.result.kind === 'published' && (result.result.publication.accountId !== accountId || result.result.publication.draftId !== confirmation.draft.draftId)) throw new Error('发布回执与这份配方不一致，请重新核对。');
      if (result.result.kind === 'published') published(result.result.publication);
      else setPublication({kind: 'pending', context: {kind: 'displayed', draft: confirmation.draft}});
    } catch (reason) {
      if (alive.current) setPublication({kind: 'pending', context: {kind: 'displayed', draft: confirmation.draft},
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
      if (result.draftId !== draftId || result.deleted !== true) throw new Error('尚未确认此配方的删除结果，请重试同一操作。');
      if (alive.current) onDeleted(result.draftId);
    } catch (reason) {
      if (alive.current) setDeleteError(reason instanceof Error ? reason.message : '删除未完成，请重试。');
    } finally {
      deletionActive.current = false;
      if (alive.current) setDeleting(false);
    }
  }
  return <div className="community-page">
    <BackButton label="返回我的配方" onClick={onBack}/>
    {read.kind === 'loading' && <p role="status">正在读取配方…</p>}
    {read.kind === 'failed' && publication.kind !== 'pending' && publication.kind !== 'published' && <InlineNotice title="配方尚未更新" tone="warning" actions={<Button onClick={() => setRefresh(value => value + 1)}>重新读取</Button>}>{read.message}</InlineNotice>}
    {publication.kind === 'failed' && <InlineNotice title="尚未准备好发布" tone="warning" actions={<Button onClick={reload}>重新读取</Button>}>{publication.message}</InlineNotice>}
    {publication.kind === 'pending' && <InlineNotice title="正在核对发布结果" tone="warning" actions={<Button onClick={() => {
      if (publication.context.kind === 'displayed' && current && draft?.revision === publication.context.draft.revision) void prepare(publication.context.draft);
      else void recover();
    }}>核对发布结果</Button>}>{publication.message || '本次发布尚未确认。继续核对同一次请求即可。'}</InlineNotice>}
    {publication.kind === 'published' && <InlineNotice title="已发布到社区">这份配方已发布，可以在我的配方中管理版本与分享码。</InlineNotice>}
    {draft && expectedRevision !== undefined && expectedRevision !== draft.revision && <InlineNotice title="配方已有更新">链接指向修订 {expectedRevision}，这里展示当前修订 {draft.revision}。请查看当前内容后再发布。</InlineNotice>}
    {draft && <RecipeDetails draft recipe={draft}
        sidebar={<aside className="community-detail-sidebar recipe-draft-sidebar" aria-label="草稿操作">
          <h2>本地草稿</h2>
          <RecipeMetadata meta={draft.public} draft/>
          {publicationIssue && <p className="recipe-draft-readiness" role="status">{publicationIssue}</p>}
          <div className="community-side-actions">
            <Button title="在来源 Bot 的私聊里继续创作" disabled={!current || deleting || publicationLocked || !onContinueInChat} onClick={() => onContinueInChat?.(draft)}>继续创作</Button>
            <GlowButton variant="dark" disabled={!current || deleting || publicationLocked || !authoring || Boolean(publicationIssue)} onClick={() => void prepare(draft)}>{publication.kind === 'preparing' ? '正在准备…' : publication.kind === 'publishing' ? '正在发布…' : publication.kind === 'published' ? '已发布' : '发布到社区'}</GlowButton>
          </div>
          {!onContinueInChat && <p className="community-muted">请在已关联的 Bot 私聊中继续创作。</p>}
          <div className="recipe-draft-footer"><Button variant="ghost" disabled={!current || deleting || publicationLocked} onClick={() => {setDeleteError(undefined); setDeletion(draft);}}>删除未发布配方</Button></div>
        </aside>}/>}
    <Dialog open={publication.kind === 'confirm' || publication.kind === 'publishing'} size="sm" title="发布到社区" onClose={() => {if (!publicationBusy) setPublication({kind: 'idle'});}} footer={<>
      <Button disabled={publicationBusy} onClick={() => setPublication({kind: 'idle'})}>继续检查</Button>
      <GlowButton variant="dark" disabled={publication.kind !== 'confirm' || !current || publishMode==='version'&&!chosenVersion} onClick={() => {if (publication.kind === 'confirm') void confirm(publication.confirmation);}}>{publication.kind === 'publishing' ? '正在发布…' : '确认发布'}</GlowButton>
    </>}>
      {(publication.kind === 'confirm' || publication.kind === 'publishing') && <>
        <fieldset className="recipe-destination" disabled={publicationBusy}><legend>发布方式</legend>
          <label><input type="radio" name="recipe-destination" checked={publishMode==='new'} onChange={()=>setPublishMode('new')}/>发布为新配方</label>
          <label><input type="radio" name="recipe-destination" checked={publishMode==='version'} onChange={()=>setPublishMode('version')}/>发布为已有配方的新版本</label>
          {publishMode==='version' && <>
            <select aria-label="要更新的配方" value={selectedRecipe} onChange={event=>setSelectedRecipe(event.target.value)}>
              <option value="">选择我的已发布配方</option>{choices?.map(item=><option key={item.recipeId} value={item.recipeId}>{item.public.name} · {item.public.version}</option>)}
            </select>
            {choiceError?<p role="alert">{choiceError} <Button onClick={()=>setChoiceAttempt(value=>value+1)}>重试</Button></p>:choices===undefined?<small role="status">正在读取已发布配方…</small>:!choices.length?<small>还没有可更新的配方，请选择「发布为新配方」。</small>:null}
          </>}
        </fieldset>
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
