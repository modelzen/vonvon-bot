import {BackButton} from '../BackButton';
import {GlowButton} from '../GlowButton';
import {Bookmark, ChevronRight, NotebookPen, Search} from 'lucide-react';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {communityFailureMessages, newAcquisitionKey} from '@vonvon/protocol';
import type {AuthoringPublished, CommunityResponses, CommunityShell, RecipeDetail, RecipeSummary, RecipeDraft} from '@vonvon/protocol';
import {Button, InlineNotice} from '../reference/components/ui';
import {useShellCapabilities} from '../client-context';
import {useAccount, accountStatusText} from '../account-context';
import {useDraftGuard} from '../settings/DraftGuard';
import {useCommunity, type CommunityRoute, type RecipeWorkspaceTab} from './community-context';
import {CopyButton, RecipeCard, RecipeDetails, RecipeMark} from './RecipeContent';
import {RecipeDraftPage} from './RecipeDraftPage';
import {RecipeResourceDialog} from './RecipeResourceDialog';
import {RecipeAuthoringPage} from './authoring/RecipeAuthoring';
import {Dialog} from '../reference/components/ui/Dialog';
import './community.css';

export function uniqueRecipes<T extends {versionId: string}>(before: T[], incoming: T[]): T[] {
  const seen = new Set(before.map(item => item.versionId)); return [...before, ...incoming.filter(item => !seen.has(item.versionId) && Boolean(seen.add(item.versionId)))];
}

