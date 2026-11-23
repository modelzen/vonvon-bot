import {RecipeSourceTargetPanel} from '../../recipes/RecipeSourcePanel';
import {useEffect, useState} from 'react';
import type {AgentId, GroupId, DesktopRecipeSourceReply, RecipeDetail} from '@vonvon/protocol';
import {useAccount} from '../../account-context';
import {useActiveDevice, useShellCapabilities} from '../../client-context';
import {Button, InlineNotice} from '../../reference/components/ui';
import {useCommunity} from '../community-context';
import {CopyButton} from '../RecipeContent';
import {RecipeAuthoringPage} from './RecipeAuthoring';
import '../community.css';

export function GroupRecipeShare({botId, groupId}: {botId: AgentId; groupId: GroupId}) {
  const account = useAccount();
  const device = useActiveDevice();
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  return <GroupShareSession key={`${device.id}:${accountId ?? 'anonymous'}:${botId}:${groupId}`} botId={botId} groupId={groupId} accountId={accountId}/>;
}
function GroupShareSession({botId, groupId, accountId}: {botId: AgentId; groupId: GroupId; accountId?: string}) {
  const device = useActiveDevice();
  const shell = useShellCapabilities();
  const community = useCommunity();
  const [source, setSource] = useState<DesktopRecipeSourceReply>();
  const [detail, setDetail] = useState<RecipeDetail>();
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    if (!shell?.recipeSource) return;
    void shell.recipeSource.request({type:'read',viewId:device.id,botId,groupId}).then(async result => {
      if (!active) return; setSource(result);
      if (!result.source || !shell.community) return;
      const ids = {recipeId:result.source.recipeId,versionId:result.source.versionId};
      const [next, link] = await Promise.all([shell.community.request({type:'detail',...ids,...accountId ? {accountId} : {}}),shell.community.request({type:'shareLink',...ids})]);
      if (active) {setDetail(next); setUrl(link.url);}
    }).catch(error => {if (active) setError(error instanceof Error ? error.message : '来源读取未完成。');});
    return () => {active = false;};
  }, [shell,device.id,botId,groupId,accountId,refresh]);
  const own = source?.source?.authorId === accountId && detail?.owned;
  return <div className="community-page">
    <div className="community-heading"><div><h2>分享</h2><p>分享当前群内这个 Bot 的配方，或准备你自己的私人草稿。</p></div>{community && <Button onClick={() => community.open({kind:'workspace'})}>创作中心</Button>}</div>
    <RecipeSourceTargetPanel botId={botId} groupId={groupId}/>
    {error && <InlineNotice title="配方来源未能读取" tone="warning" actions={<Button onClick={() => setRefresh(value => value + 1)}>重新读取</Button>}>{error}</InlineNotice>}
    {source?.source && <section className="community-workspace-section"><h3>{own ? '本群使用的已发布版本' : '本群使用的配方来源'}</h3><p>{detail?.public.name ?? '正在读取配方介绍…'}{detail && ` · ${detail.public.version}`}</p>{!own && <p className="community-muted">这是其他作者的作品。分享原版本链接会保留作者与版本；获取资格不授予重新发布的权利。</p>}<div className="community-actions">{url && <CopyButton value={url}/>}<Button disabled={!detail} onClick={() => {if (detail) community?.open({kind:'detail',recipe:{recipeId:detail.recipeId,versionId:detail.versionId},...own ? {privateView:true} : {}});}}>{own ? '管理此版本' : '查看原配方'}</Button></div></section>}
    {source?.source && !own && <InlineNotice title="核对独立自有内容" tone="warning">本群含有其他作者的来源。只可分享你能独立验证为自有的内容，受限来源不能导出。来源检查不通过时会停止。</InlineNotice>}
    <RecipeAuthoringPage source={{botId,groupId}} onSaved={draftId => community?.open({kind:'draft',draftId})}/>
  </div>;
}
