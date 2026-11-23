import {useEffect, useState} from 'react';
import type {AgentId,ViewId,GroupId, RecipeAuthoringShell, SourceHistoryEntry} from '@vonvon/protocol';
import {Button, InlineNotice} from '../../reference/components/ui';
import {useCommunity} from '../community-context';

export function GroupSourceHistory({shell, handle, groupId}: {shell: RecipeAuthoringShell; handle: string; groupId: GroupId}) {
  const community = useCommunity();
  const [page, setPage] = useState<{entries: SourceHistoryEntry[]; nextCursor: string | null}>();
  const [cursor, setCursor] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(undefined);
    void shell.request({type:'sourceHistory', handle, groupId, cursor}).then(reply => {
      if (reply.kind !== 'sourceHistory') throw new Error('未能核对本群的分享历史。');
      if (active) setPage(old => ({
        entries: cursor ? [...(old?.entries ?? []), ...reply.entries] : reply.entries,
        nextCursor: reply.nextCursor,
      }));
    }).catch(reason => {
      if (active) {
        setPage(undefined);
        setError(reason instanceof Error ? reason.message : '未能核对本群的分享历史。');
      }
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [shell, handle, groupId, cursor, attempt]);

  function refresh() {
    setPage(undefined);
    setCursor(undefined);
    setAttempt(value => value + 1);
  }
  return <section className="community-workspace-section" aria-label="本群分享历史">
    <div className="community-heading"><h3>本群分享历史</h3><Button disabled={busy} onClick={refresh}>刷新历史</Button></div>
    {error && <InlineNotice title="分享历史暂不可用" tone="warning">{error}</InlineNotice>}
    {busy && <p role="status">正在核对草稿和发布版本…</p>}
    {page && !page.entries.length && <p className="community-muted">当前账号没有能核对到这次群绑定的分享记录。</p>}
    {page && <div className="community-list">{page.entries.map(entry => <div className="community-list-row" key={entry.operationId}>
      {entry.state === 'unknown' ? <div><strong>保存结果待核实</strong><small>未找到这次准备操作的草稿或确切发布版本。</small></div> : <>
        <div><strong>{entry.name || '未命名草稿'}</strong><small>{entry.state === 'draft' ? '私人草稿' : '已发布'} · {entry.version || '未指定版本'} · 修订 {entry.revision}</small></div>
        {entry.state === 'draft' ? <Button onClick={() => community?.open({kind:'draft',draftId:entry.draftId})}>查看历史草稿</Button>
          : <Button onClick={() => community?.open({kind:'detail',recipe:{recipeId:entry.recipeId,versionId:entry.versionId},privateView:true})}>查看发布版本</Button>}
      </>}
    </div>)}</div>}
    {page?.nextCursor && <Button disabled={busy} onClick={() => setCursor(page.nextCursor!)}>更多记录</Button>}
  </section>;
}

export function GroupShareHistory({shell,accountId,viewId,botId,groupId}:{shell:RecipeAuthoringShell;accountId:string;viewId:ViewId;botId:AgentId;groupId:GroupId}){
  const [handle,setHandle]=useState<string>(),[error,setError]=useState<string>();
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let live=true,current:string|undefined;
    setError(undefined);setHandle(undefined);
    void shell.request({type:'open',accountId,viewId,botId,groupId}).then(reply=>{
      if(reply.kind!=='session')throw new Error('未能核对群来源。');
      current=reply.handle;
      if(live)setHandle(current);else void shell.request({type:'detach',handle:current}).catch(()=>{});
    }).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:'暂时无法打开分享历史。');});
    return ()=>{live=false;if(current)void shell.request({type:'detach',handle:current}).catch(()=>{});};
  },[shell,accountId,viewId,botId,groupId,retry]);
  return handle?<GroupSourceHistory shell={shell} handle={handle} groupId={groupId}/>:error?<InlineNotice title="分享历史暂不可用" actions={<Button onClick={()=>setRetry(v=>v+1)}>重新读取</Button>}>{error}</InlineNotice>:<p role="status">正在核对本群来源…</p>;
}
