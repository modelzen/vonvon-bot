import {BackButton} from '../BackButton';
import {GlowButton} from '../GlowButton';
import {ArrowUpRight, FilePenLine, Search} from 'lucide-react';
import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {communityFailureMessages, newAcquisitionKey} from '@vonvon/protocol';
import type {AuthoringPublished, CommunityResponses, CommunityShell, RecipeDetail, RecipeBrowseDetail, RecipeDraft, RecipeLibraryGroup, RecipeLibraryVersion, RecipeLibraryScope} from '@vonvon/protocol';
import {Button, InlineNotice} from '../reference/components/ui';
import {useShellCapabilities} from '../client-context';
import {useAccount, accountStatusText} from '../account-context';
import {useDraftGuard} from '../settings/DraftGuard';
import {useCommunity, type CommunityRoute, type RecipeWorkspaceTab} from './community-context';
import {CopyButton, RecipeCard, RecipeDetails, RecipeMark, useCreatorName} from './RecipeContent';
import {RecipeDraftPage} from './RecipeDraftPage';
import {RecipeResourceDialog} from './RecipeResourceDialog';
import {RecipeAuthoringPage} from './authoring/RecipeAuthoring';
import {Dialog} from '../reference/components/ui/Dialog';
import './community.css';

export function uniqueRecipes<T extends {versionId: string}>(before: T[], incoming: T[]): T[] {
  const seen = new Set(before.map(item => item.versionId)); return [...before, ...incoming.filter(item => !seen.has(item.versionId) && Boolean(seen.add(item.versionId)))];
}


export function CommunityPage() {
  const community = useCommunity();
  const account = useAccount();
  if (!community?.shell) return <div className="community-page"><h1>社区</h1><p className="community-muted">请在最新版 Vonvon Bot 桌面应用中使用社区。</p></div>;
  const accountId = account.status?.kind === 'signedIn' ? account.status.accountId : undefined;
  return <CommunitySession key={accountId ?? 'anonymous'} shell={community.shell} accountId={accountId}/>;
}