function acquiredRecipes(versions: RecipeSummary[]) {
  const recipes = new Map<string, RecipeSummary>();
  for (const version of versions) {
    const prior = recipes.get(version.recipeId);
    if (!prior || version.revision > prior.revision) recipes.set(version.recipeId, version);
  }
  return [...recipes.values()];
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
  const [handoff, setHandoff] = useState<RecipeDetail>();
  useEffect(() => setHandoff(undefined), [route]);
  const [preparation,setPreparation]=useState<{parent?:{recipeId:string;versionId:string};draft?:RecipeDraft}>();
  useEffect(()=>setPreparation(undefined),[route]);
  const [tab, setTab] = useState<'recipes' | 'rental'>('recipes');
  const workspaceTab = route.kind === 'workspace' ? route.tab : undefined;
  const {generation: catalogGeneration, query, search, result: catalog} = community.catalog;
  const catalogHasRecipes = useRef(false);
  if (catalog?.hero || catalog?.items.length) catalogHasRecipes.current = true;
  const [composing, setComposing] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const setQuery = (query: string) => {setError(undefined); community.setCatalog(old => ({...old, query}));};
  const setCatalog = (result: CommunityResponses['catalog'] | ((old: CommunityResponses['catalog'] | undefined) => CommunityResponses['catalog'] | undefined)) => community.setCatalog(old => old.generation === catalogGeneration ? {...old, result: typeof result === 'function' ? result(old.result) : result} : old);
  const [library, setLibrary] = useState<CommunityResponses['library']>();
  const [drafts, setDrafts] = useState<CommunityResponses['drafts']['items']>();
  const [publications, setPublications] = useState<RecipeSummary[]>();
  const workspaceReads = useRef(new Map<RecipeWorkspaceTab, number>());
  const [workspaceRevisions, setWorkspaceRevisions] = useState({acquired: 0, drafts: 0, published: 0});
  const workspaceRevision = workspaceTab ? workspaceRevisions[workspaceTab] : 0;
  function invalidateWorkspace(...tabs: RecipeWorkspaceTab[]) {
    setWorkspaceRevisions(previous => {
      const next = {...previous};
      for (const tab of tabs) next[tab]++;
      return next;
    });
  }
  const workspaceScroll = useRef(new Map<RecipeWorkspaceTab, number>());
  useLayoutEffect(() => {
    if (!workspaceTab) return;
    const main = document.getElementById('main-content');
    if (main) main.scrollTop = workspaceScroll.current.get(workspaceTab) ?? 0;
  }, [workspaceTab]);
  const [detail, setDetail] = useState<RecipeDetail>();
  const [shareUrl, setShareUrl] = useState<string>();
  const uncertainWithdrawals = useRef(new Set<string>());
  const [withdrawal, setWithdrawal] = useState<'closed' | 'confirm' | 'uncertain'>('closed');
  useEffect(() => setWithdrawal('closed'), [route]);
  const [codeDialog, setCodeDialog] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => setCodeDialog(false), [route]);
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
    if (route.kind !== 'catalog' || tab !== 'recipes' || composing || query.trim() === search) return;
    if (Array.from(query).length > 120) {setError('搜索词最多 120 个字符。'); return;}
    const timer = setTimeout(() => {
      ++generation.current;
      setError(undefined);
      community.setCatalog(old => ({...old, search: query.trim(), result: undefined, scrollTop: 0}));
    }, 200);
    return () => clearTimeout(timer);
  }, [route.kind, tab, query, search, composing]);
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
    setError(undefined); setDetail(undefined); setShareUrl(undefined);
    const request = async () => {
      if (route.kind === 'catalog') {
        if (catalog) {requestAnimationFrame(() => {const element = document.getElementById('main-content'); if (element) element.scrollTop = community.catalog.scrollTop;}); return;}
        setBusy(true);
        const result = await shell.request({type: 'catalog', ...(accountId ? {accountId} : {}), query: search});
        if (active && current === generation.current) setCatalog(result);
      } else if (route.kind === 'detail') {
        setBusy(true);
        const result = await shell.request({type: 'detail', ...(accountId ? {accountId} : {}), recipeId: route.recipe.recipeId, versionId: route.recipe.versionId});
        if (!active || current !== generation.current) return;
        if (result.recipeId !== route.recipe.recipeId || result.versionId !== route.recipe.versionId) throw new Error('未能确认此配方版本，请重试读取。');
        setDetail(result);
        const link = await shell.request({type: 'shareLink', recipeId: route.recipe.recipeId, versionId: route.recipe.versionId});
        if (active && current === generation.current) setShareUrl(link.url);
      } else if (accountId && route.kind === 'workspace' && route.tab === 'acquired') {
        if (workspaceReads.current.get(route.tab) === workspaceRevision) return;
        setBusy(true);
        const result = await shell.request({type: 'library', accountId});
        if (active && current === generation.current) {setLibrary(result); workspaceReads.current.set(route.tab, workspaceRevision);}
      } else if (accountId && route.kind === 'workspace') {
        if (workspaceReads.current.get(route.tab) === workspaceRevision) return;
        setBusy(true);
        if (route.tab === 'drafts') {
          const result = await shell.request({type: 'drafts', accountId});
          if (active && current === generation.current) {setDrafts(result.items); workspaceReads.current.set(route.tab, workspaceRevision);}
        } else {
          const result = await shell.request({type: 'publications', accountId});
          if (active && current === generation.current) {setPublications(result.items); workspaceReads.current.set(route.tab, workspaceRevision);}
        }
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
  async function run(action: () => Promise<void>) {
    if (busy) return;
    const current = generation.current;
    setBusy(true); setError(undefined);
    try {await action();} catch (e) {if (live.current && current === generation.current) setError(e instanceof Error ? e.message : '操作未完成。');}
    finally {if (live.current && current === generation.current) setBusy(false);}
  }
  async function acquire() {
    if (!accountId) {await account.login(); return;}
    if (!detail) return;
    const selected = detail, current = generation.current;
    const active = () => live.current && current === generation.current;
    const raw = selected.public.access === 'coded' ? code.trim() : '';
    let attempt = submitted.current.get(selected.versionId);
    const reconcile = async () => {
      const next = await shell.request({type: 'detail', accountId, recipeId: selected.recipeId, versionId: selected.versionId});
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
  async function withdraw() {
    if (!accountId || !detail?.owned || route.kind !== 'detail' || !route.privateView) return;
    const selected = detail, current = generation.current;
    const active = () => live.current && current === generation.current;
    if (withdrawal === 'confirm') {
      uncertainWithdrawals.current.add(selected.versionId);
      setWithdrawal('uncertain');
      invalidateCatalog();
      try {await shell.request({type: 'withdraw', accountId, versionId: selected.versionId});}
      finally {invalidateCatalog();}
      if (!active()) return;
    }
    const next = await shell.request({type: 'detail', accountId, recipeId: selected.recipeId, versionId: selected.versionId});
    if (!active()) return;
    if (next.recipeId !== selected.recipeId || next.versionId !== selected.versionId || !next.owned || !next.state) throw new Error('撤下结果尚未确认，请重新读取。');
    setDetail(next);
    uncertainWithdrawals.current.delete(selected.versionId);
    setWithdrawal('closed');
    invalidateWorkspace('published');
    if (next.state === 'withdrawn') {
      setNotice('此版本已撤下。已有获取者仍可查看此版本，已保存的群配置会保留。');
      invalidateCatalog();
    } else setNotice('已确认此版本仍在发布中。如需撤下，请重新确认。');
  }
  const login = <div className="community-empty"><h2>登录后继续</h2><p>{accountStatusText(account.status, account.supported)}</p><GlowButton variant="dark" disabled={!account.supported || account.status?.kind === 'signingIn'} onClick={() => void account.login()}>登录</GlowButton></div>;
  const privatePage = route.kind === 'workspace' || route.kind === 'draft' || route.kind === 'detail' && (route.privateView || route.from !== undefined);
  const sourceDialog = preparation && <RecipeAuthoringPage {...preparation} onBack={() => setPreparation(undefined)} onWorkspace={() => {setPreparation(undefined); open({kind: 'workspace', tab: 'drafts'});}}/>;
  if (route.kind === 'draft' && accountId) return <><RecipeDraftPage key={route.navigationId ?? route.draftId} shell={shell} accountId={accountId} draftId={route.draftId} expectedRevision={route.expectedRevision} onContinueInChat={authoring ? draft => setPreparation({draft}) : undefined} onPublished={published} onDeleted={draftId => {
    invalidateWorkspace('drafts');
    setDrafts(rows => rows?.filter(row => row.draftId !== draftId));
    open({kind: 'workspace', tab: 'drafts'});
  }} onBack={() => open({kind: 'workspace', tab: 'drafts'})}/>{sourceDialog}</>;
  return <div className="community-page">
    {route.kind === 'catalog' && <header className="community-heading community-page-heading"><h1>社区</h1><nav className="community-tabs" aria-label="社区类型"><button type="button" aria-current={tab === 'recipes' ? 'page' : undefined} onClick={() => {setTab('recipes'); if (route.kind !== 'catalog') open({kind: 'catalog'});}}>Bot 配方</button><button type="button" aria-current={tab === 'rental' ? 'page' : undefined} onClick={() => {setTab('rental'); if (route.kind !== 'catalog') open({kind: 'catalog'});}}>Bot 租赁 <span>敬请期待</span></button></nav></header>}
    {route.kind === 'catalog' && tab === 'recipes' && <div className="community-section-heading"><div><h2>{search ? '搜索结果' : catalog?.heroKind === 'featured' ? '场景精选' : '最新配方'}</h2>{!search && catalog?.heroKind === 'featured' && <p>Vonvon 编辑推荐</p>}</div><div className="community-actions"><Button variant="ghost" onClick={() => open({kind: 'workspace', tab: 'acquired'})}><Bookmark size={14}/>已获取<ChevronRight size={12}/></Button><Button variant="ghost" onClick={() => open({kind: 'workspace', tab: 'acquired'})}><NotebookPen size={14}/>我的配方<ChevronRight size={12}/></Button></div></div>}
    {route.kind !== 'catalog' && <BackButton label={route.kind === 'detail' && route.from ? '返回我的配方' : '返回 Bot 配方'} onClick={() => {setTab('recipes'); open(route.kind === 'detail' && route.from ? {kind: 'workspace', tab: route.from} : {kind: 'catalog'});}}/>}
    {error && <InlineNotice title="社区请求未完成" tone="warning" actions={<Button size="sm" onClick={() => {if (route.kind === 'catalog') community.setCatalog(old => ({...old, result: undefined})); if (workspaceTab) invalidateWorkspace(workspaceTab); else setRefresh(old => old + 1);}}>重试读取</Button>}>{error}</InlineNotice>}
    {notice && <InlineNotice title="操作完成" actions={detail?.acquired && !detail.owned ? <Button onClick={() => open({kind: 'workspace', tab: 'acquired'})}>查看已获取</Button> : undefined}>{notice}</InlineNotice>}
    {privatePage && !accountId ? login : <>
      {route.kind === 'catalog' && <>

        {tab === 'rental' ? <div className="community-empty"><h2>Bot 租赁</h2><p>让 Bot 为更多群聊提供帮助。</p></div> : <>
          {(query || search || catalogHasRecipes.current) && <div className="community-search" role="search"><Search size={16} aria-hidden="true"/><input ref={searchInput} type="search" aria-label="搜索配方" placeholder="搜索配方或作者" value={query} onChange={event => setQuery(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={event => {setQuery(event.currentTarget.value); setComposing(false);}}/>{query && <Button variant="ghost" aria-label="清除搜索" onClick={() => {++generation.current; setError(undefined); community.setCatalog(old => ({...old, query: '', search: '', result: undefined, scrollTop: 0})); setRefresh(old => old + 1); searchInput.current?.focus();}}>清除</Button>}</div>}
          {catalog?.hero && <RecipeCard recipe={catalog.hero} hero heroKind={catalog.heroKind} onOpen={() => open({kind: 'detail', recipe: {recipeId: catalog.hero!.recipeId, versionId: catalog.hero!.versionId}})}/>}
          {catalog && Boolean(catalog.items.length) && <section className="community-catalog-list">{!search && <h2>{catalog.hero ? '更多配方' : '配方'}</h2>}<div className="community-grid">{catalog.items.map(recipe => <RecipeCard key={recipe.versionId} recipe={recipe} onOpen={() => open({kind: 'detail', recipe: {recipeId: recipe.recipeId, versionId: recipe.versionId}})}/>)}</div></section>}
          {catalog && !catalog.hero && !catalog.items.length && <div className="community-empty"><h2>{search ? '没有找到匹配的配方' : '社区正在准备第一份配方'}</h2><p>{search ? '换一个名称或关键词试试。' : '你也可以在 Bot 私聊中创作自己的配方。'}</p></div>}
          {catalog?.nextCursor && <div><Button disabled={busy} onClick={() => void run(async () => {const current = generation.current; const next = await shell.request({type: 'catalog', ...(accountId ? {accountId} : {}), query: search, cursor: catalog.nextCursor!}); if (live.current && current === generation.current) setCatalog(old => old ? {...old, items: uniqueRecipes(old.items, next.items), nextCursor: next.nextCursor} : next);})}>加载更多</Button></div>}
        </>}
      </>}
      {route.kind === 'workspace' && <>
        <div className="community-heading community-studio-heading"><div><h2>我的配方</h2><p>查看已获取的配方，继续创作，管理已发布版本与分享码。</p></div><div className="community-actions"><GlowButton variant="dark" onClick={() => setPreparation({})}>创作配方</GlowButton></div></div>
        <nav className="community-workspace-tabs" aria-label="我的配方内容">{([['acquired', '已获取'], ['drafts', '创作中'], ['published', '已发布']] as const).map(([value, label]) => <button key={value} type="button" aria-current={workspaceTab === value ? 'page' : undefined} onClick={() => open({kind: 'workspace', tab: value})}>{label}</button>)}</nav>
        <section hidden={workspaceTab !== 'acquired'} className="community-workspace-section">{library?.items.length === 0 && <div className="community-empty"><h2>还没有获取配方</h2><p>从社区获取后，任何设备登录这个账号都可以继续使用。</p></div>}<div className="community-grid">{library && acquiredRecipes(library.items).map(recipe => <RecipeLibraryCard key={recipe.versionId} recipe={recipe} shell={shell} accountId={accountId!} onOpen={target => open({kind: 'detail', recipe: target, from: 'acquired'})}/>)}</div>
        {library?.nextCursor && <div><Button disabled={busy} onClick={() => void run(async () => {const current = generation.current; const next = await shell.request({type: 'library', accountId: accountId!, cursor: library.nextCursor!}); if (live.current && current === generation.current) setLibrary(old => old ? {...old, items: uniqueRecipes(old.items, next.items), nextCursor: next.nextCursor} : next);})}>加载更多</Button></div>}</section>
        <section hidden={workspaceTab !== 'drafts'} className="community-workspace-section">{drafts?.length === 0 && <p className="community-muted">还没有创作中的配方。点击「创作配方」，选择已有 Bot 和群聊，在私聊中开始。</p>}{Boolean(drafts?.length) && <div className="community-list">{drafts?.map(draft => <div className="community-list-row community-studio-row" key={draft.draftId}><RecipeMark name={draft.public.name}/><div><strong>{draft.public.name || '未命名配方'}</strong>{draft.public.summary && <p className="community-row-summary">{draft.public.summary}</p>}<small>{draft.public.version || '未指定版本'} · 创作中</small></div><Button onClick={() => open({kind: 'draft', draftId: draft.draftId})}>查看配方</Button></div>)}</div>}</section>
        <section hidden={workspaceTab !== 'published'} className="community-workspace-section">{publications?.length === 0 && <p className="community-muted">发布后，你可以在这里维护版本和分享码。</p>}{Boolean(publications?.length) && <div className="community-list">{publications?.map(recipe => <div className="community-list-row community-studio-row" key={recipe.versionId}><RecipeMark name={recipe.public.name} logo={recipe.logo}/><div><strong>{recipe.public.name}</strong>{recipe.public.summary && <p className="community-row-summary">{recipe.public.summary}</p>}<small>{recipe.public.version} · {recipe.public.access === 'coded' ? '凭分享码获取' : '直接获取'}</small></div><Button onClick={() => open({kind: 'detail', recipe: {recipeId: recipe.recipeId, versionId: recipe.versionId}, privateView: true, from: 'published'})}>管理此版本</Button></div>)}</div>}</section>
      </>}
      {route.kind === 'detail' && detail && <>
        <RecipeDetails recipe={detail} share={shareUrl && <CopyButton key={shareUrl} value={shareUrl}/>} action={detail.owned || detail.acquired ? <GlowButton variant="dark" disabled={!authoring} onClick={() => setHandoff(detail)}>交给 Bot</GlowButton> : <GlowButton variant="dark" disabled={busy} onClick={() => {if (detail.public.access === 'coded' && accountId) {setError(undefined); setCodeDialog(true);} else void run(acquire);}}>获取配方</GlowButton>}
          management={route.privateView && detail.owned ? <div className="community-actions"><Button disabled={!authoring} onClick={() => setPreparation({parent: {recipeId: detail.recipeId, versionId: detail.versionId}})}>创作新版本</Button>{detail.format === 'rich-v2' && detail.state !== 'withdrawn' && <Button disabled={busy} onClick={() => {setError(undefined); setWithdrawal(uncertainWithdrawals.current.has(detail.versionId) ? 'uncertain' : 'confirm');}}>撤下此版本</Button>}</div> : undefined}/>
        {detail.state === 'withdrawn' && <InlineNotice title="此版本已撤下">已停止新的获取和分享码兑换。已有获取者仍可查看此版本，已保存的群配置会保留。</InlineNotice>}
        {route.privateView && detail.owned && <Dialog open={withdrawal !== 'closed'} size="sm" title={withdrawal === 'uncertain' ? '确认撤下结果' : '撤下此版本'} onClose={busy ? undefined : () => setWithdrawal('closed')} footer={<><Button disabled={busy} onClick={() => setWithdrawal('closed')}>关闭</Button><Button disabled={busy} onClick={() => void run(withdraw)}>{busy ? '正在处理…' : withdrawal === 'uncertain' ? '重新读取结果' : '确认撤下'}</Button></>}><p>撤下后，此版本将从社区目录和搜索中移除，停止新的获取，尚未使用的分享码也会停用。</p><p>已有获取者仍可查看此版本，已保存的群配置不会删除。你仍可在我的配方管理此版本。</p>{error && <InlineNotice title="操作未完成" tone="warning">{error}</InlineNotice>}</Dialog>}
        {!detail.owned && !detail.acquired && detail.public.access === 'coded' && accountId && <Dialog open={codeDialog} size="sm" title="获取配方" description={`${detail.public.name} · 版本 ${detail.public.version}`} initialFocusRef={codeInput} onClose={busy ? undefined : () => setCodeDialog(false)} footer={<><Button disabled={busy} onClick={() => setCodeDialog(false)}>取消</Button><GlowButton type="submit" form="community-acquire-code" variant="dark" disabled={busy || !code.trim()}>获取配方</GlowButton></>}><form id="community-acquire-code" className="community-code-form" onSubmit={event => {event.preventDefault(); if (!busy && code.trim()) void run(acquire);}}><label>分享码<input ref={codeInput} aria-label="分享码" placeholder="作者提供的分享码" autoComplete="off" value={code} maxLength={128} onChange={event => editCode(detail.versionId, event.target.value)}/></label>{error && <InlineNotice title="获取未完成" tone="warning">{error}</InlineNotice>}</form></Dialog>}
        {(detail.owned || detail.acquired) && !authoring && <p className="community-muted">已保存在账号中。请使用最新版 Vonvon Bot 桌面应用，将配方交给自己的 Bot。</p>}
        {route.privateView && detail.owned && detail.state !== 'withdrawn' && detail.public.access === 'coded' && <RecipeCodes key={detail.versionId} shell={shell} accountId={accountId!} versionId={detail.versionId}/>}
      </>}
      {sourceDialog}
      {handoff && <RecipeResourceDialog key={handoff.versionId} recipe={handoff} intents={community.resourceIntents} onClose={() => setHandoff(undefined)}/>}
      {busy && <p role="status" className="community-muted">正在读取社区…</p>}
    </>}
  </div>;
}

function RecipeLibraryCard({recipe, shell, accountId, onOpen}: {recipe: RecipeSummary; shell: CommunityShell; accountId: string; onOpen: (target: {recipeId: string; versionId: string}) => void}) {
  const [latest, setLatest] = useState<Extract<CommunityResponses['latestVersion'], {status: 'current' | 'newer'}>>();
  useEffect(() => {
    let active = true;
    void shell.request({type: 'latestVersion', accountId, recipeId: recipe.recipeId, versionId: recipe.versionId, revision: recipe.revision}).then(value => {
      if (active && value.status === 'newer' && value.target.recipeId === recipe.recipeId && value.revision > recipe.revision && value.target.versionId !== recipe.versionId) setLatest(value);
    }).catch(() => {});
    return () => {active = false;};
  }, [shell, accountId, recipe.recipeId, recipe.versionId, recipe.revision]);
  return <div className="community-library-entry"><RecipeCard recipe={recipe} context="library" onOpen={() => onOpen(recipe)}/>
    {latest && <button type="button" className="community-library-update" onClick={() => onOpen(latest.target)}><span>有新版本 · {latest.version}</span><span>查看<ChevronRight size={12}/></span></button>}
  </div>;
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
