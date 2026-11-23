import {RichSetupPanel} from './RichSetupPanel';
import {useEffect, useMemo, useRef, useState} from 'react';
import {groupIdSchema, type AgentId,type GroupId,type DesktopRecipeSourceReply, type DesktopRecipeSourceRequest, type ProjectSettingsView} from '@vonvon/protocol';
import {useAccount} from '../account-context';
import {useActiveDevice, useShellCapabilities} from '../client-context';
import {Button, InlineNotice} from '../reference/components/ui';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {useRecipeUse} from './recipe-use-context';
import {useCommunity} from '../community/community-context';
import {useDraftGuard} from '../settings/DraftGuard';

export function RecipeSourcePanel({view}: {view: ProjectSettingsView}) {return <RecipeSourceTargetPanel botId={view.scope.botId} groupId={groupIdSchema.parse(view.identity.chatId)}/>;}
export function RecipeSourceTargetPanel({botId,groupId}:{botId:AgentId;groupId:GroupId}){const shell=useShellCapabilities();return shell?.recipeSource?<RecipeSourceContent botId={botId} groupId={groupId}/>:null;}
function RecipeSourceContent({botId,groupId}:{botId:AgentId;groupId:GroupId}) {
  const shell = useShellCapabilities();
  const useRecipe = useRecipeUse();
  const community = useCommunity();
  const {navigate} = useDraftGuard();
  const device = useActiveDevice();
  const account = useAccount();
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  const scope = useMemo(() => ({viewId: device.id, botId: botId, groupId: groupId, accountId}), [device.id, botId, groupId, accountId, shell?.recipeSource, useRecipe?.refreshVersion]);
  const [read, setRead] = useState<{scope: typeof scope; result: DesktopRecipeSourceReply}>();
  const [failure, setFailure] = useState<{scope: typeof scope; message: string}>();
  const [working, setWorking] = useState<typeof scope>();
  const active = useRef(scope);
  active.current = scope;
  const locked = useRef<typeof scope | undefined>(undefined);
  const result = read?.scope === scope ? read.result : undefined;
  const busy = working === scope;
  const error = failure?.scope === scope ? failure.message : undefined;
  const source = result?.source;
  const latest = result?.latest;
  async function request(type:'read'|'check'|'ignore') {
    if (!shell?.recipeSource || locked.current === scope) return;
    const {accountId, ...target} = scope;
    if (type !== 'read' && !accountId) return;
    locked.current = scope; setWorking(scope); setFailure(undefined);
    try {
      const location = {...target, groupId: groupIdSchema.parse(target.groupId)};
      const input: DesktopRecipeSourceRequest = type === 'read' ? {type, ...location}
        : type === 'check' ? {type, ...location, accountId: accountId!}
        : {type, ...location, accountId: accountId!, sourceToken: source!.sourceToken, installedVersionId: source!.versionId, versionId: latest!.versionId};
      const next = await shell.recipeSource.request(input);
      if (active.current === scope) setRead({scope, result: next});
    } catch (failure) {if (active.current === scope) setFailure({scope, message: failure instanceof Error ? failure.message : '配方来源暂时无法读取。'});}
    finally {if (locked.current === scope) locked.current = undefined; if (active.current === scope) setWorking(undefined);}
  }
  useEffect(() => {void request('read');}, [scope]);
  if (!shell?.recipeSource) return null;
  return <SettingsGroup label="配方来源">
    {source ? <>
      <SettingsRow title={`当前配方 · 第 ${source.revision} 版`} description={`应用于 ${new Date(source.installedAt).toLocaleDateString()}`}
        trailing={<Button size="sm" disabled={busy || !accountId} onClick={() => void request('check')}>检查新版</Button>}/>
      {latest && <SettingsRow title={`有新版本 · ${latest.version}`} description={latest.entitled ? '预览当前内容与新版差异，确认后再更新。' : '此版本需要先在社区获取。'}
        trailing={<div className="recipe-source-actions"><Button size="sm" disabled={busy} onClick={() => void request('ignore')}>忽略此版本</Button><Button size="sm" variant="primary" disabled={busy || !useRecipe?.available || !latest.entitled && !community}
          onClick={() => {
            const recipe = {...(latest.format==='rich-v2'?{format:'rich-v2' as const}:{}),recipeId: latest.recipeId, versionId: latest.versionId, name: '群聊配方', version: latest.version};
            const target = {botId: botId, groupId: groupIdSchema.parse(scope.groupId)};
            if (latest.entitled) useRecipe?.start(recipe, target);
            else navigate(() => community?.open({kind: 'detail', recipe, useTarget: target}));
          }}>{latest.entitled ? '预览更新' : '获取新版'}</Button></div>}/>}
      {source.format==='rich-v2'&&<RichSetupPanel key={`${device.id}:${botId}:${groupId}:${source.sourceToken}`} botId={botId} groupId={groupId} sourceToken={source.sourceToken}/>}
      {!accountId && <p className="recipe-source-note">登录后可检查新版本。当前配方继续保留。</p>}
    </> : result ? <SettingsRow title="尚未应用社区配方" description="本群还没有社区配方来源。"/> : <p className="recipe-source-note" role="status">正在读取配方来源…</p>}
    {busy && result && <p className="recipe-source-note" role="status">正在核对配方版本…</p>}
    {error && <InlineNotice title="读取未完成" tone="warning" actions={<Button size="sm" disabled={busy} onClick={() => void request('read')}>重试读取</Button>}>{error}</InlineNotice>}
  </SettingsGroup>;
}