function CommunitySession({shell, accountId}: {shell: CommunityShell; accountId?: string}) {
  const community = useCommunity()!;
  const account = useAccount();
  const {navigate} = useDraftGuard();
  const route = community.route;
  const authoring = useShellCapabilities()?.recipeAuthoring;
  const [handoff, setHandoff] = useState<Pick<RecipeDetail, 'recipeId' | 'versionId' | 'public'>>();
  useEffect(() => setHandoff(undefined), [route]);


  const [preparation,setPreparation]=useState<{draft?:RecipeDraft}>();
  useEffect(()=>setPreparation(undefined),[route]);
  const workspaceTab = route.kind === 'workspace' ? route.tab : undefined;
  const {generation: catalogGeneration, query, search, result: catalog} = community.catalog;
  const [composing, setComposing] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const setQuery = (query: string) => {setError(undefined); community.setCatalog(old => ({...old, query}));};
  const setCatalog = (result: CommunityResponses['catalog'] | ((old: CommunityResponses['catalog'] | undefined) => CommunityResponses['catalog'] | undefined)) => community.setCatalog(old => old.generation === catalogGeneration ? {...old, result: typeof result === 'function' ? result(old.result) : result} : old);
  const [authorPage, setAuthorPage] = useState<CommunityResponses['author']>();
  const authorName = useCreatorName(authorPage?.creator);
  const [groups, setGroups] = useState<Partial<Record<RecipeLibraryScope, CommunityResponses['recipeGroups']>>>({});
  const [selectedVersions, setSelectedVersions] = useState<Map<string, RecipeLibraryVersion>>(() => new Map());
  const scope = workspaceTab && workspaceTab !== 'drafts' ? workspaceTab : undefined;
  const groupPage = scope ? groups[scope] : undefined;
  const [drafts, setDrafts] = useState<CommunityResponses['drafts']['items']>();
  const workspaceReads = useRef(new Map<RecipeWorkspaceTab, number>());
  const [workspaceRevisions, setWorkspaceRevisions] = useState({acquired: 0, drafts: 0, published: 0});
  const workspaceRevision = workspaceTab ? workspaceRevisions[workspaceTab] : 0;
  const invalidateWorkspace = useCallback((...tabs: RecipeWorkspaceTab[]) => {
    setWorkspaceRevisions(previous => {
      const next = {...previous};
      for (const tab of tabs) next[tab]++;
      return next;
    });
  }, []);
  useEffect(() => {
    if (!accountId || !community.isOpen || workspaceTab !== 'drafts') return;
    const refreshOnReturn = () => {
      if (!document.hidden) invalidateWorkspace('drafts');
    };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => {
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, [accountId, community.isOpen, workspaceTab, invalidateWorkspace]);
  const workspaceScroll = useRef(new Map<RecipeWorkspaceTab, number>());
  useLayoutEffect(() => {
    if (!workspaceTab) return;
    const main = document.getElementById('main-content');
    if (main) main.scrollTop = workspaceScroll.current.get(workspaceTab) ?? 0;
  }, [workspaceTab]);
  const [detail, setDetail] = useState<RecipeBrowseDetail>();
  const detailRoute = useRef<CommunityRoute | undefined>(undefined);
  useEffect(() => {
    if (!accountId || !authoring || route.kind !== 'detail' || !route.handoffNavigationId || detailRoute.current !== route || !detail || detail.recipeId !== route.recipe.recipeId || detail.versionId !== route.recipe.versionId || detail.state !== 'listed' || !(detail.owned || detail.acquired)) return;
    if (community.claimHandoffNavigation(route.handoffNavigationId, accountId)) setHandoff(detail);
  }, [accountId, authoring, route, detail]);
  const [shareUrl, setShareUrl] = useState<string>();
  const uncertainDeletions = useRef(new Set<string>());
  const [deletion, setDeletion] = useState<'closed' | 'confirm' | 'uncertain'>('closed');
  useEffect(() => setDeletion('closed'), [route]);
  const acquisitionLogin = community.acquisitionLogin;
  const matchingLogin = route.kind === 'detail' && acquisitionLogin?.recipe.recipeId === route.recipe.recipeId && acquisitionLogin.recipe.versionId === route.recipe.versionId ? acquisitionLogin : undefined;
  const loginPending = matchingLogin?.phase === 'starting' || matchingLogin?.phase === 'waiting';
  const [codeDialog, setCodeDialog] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => setCodeDialog(false), [route]);
  useEffect(() => {
    if (!accountId || matchingLogin?.phase !== 'ready' || matchingLogin.accountId !== accountId || !detail || detail.recipeId !== matchingLogin.recipe.recipeId || detail.versionId !== matchingLogin.recipe.versionId) return;
    community.consumeAcquisitionLogin(matchingLogin.id);
    if (detail.owned || detail.acquired) {setNotice('这个账号已保存此配方版本。'); return;}
    if (detail.public.access === 'coded') setCodeDialog(true);
    else setNotice('登录成功。请再次点击「获取配方」，确认保存这个版本。');
  }, [accountId, detail, matchingLogin]);

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const code = route.kind === 'detail' ? inputs[route.recipe.versionId] ?? '' : '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const {invalidateCatalog} = community;
  const live = useRef(true);
  const generation = useRef(0);
  const submitted = useRef(new Map<string, {raw: string; key: string}>());
  const editCode = (versionId: string, input: string) => setInputs(old => ({...old, [versionId]: input}));
  const navigation = useRef({route, isOpen: community.isOpen});
  if (navigation.current.route !== route || navigation.current.isOpen !== community.isOpen) {navigation.current = {route, isOpen: community.isOpen}; ++generation.current;}
  useEffect(() => {
    if (route.kind !== 'catalog' || composing || query.trim() === search) return;
    if (Array.from(query).length > 120) {setError('搜索词最多 120 个字符。'); return;}
    const timer = setTimeout(() => {
      ++generation.current;
      setError(undefined);
      community.setCatalog(old => ({...old, search: query.trim(), result: undefined, scrollTop: 0}));
    }, 200);
    return () => clearTimeout(timer);
  }, [route.kind, query, search, composing]);
  const requestKeys = useRef(new Map<string, string>());
  useEffect(() => {live.current = true; return () => {live.current = false; ++generation.current;};}, []);
  const key = (logical: string) => {if (!requestKeys.current.has(logical)) requestKeys.current.set(logical, crypto.randomUUID()); return requestKeys.current.get(logical)!;};
  const open = (next: CommunityRoute) => navigate(() => {
    const scrollTop = document.getElementById('main-content')?.scrollTop ?? 0;
    if (workspaceTab) workspaceScroll.current.set(workspaceTab, scrollTop);
    if (route.kind === 'catalog') community.setCatalog(old => ({...old, scrollTop}));
    setError(undefined); setNotice(undefined); community.open(next);
  });
  useEffect(() => {
    let active = true;
    const current = ++generation.current;
    setError(undefined); setDetail(undefined); setShareUrl(undefined); setAuthorPage(undefined);
    const request = async () => {
      if (route.kind === 'catalog') {
        if (catalog) {requestAnimationFrame(() => {const element = document.getElementById('main-content'); if (element) element.scrollTop = community.catalog.scrollTop;}); return;}
        setBusy(true);
        const result = await shell.request({type: 'catalog', ...(accountId ? {accountId} : {}), query: search});
        if (active && current === generation.current) setCatalog(result);
      } else if (route.kind === 'author') {
        setBusy(true);
        const result = await shell.request({type: 'author', authorId: route.authorId, ...(accountId ? {accountId} : {})});
        if (active && current === generation.current) setAuthorPage(result);
      } else if (route.kind === 'detail') {
        setBusy(true);
        const result = await shell.request({type: 'browse', ...(accountId ? {accountId} : {}), recipeId: route.recipe.recipeId, versionId: route.recipe.versionId});
        if (!active || current !== generation.current) return;
        if (result.recipeId !== route.recipe.recipeId || result.versionId !== route.recipe.versionId) throw new Error('未能确认此配方版本，请重试读取。');
        detailRoute.current = route;
        setDetail(result);
        const link = await shell.request({type: 'shareLink', recipeId: route.recipe.recipeId, versionId: route.recipe.versionId});
        if (active && current === generation.current) setShareUrl(link.url);
      } else if (accountId && route.kind === 'workspace') {
        async function readDrafts() {
          setBusy(true);
          const result = await shell.request({type: 'drafts', accountId: accountId!});
          if (active && current === generation.current) setDrafts(result.items);
        }
        async function readGroups(scope: 'acquired' | 'published') {
          if (workspaceReads.current.get(scope) === workspaceRevisions[scope]) return;
          setBusy(true);
          const result = await shell.request({type: 'recipeGroups', accountId: accountId!, scope});
          if (active && current === generation.current) {setGroups(old => ({...old, [scope]: result})); workspaceReads.current.set(scope, workspaceRevisions[scope]);}
        }
        if (route.tab === 'drafts') await readDrafts();
        else await readGroups(route.tab);
      }
    };
    void request().catch(e => {if (active && current === generation.current) setError(e instanceof Error ? e.message : '读取未完成。');}).finally(() => {if (active && current === generation.current) setBusy(false);});
    return () => {active = false;};
  }, [shell, accountId, route, search, refresh, workspaceRevision, route.kind === 'catalog' ? catalogGeneration : 0]);
  useEffect(() => authoring?.onSaved?.(event => {
    if (event.accountId !== accountId) return;
    invalidateWorkspace('drafts');
    if (route.kind === 'draft' && route.draftId === event.draftId) setPreparation(current => current?.draft?.draftId === event.draftId && current.draft.revision < event.revision ? undefined : current);
  }), [authoring, accountId, route]);
  function published(event: AuthoringPublished) {
    if (!live.current || event.accountId !== accountId) return;
    invalidateCatalog();
    invalidateWorkspace('drafts', 'published');
    const current = navigation.current;
    if (current.isOpen && current.route.kind === 'draft' && current.route.draftId === event.draftId) {
      setPreparation(undefined);
      community.open({kind: 'detail', recipe: {recipeId: event.recipeId, versionId: event.versionId}, privateView: true, from: 'published'});
    }
  }
  useEffect(() => authoring?.onPublished?.(published), [authoring, accountId]);
  const runningAction = useRef<number | undefined>(undefined);
  async function run(action: () => Promise<void>) {
    if (busy || runningAction.current === generation.current) return;
    const current = generation.current;
    runningAction.current = current;
    setBusy(true); setError(undefined);
    try {await action();} catch (e) {if (live.current && current === generation.current) setError(e instanceof Error ? e.message : '操作未完成。');}
    finally {if (runningAction.current === current) runningAction.current = undefined; if (live.current && current === generation.current) setBusy(false);}
  }
  async function acquire() {
    if (!accountId) {if (detail) await community.beginAcquisitionLogin({recipeId: detail.recipeId, versionId: detail.versionId}); return;}
    if (!detail) return;
    const selected = detail, current = generation.current;
    const active = () => live.current && current === generation.current;
    const raw = selected.public.access === 'coded' ? code.trim() : '';
    let attempt = submitted.current.get(selected.versionId);
    const reconcile = async () => {
      const next = await shell.request({type: 'browse', accountId, recipeId: selected.recipeId, versionId: selected.versionId});
      if (!active()) return undefined;
      if (next.versionId !== selected.versionId || next.recipeId !== selected.recipeId) throw new Error('获取结果暂未确认，请重试同一操作。');
      setDetail(next);
      if (next.owned || next.acquired) {
        submitted.current.delete(selected.versionId);
        editCode(selected.versionId, '');
        setCodeDialog(false);
        invalidateWorkspace('acquired');
        setNotice('已保存在「我的配方」的「已获取」。可以交给 Bot，再告诉它你想如何调整配置。');
      }
      return next;
    };
    if (attempt && attempt.raw !== raw) {
      const next = await reconcile();
      if (!active() || !next || next.owned || next.acquired) return;
      submitted.current.delete(selected.versionId);
      throw new Error('已确认尚未获取。请再次点击获取，提交当前输入。');
    }
    if (!attempt) {attempt = {raw, key: newAcquisitionKey()}; submitted.current.set(selected.versionId, attempt);}
    const request = {type: 'acquire' as const, accountId, versionId: selected.versionId, requestId: attempt.key, ...(selected.public.access === 'coded' ? {code: attempt.raw} : {})};
    const outcome = await shell.request(request);
    if (!active()) return;
    if (!outcome.ok) {
      const failure = outcome.error;
      if (failure.code === 'operation_expired' || failure.code === 'request_upgrade_required' || failure.code === 'operation_clock_skew') {
        const next = await reconcile();
        if (!active() || !next || next.owned || next.acquired) return;
        submitted.current.delete(selected.versionId);
        throw new Error(failure.code === 'operation_clock_skew' ? '已确认尚未获取。请校准设备时间后，再次点击获取，重新提交。' : '已确认尚未获取。请再次点击获取，重新提交。');
      }
      if (failure.code === 'invalid_code') submitted.current.delete(selected.versionId);
      throw new Error(communityFailureMessages[failure.code] + (failure.retryAfter ? ` 请在 ${failure.retryAfter} 秒后重试。` : ''));
    }
    await reconcile();
  }
  async function deleteVersion() {
    if (!accountId || !detail?.owned || route.kind !== 'detail' || !route.privateView) return;
    const selected = detail, current = generation.current;
    const active = () => live.current && current === generation.current;
    if (deletion === 'confirm') {
      uncertainDeletions.current.add(selected.versionId);
      setDeletion('uncertain');
      invalidateCatalog();
      try {await shell.request({type: 'deletePublication', accountId, versionId: selected.versionId});}
      finally {invalidateCatalog();}
      if (!active()) return;
    }
    const next = await shell.request({type: 'browse', accountId, recipeId: selected.recipeId, versionId: selected.versionId});
    if (!active()) return;
    if (next.recipeId !== selected.recipeId || next.versionId !== selected.versionId || !next.owned || !next.state) throw new Error('删除结果尚未确认，请重新读取。');
    setDetail(next);
    uncertainDeletions.current.delete(selected.versionId);
    setDeletion('closed');
    invalidateWorkspace('published','acquired');
    if (next.state === 'deleted') {
      setNotice('此版本已删除。其他版本和已部署的群聊不受影响。');
      invalidateCatalog();
    } else setNotice('此版本尚未删除。请重新确认。');
  }
  const login = <div className="community-empty"><h2>登录后继续</h2><p>{accountStatusText(account.status, account.supported)}</p><GlowButton variant="dark" disabled={!account.supported || account.status?.kind === 'signingIn'} onClick={() => void account.login()}>登录</GlowButton></div>;
  const privatePage = route.kind === 'workspace' || route.kind === 'draft' || route.kind === 'detail' && !route.handoffNavigationId && (route.privateView || route.from !== undefined);
  if (route.kind === 'create') return <RecipeAuthoringPage key={route.navigationId} onBack={() => open({kind: 'catalog'})} onWorkspace={() => open({kind: 'workspace', tab: 'drafts'})}/>;
  const sourceDialog = preparation && <RecipeAuthoringPage {...preparation} onBack={() => setPreparation(undefined)} onWorkspace={() => {setPreparation(undefined); open({kind: 'workspace', tab: 'drafts'});}}/>;
  if (route.kind === 'draft' && accountId) return <><RecipeDraftPage key={route.navigationId ?? route.draftId} shell={shell} accountId={accountId} draftId={route.draftId} expectedRevision={route.expectedRevision} onContinueInChat={authoring ? draft => setPreparation({draft}) : undefined} onPublished={published} onDeleted={draftId => {
    invalidateWorkspace('drafts');
    setDrafts(rows => rows?.filter(row => row.draftId !== draftId));
    open({kind: 'workspace', tab: route.from ?? 'drafts'});
  }} onBack={() => open({kind: 'workspace', tab: route.from ?? 'drafts'})}/>{sourceDialog}</>;
  return <div className="community-page">
    {(route.kind === 'catalog' || route.kind === 'workspace') && <header className="community-browse-toolbar">
      <nav className="community-tabs" aria-label="配方导航"><button type="button" aria-current={route.kind === 'catalog' ? 'page' : undefined} onClick={() => open({kind:'catalog'})}>Bot 配方</button><button type="button" aria-current={workspaceTab ? 'page' : undefined} onClick={() => open({kind:'workspace',tab:'acquired'})}>我的配方</button><button type="button" disabled>Bot 租赁 <span>敬请期待</span></button></nav>
      {route.kind === 'catalog' && <div className="community-search" role="search"><Search size={16} aria-hidden="true"/><input ref={searchInput} type="search" aria-label="搜索配方" placeholder="搜索配方或作者" value={query} onChange={event => setQuery(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={event => {setQuery(event.currentTarget.value); setComposing(false);}}/>{query && <Button variant="ghost" aria-label="清除搜索" onClick={() => {++generation.current; setError(undefined); community.setCatalog(old => ({...old, query: '', search: '', result: undefined, scrollTop: 0})); setRefresh(old => old + 1); searchInput.current?.focus();}}>清除</Button>}</div>}
      <GlowButton size="md" variant="dark" onClick={() => {if (accountId) setPreparation({}); else open({kind:'create',navigationId:crypto.randomUUID()});}}>创作配方</GlowButton>
    </header>}
    {route.kind === 'catalog' && <header className="community-heading community-section-heading"><h1>{search ? '搜索结果' : '发现配方'}</h1></header>}
    {route.kind !== 'catalog' && <BackButton label={route.kind === 'detail' && route.authorFrom ? '返回作者主页' : route.kind === 'detail' && route.from ? '返回我的配方' : '返回 Bot 配方'} onClick={() => {open(route.kind === 'detail' && route.authorFrom ? {kind: 'author', authorId: route.authorFrom} : route.kind === 'detail' && route.from ? {kind: 'workspace', tab: route.from} : {kind: 'catalog'});}}/>}
    {error && <InlineNotice title="社区请求未完成" tone="warning" actions={<Button size="sm" onClick={() => {if (route.kind === 'catalog') community.setCatalog(old => ({...old, result: undefined})); if (workspaceTab) invalidateWorkspace(workspaceTab); else setRefresh(old => old + 1);}}>重试读取</Button>}>{error}</InlineNotice>}
    {notice && <InlineNotice title="操作完成" actions={detail?.acquired && !detail.owned ? <Button onClick={() => open({kind: 'workspace', tab: 'acquired'})}>查看已获取</Button> : undefined}>{notice}</InlineNotice>}
    {privatePage && !accountId ? login : <>
      {route.kind === 'catalog' && <>

        <>
          {catalog && (catalog.hero || catalog.items.length > 0) && <div className="community-grid">
            {(catalog.hero ? [catalog.hero, ...catalog.items] : catalog.items).map(recipe => <RecipeCard key={recipe.versionId} recipe={recipe} onOpen={() => open({kind: 'detail', recipe: {recipeId: recipe.recipeId, versionId: recipe.versionId}})}/>)}
          </div>}
          {catalog && !catalog.hero && !catalog.items.length && <div className="community-empty"><h2>{search ? '没有找到匹配的配方' : '社区正在准备第一份配方'}</h2><p>{search ? '换一个名称或关键词试试。' : '你也可以在 Bot 私聊中创作自己的配方。'}</p></div>}
          {catalog?.nextCursor && <div><Button disabled={busy} onClick={() => void run(async () => {const current = generation.current; const next = await shell.request({type: 'catalog', ...(accountId ? {accountId} : {}), query: search, cursor: catalog.nextCursor!}); if (live.current && current === generation.current) setCatalog(old => old ? {...old, items: uniqueRecipes(old.items, next.items), nextCursor: next.nextCursor} : next);})}>加载更多</Button></div>}
        </>
      </>}
      {route.kind === 'author' && authorPage && <section className="community-author-page"><header className="community-heading"><div><h1>{authorName}</h1><p>公开发布的配方</p></div></header>{authorPage.items.length === 0 && <p className="community-muted">这位作者还没有公开发布的配方。</p>}<div className="community-grid">{authorPage.items.map(recipe => <RecipeCard key={recipe.versionId} recipe={recipe} onOpen={() => open({kind: 'detail', recipe, authorFrom: route.authorId})}/>)}</div>{authorPage.nextCursor && <Button disabled={busy} onClick={() => void run(async () => {const current = generation.current; const next = await shell.request({type: 'author', authorId: route.authorId, cursor: authorPage.nextCursor!, ...(accountId ? {accountId} : {})}); if (live.current && current === generation.current) setAuthorPage(old => old ? {...old, items: uniqueRecipes(old.items, next.items), nextCursor: next.nextCursor} : next);})}>加载更多</Button>}</section>}
      {route.kind === 'workspace' && <>
        <div className="community-heading community-studio-heading"><div><h2>我的配方</h2><p>已获取的配方、创作中的草稿和自己发布的版本，都在这里。</p></div></div>
        <nav className="community-workspace-tabs" aria-label="我的配方内容">{([['acquired', '已获取'], ['drafts', '创作中'], ['published', '已发布']] as const).map(([value, label]) => <button key={value} type="button" aria-current={workspaceTab === value ? 'page' : undefined} onClick={() => open({kind: 'workspace', tab: value})}>{label}</button>)}</nav>
        {scope && <section className="community-workspace-section">
          {groupPage?.items.length === 0 && <p className="community-muted">{scope === 'acquired' ? '还没有获取配方。从社区获取后，可以在这里找到。' : '还没有发布配方。可以先选择已有 Bot 和群聊开始创作。'}</p>}
          <div className="community-grid">{groupPage?.items.map(group => {
            const selectionKey = scope + ':' + group.recipeId;
            return <RecipeLibraryCard key={selectionKey} recipe={group} selected={selectedVersions.get(selectionKey)} shell={shell} accountId={accountId!} scope={scope}
              onSelect={version => setSelectedVersions(old => new Map(old).set(selectionKey, version))}
              onOpen={version => open({kind: 'detail', recipe: version, privateView: version.owned, from: scope})}/>;
          })}</div>
          {groupPage?.nextCursor && <Button disabled={busy} onClick={() => void run(async () => {
            const current = generation.current;
            const next = await shell.request({type: 'recipeGroups', accountId: accountId!, scope, cursor: groupPage.nextCursor!});
            if (live.current && current === generation.current) setGroups(old => {
              const before = old[scope];
              if (!before) return old;
              const known = new Set(before.items.map(group => group.recipeId));
              return {...old, [scope]: {...before, items: [...before.items, ...next.items.filter(group => !known.has(group.recipeId))], nextCursor: next.nextCursor}};
            });
          })}>加载更多</Button>}
        </section>}
        <section hidden={workspaceTab !== 'drafts'} className="community-workspace-section">
          {workspaceTab === 'drafts' && drafts?.length === 0 && <div className="recipe-drafts-empty"><FilePenLine aria-hidden="true" size={22}/><div><strong>还没有创作中的配方</strong><p>点击「创作配方」，选择 Bot，在私聊中提供资料或整理已有群配置。</p></div></div>}
          {Boolean(drafts?.length) && <div className="community-grid recipe-drafts-grid">{drafts?.map(draft => <article key={draft.draftId} className="recipe-draft-tile">
            <div className="recipe-draft-tile-body"><RecipeMark name={draft.public.name}/><div><h3 id={`draft-name-${draft.draftId}`}>{draft.public.name || '未命名配方'}</h3>{draft.public.summary && <p>{draft.public.summary}</p>}</div></div>
            <footer><span>{draft.public.version || '待填写版本'}</span><button type="button" aria-describedby={`draft-name-${draft.draftId}`} onClick={() => open({kind:'draft',draftId:draft.draftId,from:'drafts'})}>查看配方<ArrowUpRight size={14} aria-hidden="true"/></button></footer>
          </article>)}</div>}
        </section>

      </>}
      {route.kind === 'detail' && detail && <>
        {route.handoffNavigationId && !accountId && <InlineNotice title="登录后交给 Bot" actions={<Button disabled={loginPending} onClick={() => void community.beginAcquisitionLogin({recipeId: detail.recipeId, versionId: detail.versionId})}>登录并继续</Button>}>请登录后继续使用这个配方版本。尚未获取时，需要先完成获取。</InlineNotice>}

        {matchingLogin && matchingLogin.phase !== 'ready' && <InlineNotice title={loginPending ? '正在登录' : '登录未完成'} tone={loginPending ? 'info' : 'warning'} actions={loginPending ? <Button onClick={() => void account.cancelLogin()}>取消登录</Button> : undefined}>{matchingLogin.phase === 'failed' ? matchingLogin.message : account.error || '请在系统浏览器完成登录，完成后会回到当前配方继续获取。'}</InlineNotice>}

        <RecipeDetails recipe={detail} share={shareUrl && <CopyButton key={shareUrl} value={shareUrl}/>} action={detail.state === 'withdrawn' || detail.state === 'deleted' ? <strong>{detail.state === 'deleted' ? '已删除' : '已下架'}</strong> : detail.owned || detail.acquired ? <><strong className="community-saved">{detail.owned ? '我的作品' : '已获取此版本'}</strong><GlowButton variant="dark" disabled={!authoring} onClick={() => setHandoff(detail)}>交给 Bot</GlowButton>{!route.from && <Button onClick={() => {const scope = detail.owned ? 'published' : 'acquired'; setSelectedVersions(old => new Map(old).set(scope + ':' + detail.recipeId, detail)); open({kind:'workspace',tab:scope});}}>去我的配方查看</Button>}</> : <GlowButton variant="dark" disabled={busy || loginPending} onClick={() => {if (detail.public.access === 'coded' && accountId) {setError(undefined); setCodeDialog(true);} else void run(acquire);}}>获取配方</GlowButton>}
          management={route.privateView && detail.owned && detail.state!=='deleted' ? <Button variant="ghost" disabled={busy} onClick={() => {setError(undefined); setDeletion(uncertainDeletions.current.has(detail.versionId) ? 'uncertain' : 'confirm');}}>删除此版本</Button> : undefined}/>
        {detail.state === 'withdrawn' && <InlineNotice title="此版本已撤下">此版本已停止获取和部署，剩余分享码已停用。已获取者可在「我的配方」看到下架记录。</InlineNotice>}
        {route.privateView && detail.owned && <Dialog open={deletion !== 'closed'} size="sm" title={deletion === 'uncertain' ? '核对删除结果' : '删除此版本？'} onClose={busy ? undefined : () => setDeletion('closed')} footer={<><Button disabled={busy} onClick={() => setDeletion('closed')}>{deletion==='uncertain'?'关闭':'取消'}</Button><Button variant="danger" disabled={busy} onClick={() => void run(deleteVersion)}>{busy ? '正在处理…' : deletion === 'uncertain' ? '重新读取结果' : '确认删除'}</Button></>}><p>「{detail.public.name} · {detail.public.version}」删除后无法恢复，剩余分享码会停用。已获取者会看到「已删除」，无法再次部署这个版本。</p><p>其他版本和已经部署的群聊继续使用。</p>{error && <InlineNotice title="操作未完成" tone="warning">{error}</InlineNotice>}</Dialog>}
        {!detail.owned && !detail.acquired && detail.public.access === 'coded' && accountId && <Dialog open={codeDialog} size="sm" title="获取配方" description={`${detail.public.name} · 版本 ${detail.public.version}`} initialFocusRef={codeInput} onClose={busy ? undefined : () => setCodeDialog(false)} footer={<><Button disabled={busy} onClick={() => setCodeDialog(false)}>取消</Button><GlowButton type="submit" form="community-acquire-code" variant="dark" disabled={busy || !code.trim()}>获取配方</GlowButton></>}><form id="community-acquire-code" className="community-code-form" onSubmit={event => {event.preventDefault(); if (!busy && code.trim()) void run(acquire);}}><label>分享码<input ref={codeInput} aria-label="分享码" placeholder="作者提供的分享码" autoComplete="off" value={code} maxLength={128} onChange={event => editCode(detail.versionId, event.target.value)}/></label>{error && <InlineNotice title="获取未完成" tone="warning">{error}</InlineNotice>}</form></Dialog>}
        {(detail.owned || detail.acquired) && !authoring && <p className="community-muted">已保存在账号中。请使用最新版 Vonvon Bot 桌面应用，将配方交给自己的 Bot。</p>}
        {route.privateView && detail.owned && detail.state === 'listed' && detail.public.access === 'coded' && <RecipeCodes key={detail.versionId} shell={shell} accountId={accountId!} versionId={detail.versionId}/>}
      </>}
      {sourceDialog}
      {handoff && <RecipeResourceDialog key={handoff.versionId} recipe={handoff} intents={community.resourceIntents} onClose={() => setHandoff(undefined)}/>}
      {busy && <p role="status" className="community-muted">正在读取社区…</p>}
    </>}
  </div>;
}

function RecipeLibraryCard({recipe, selected, shell, accountId, scope, onSelect, onOpen}: {recipe: RecipeLibraryGroup; selected?: RecipeLibraryVersion; shell: CommunityShell; accountId: string; scope: RecipeLibraryScope; onSelect: (version: RecipeLibraryVersion) => void; onOpen: (version: RecipeLibraryVersion) => void}) {
  const current = selected ?? recipe;
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<CommunityResponses['recipeGroupVersions']>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const live = useRef(true), locked = useRef(false);
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  async function load(cursor?: string) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(undefined);
    try {
      const result = await shell.request({type: 'recipeGroupVersions', accountId, scope, recipeId: recipe.recipeId, ...(cursor && {cursor})});
      if (!live.current) return;
      if (result.items.some(version => version.recipeId !== recipe.recipeId)) throw new Error('未能确认此配方的版本，请重试。');
      setPage(old => cursor && old ? {...result, items: uniqueRecipes(old.items, result.items)} : result);
    } catch (reason) {if (live.current) setError(reason instanceof Error ? reason.message : '版本读取未完成。');}
    finally {if (live.current) {locked.current = false; setBusy(false);}}
  }
  const versions = uniqueRecipes([current], page?.items ?? []);
  return <RecipeCard recipe={current} context="library" onOpen={() => onOpen(current)}>
    {(current.state === 'withdrawn' || current.state === 'deleted') && <span className="community-muted">{current.state === 'withdrawn' ? '已下架' : '已删除'}</span>}
    {recipe.versionCount > 1 && <div className="community-library-versions">
      <button type="button" className="community-card-action" onClick={() => {setExpanded(old => !old); if (!expanded && !page) void load();}} aria-expanded={expanded}>选择版本 · {recipe.versionCount} 个</button>
      {expanded && <><label>版本<select aria-label={recipe.public.name + '的版本'} value={current.versionId} onChange={event => {const version = versions.find(item => item.versionId === event.target.value); if (version) {onSelect(version); setExpanded(false);}}}>{versions.map(version => <option key={version.versionId} value={version.versionId}>{version.public.version}{version.state === 'withdrawn' ? ' · 已下架' : version.state === 'deleted' ? ' · 已删除' : ''}</option>)}</select></label>
        {busy && <small role="status">正在读取版本…</small>}{error && <div role="alert"><p>{error}</p><Button size="sm" onClick={() => void load(page?.nextCursor ?? undefined)}>重试读取版本</Button></div>}
        {page?.nextCursor && !error && <Button size="sm" disabled={busy} onClick={() => void load(page.nextCursor!)}>加载更多版本</Button>}
      </>}
    </div>}
    {current.owned && <button type="button" className="community-card-action" onClick={() => onOpen(current)}>管理此版本</button>}
  </RecipeCard>;
}

function RecipeCodes({shell, accountId, versionId}: {shell: CommunityShell; accountId: string; versionId: string}) {
  const [page, setPage] = useState<CommunityResponses['codes']>();
  const [count, setCount] = useState(1);
  const [codes, setCodes] = useState('');
  const [batch, setBatch] = useState<CommunityResponses['issueCodes']>();
  const pendingIssue = useRef<{count: number; requestId: string} | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [disable, setDisable] = useState<string>();
  const keys = useRef(new Map<string, string>());
  const live = useRef(true);
  const load = async (cursor?: string) => {
    const result = await shell.request({type: 'codes', accountId, versionId, ...(cursor ? {cursor} : {})});
    if (live.current) setPage(old => cursor && old ? {...result, items: [...old.items, ...result.items.filter(item => !old.items.some(previous => previous.codeId === item.codeId))]} : result);
  };
  useEffect(() => {live.current = true; void load().catch(e => {if (live.current) setError(e instanceof Error ? e.message : '分享码读取失败。');}); return () => {live.current = false;};}, [shell, accountId, versionId]);
  const requestId = (logical: string) => {if (!keys.current.has(logical)) keys.current.set(logical, crypto.randomUUID()); return keys.current.get(logical)!;};
  async function run(action: () => Promise<void>) {if (busy) return; setBusy(true); setError(undefined); try {await action();} catch (e) {if (live.current) setError(e instanceof Error ? e.message : '操作失败。');} finally {if (live.current) setBusy(false);}}
  return <section className="community-codes"><h2>分享码</h2><p className="community-muted">每枚仅限一次。停用未使用的码，不影响已获取者。</p>{error && <InlineNotice title="分享码操作未完成" tone="warning">{error}</InlineNotice>}
    <div className="community-actions"><label>数量 <input aria-label="生成分享码数量" type="number" min={1} max={100} value={count} disabled={busy || Boolean(pendingIssue.current)} onChange={event => setCount(Number(event.target.value))}/></label><Button disabled={busy || !Number.isInteger(count) || count < 1 || count > 100} onClick={() => void run(async () => {
      const pending = pendingIssue.current ?? {count, requestId: requestId('issue:' + count)};
      pendingIssue.current = pending;
      try {
        const result = await shell.request({type: 'issueCodes', accountId, versionId, ...pending});
        if (!live.current) return;
        pendingIssue.current = undefined; keys.current.delete('issue:' + pending.count);
        setBatch(result); setCodes(result.items.flatMap(item => item.status === 'available' ? [item.code] : []).join('\n')); await load();
      } catch (error) {
        if (error instanceof Error && (Object.values(communityFailureMessages) as string[]).includes(error.message)) {pendingIssue.current = undefined; keys.current.delete('issue:' + pending.count);}
        throw error;
      }
    })}>{pendingIssue.current ? '重试上一批' : '生成分享码'}</Button></div>
    {batch && <p role="status" className="community-muted">本次已生成 {batch.items.length} 枚分享码。</p>}
    {codes && <><CopyButton key={codes} value={codes} label="复制分享码"/></>}
    {page?.items.length === 0 && <p className="community-muted">没有分享码。</p>}
    {Boolean(page?.items.length) && <div className="community-list">{page?.items.map(item => <div className="community-list-row" key={item.codeId}><div><strong>…{item.suffix}</strong><small>{{available: '可用', redeemed: '已兑换', disabled: '已停用'}[item.status]}{item.redeemedAt ? ' · ' + new Date(item.redeemedAt).toLocaleString() : ''}</small></div>{item.status === 'available' && <><Button disabled={busy} onClick={() => void run(async () => {const result = await shell.request({type: 'revealCode', accountId, codeId: item.codeId, requestId: requestId('reveal:' + item.codeId)}); if (live.current) setCodes(result.code ?? '');})}>准备复制</Button><Button disabled={busy} onClick={() => setDisable(item.codeId)}>停用</Button></>}</div>)}</div>}
    {page?.nextCursor && <div><Button disabled={busy} onClick={() => void run(() => load(page.nextCursor!))}>加载更多</Button></div>}
    <Dialog open={Boolean(disable)} title="停用这枚分享码" onClose={busy ? undefined : () => setDisable(undefined)} footer={<><Button onClick={() => setDisable(undefined)} disabled={busy}>保留</Button><Button disabled={busy} onClick={() => void run(async () => {if (!disable) return; await shell.request({type: 'disableCode', accountId, codeId: disable, requestId: requestId('disable:' + disable)}); if (!live.current) return; setCodes(''); setDisable(undefined); await load();})}>停用</Button></>}><p>这枚尚未使用的分享码将无法再兑换。</p>{error && <InlineNotice title="停用未完成" tone="warning">{error}</InlineNotice>}</Dialog>
  </section>;
}
