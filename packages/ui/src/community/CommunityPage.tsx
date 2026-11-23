import {BackButton} from '../BackButton';
import {GlowButton} from '../GlowButton';
import {Bookmark, ChevronRight, NotebookPen, Search} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {communityFailureMessages, newAcquisitionKey} from '@vonvon/protocol';
import type {CommunityResponses, CommunityShell, RecipeDetail, RecipeSummary, RecipeRichDraft} from '@vonvon/protocol';
import {Button, InlineNotice} from '../reference/components/ui';
import {useShellCapabilities} from '../client-context';
import {useAccount, accountStatusText} from '../account-context';
import {useDraftGuard} from '../settings/DraftGuard';
import {useCommunity, type CommunityRoute} from './community-context';
import {CopyButton, RecipeCard, RecipeDetails, RecipeMark} from './RecipeContent';
import {RecipeEditor} from './RecipeEditor';
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
  const [preparation,setPreparation]=useState<{parent?:{recipeId:string;versionId:string};draft?:RecipeRichDraft}>();
  useEffect(()=>setPreparation(undefined),[route]);
  const [tab, setTab] = useState<'recipes' | 'rental'>('recipes');
  const [workspaceTab, setWorkspaceTab] = useState<'drafts' | 'published'>('drafts');
  const {query, search, result: catalog} = community.catalog;
  const catalogHasRecipes = useRef(false);
  if (catalog?.hero || catalog?.items.length) catalogHasRecipes.current = true;
  const [composing, setComposing] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const setQuery = (query: string) => {setError(undefined); community.setCatalog(old => ({...old, query}));};
  const setCatalog = (result: CommunityResponses['catalog'] | ((old: CommunityResponses['catalog'] | undefined) => CommunityResponses['catalog'] | undefined)) => community.setCatalog(old => ({...old, result: typeof result === 'function' ? result(old.result) : result}));
  const [library, setLibrary] = useState<CommunityResponses['library']>();
  const [drafts, setDrafts] = useState<CommunityResponses['drafts']['items']>();
  const [publications, setPublications] = useState<RecipeSummary[]>();
  const [detail, setDetail] = useState<RecipeDetail>();
  const [shareUrl, setShareUrl] = useState<string>();
  const [codeDialog, setCodeDialog] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => setCodeDialog(false), [route]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const code = route.kind === 'detail' ? inputs[route.recipe.versionId] ?? '' : '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [refresh, setRefresh] = useState(0);
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
  const open = (next: CommunityRoute) => navigate(() => {if (route.kind === 'catalog') {const scrollTop = document.getElementById('main-content')?.scrollTop ?? 0; community.setCatalog(old => ({...old, scrollTop}));} setError(undefined); setNotice(undefined); community.open(next);});
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
        if (!active) return;
        if (result.recipeId !== route.recipe.recipeId || result.versionId !== route.recipe.versionId) throw new Error('未能确认此配方版本，请重试读取。');
        setDetail(result);
        const link = await shell.request({type: 'shareLink', recipeId: route.recipe.recipeId, versionId: route.recipe.versionId});
        if (active) setShareUrl(link.url);
      } else if (accountId && route.kind === 'library') {
        setBusy(true);
        const result = await shell.request({type: 'library', accountId});
        if (active) setLibrary(result);
      } else if (accountId && route.kind === 'workspace') {
        setBusy(true);
        const [d, p] = await Promise.all([shell.request({type: 'drafts', accountId}), shell.request({type: 'publications', accountId})]);
        if (active) {setDrafts(d.items); setPublications(p.items);}
      }
    };
    void request().catch(e => {if (active && current === generation.current) setError(e instanceof Error ? e.message : '读取未完成。');}).finally(() => {if (active && current === generation.current) setBusy(false);});
    return () => {active = false;};
  }, [shell, accountId, route, search, refresh]);
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
        setNotice('已获取，已保存在你的账号中。可以稍后从「已获取」添加到群聊。');
        community.onUse?.(next);
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
  const login = <div className="community-empty"><h2>登录后继续</h2><p>{accountStatusText(account.status, account.supported)}</p><GlowButton variant="dark" disabled={!account.supported || account.status?.kind === 'signingIn'} onClick={() => void account.login()}>登录</GlowButton></div>;
  const privatePage = route.kind === 'library' || route.kind === 'workspace' || route.kind === 'draft' || route.kind === 'detail' && route.privateView;
  const sourceDialog=preparation&&<RecipeAuthoringPage {...preparation} onBack={()=>setPreparation(undefined)} onSaved={draftId=>{setPreparation(undefined);open({kind:'draft',draftId});}}/>;
  if (route.kind === 'draft' && accountId) return <><RecipeEditor key={route.draftId ?? route.source?.versionId ?? 'new'} shell={shell} accountId={accountId} draftId={route.draftId} knownRichDraft={drafts?.some(draft => draft.draftId === route.draftId && draft.format === 'rich-v2')} source={route.source}
    onContinueInChat={authoring ? draft=>setPreparation({draft}) : undefined} chatContinuationUnavailable={authoring?undefined:'此设备暂不支持聊天草稿，仍可在这里编辑发布信息。'}
    onBack={() => open({kind: 'workspace'})} onPublished={recipe => {community.setCatalog(old=>({...old,result:undefined}));setNotice(recipe.firstCode ? '本版本已发布。首枚分享码已生成，可在分享码管理中复制。' : '本版本已发布。'); community.open({kind: 'detail', recipe: {recipeId: recipe.recipeId, versionId: recipe.versionId}, privateView: true});}}/>{sourceDialog}</>;
  return <div className="community-page">
    {route.kind === 'catalog' && <header className="community-heading community-page-heading"><h1>社区</h1><nav className="community-tabs" aria-label="社区类型"><button type="button" aria-current={tab === 'recipes' ? 'page' : undefined} onClick={() => {setTab('recipes'); if (route.kind !== 'catalog') open({kind: 'catalog'});}}>Bot 配方</button><button type="button" aria-current={tab === 'rental' ? 'page' : undefined} onClick={() => {setTab('rental'); if (route.kind !== 'catalog') open({kind: 'catalog'});}}>Bot 租赁 <span>敬请期待</span></button></nav></header>}
    {route.kind === 'catalog' && tab === 'recipes' && <div className="community-section-heading"><div><h2>{search ? '搜索结果' : catalog?.heroKind === 'featured' ? '场景精选' : '最新配方'}</h2>{!search && catalog?.heroKind === 'featured' && <p>Vonvon 编辑推荐</p>}</div><div className="community-actions"><Button variant="ghost" onClick={() => open({kind: 'library'})}><Bookmark size={14}/>已获取<ChevronRight size={12}/></Button><Button variant="ghost" onClick={() => open({kind: 'workspace'})}><NotebookPen size={14}/>创作中心<ChevronRight size={12}/></Button></div></div>}
    {route.kind !== 'catalog' && <BackButton label={route.kind === 'detail' && route.from === 'library' ? '返回已获取' : '返回 Bot 配方'} onClick={() => {setTab('recipes'); open({kind: route.kind === 'detail' ? route.from ?? 'catalog' : 'catalog'});}}/>}
    {error && <InlineNotice title="社区请求未完成" tone="warning" actions={<Button size="sm" onClick={() => {if (route.kind === 'catalog') community.setCatalog(old => ({...old, result: undefined})); setRefresh(old => old + 1);}}>重试读取</Button>}>{error}</InlineNotice>}
    {notice && <InlineNotice title="操作完成">{notice}</InlineNotice>}
    {privatePage && !accountId ? login : <>
      {route.kind === 'catalog' && <>

        {tab === 'rental' ? <div className="community-empty"><h2>Bot 租赁</h2><p>让 Bot 为更多群聊提供帮助。</p></div> : <>
          {(query || search || catalogHasRecipes.current) && <div className="community-search" role="search"><Search size={16} aria-hidden="true"/><input ref={searchInput} type="search" aria-label="搜索配方" placeholder="搜索配方或作者" value={query} onChange={event => setQuery(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={event => {setQuery(event.currentTarget.value); setComposing(false);}}/>{query && <Button variant="ghost" aria-label="清除搜索" onClick={() => {++generation.current; setError(undefined); community.setCatalog(old => ({...old, query: '', search: '', result: undefined, scrollTop: 0})); setRefresh(old => old + 1); searchInput.current?.focus();}}>清除</Button>}</div>}
          {catalog?.hero && <RecipeCard recipe={catalog.hero} hero heroKind={catalog.heroKind} onOpen={() => open({kind: 'detail', recipe: {recipeId: catalog.hero!.recipeId, versionId: catalog.hero!.versionId}})}/>}
          {catalog && Boolean(catalog.items.length) && <section className="community-catalog-list">{!search && <h2>{catalog.hero ? '更多配方' : '配方'}</h2>}<div className="community-grid">{catalog.items.map(recipe => <RecipeCard key={recipe.versionId} recipe={recipe} onOpen={() => open({kind: 'detail', recipe: {recipeId: recipe.recipeId, versionId: recipe.versionId}})}/>)}</div></section>}
          {catalog && !catalog.hero && !catalog.items.length && <div className="community-empty"><h2>{search ? '没有找到匹配的配方' : '社区正在准备第一份配方'}</h2><p>{search ? '换一个名称或关键词试试。' : '你也可以在创作中心准备自己的作品。'}</p></div>}
          {catalog?.nextCursor && <div><Button disabled={busy} onClick={() => void run(async () => {const current = generation.current; const next = await shell.request({type: 'catalog', ...(accountId ? {accountId} : {}), query: search, cursor: catalog.nextCursor!}); if (live.current && current === generation.current) setCatalog(old => old ? {...old, items: uniqueRecipes(old.items, next.items), nextCursor: next.nextCursor} : next);})}>加载更多</Button></div>}
        </>}
      </>}
      {route.kind === 'library' && <section className="community-workspace-section"><h2>已获取</h2>{library?.items.length === 0 && <div className="community-empty"><h2>还没有获取配方</h2><p>从社区获取后，任何设备登录这个账号都可以继续使用。</p></div>}<div className="community-grid">{library?.items.map(recipe => <RecipeCard key={recipe.versionId} recipe={recipe} context="library" onOpen={() => open({kind: 'detail', recipe: {recipeId: recipe.recipeId, versionId: recipe.versionId}, from: 'library'})}/>)}</div>
        {library?.nextCursor && <div><Button disabled={busy} onClick={() => void run(async () => {const current = generation.current; const next = await shell.request({type: 'library', accountId: accountId!, cursor: library.nextCursor!}); if (live.current && current === generation.current) setLibrary(old => old ? {...old, items: uniqueRecipes(old.items, next.items), nextCursor: next.nextCursor} : next);})}>加载更多</Button></div>}</section>}
      {route.kind === 'workspace' && <>
        <div className="community-heading community-studio-heading"><div><h2>创作中心</h2><p>在飞书和 Bot 整理配方，在这里检查内容并发布到社区。</p></div><div className="community-actions"><GlowButton variant="dark" onClick={() => setPreparation({})}>准备配方</GlowButton></div></div>
        <nav className="community-workspace-tabs" aria-label="创作中心内容"><button type="button" aria-current={workspaceTab === 'drafts' ? 'page' : undefined} onClick={() => setWorkspaceTab('drafts')}>草稿箱 <span>{drafts?.length ?? 0}</span></button><button type="button" aria-current={workspaceTab === 'published' ? 'page' : undefined} onClick={() => setWorkspaceTab('published')}>已发布 <span>{publications?.length ?? 0}</span></button></nav>
        <section hidden={workspaceTab !== 'drafts'} className="community-workspace-section">{drafts?.length === 0 && <p className="community-muted">还没有私人草稿。准备配方后，在这里检查内容并发布。</p>}{Boolean(drafts?.length) && <div className="community-list">{drafts?.map(draft => <div className="community-list-row community-studio-row" key={draft.draftId}><RecipeMark name={draft.public.name}/><div><strong>{draft.public.name || '未命名草稿'}</strong>{draft.public.summary && <p className="community-row-summary">{draft.public.summary}</p>}<small>{draft.public.version || '未指定版本'} · 私人草稿</small></div><Button onClick={() => open({kind: 'draft', draftId: draft.draftId})}>查看草稿</Button></div>)}</div>}</section>
        <section hidden={workspaceTab !== 'published'} className="community-workspace-section">{publications?.length === 0 && <p className="community-muted">发布后，你可以在这里维护版本和分享码。</p>}{Boolean(publications?.length) && <div className="community-list">{publications?.map(recipe => <div className="community-list-row community-studio-row" key={recipe.versionId}><RecipeMark name={recipe.public.name} logo={recipe.logo}/><div><strong>{recipe.public.name}</strong>{recipe.public.summary && <p className="community-row-summary">{recipe.public.summary}</p>}<small>{recipe.public.version} · {recipe.public.access === 'coded' ? '凭分享码获取' : '直接获取'}</small></div><Button onClick={() => open({kind: 'detail', recipe: {recipeId: recipe.recipeId, versionId: recipe.versionId}, privateView: true})}>管理此版本</Button></div>)}</div>}</section>
      </>}
      {route.kind === 'detail' && detail && <>
        <RecipeDetails recipe={detail} share={shareUrl && <CopyButton key={shareUrl} value={shareUrl}/>} action={detail.owned || detail.acquired ? <GlowButton variant="dark" disabled={!community.onUse} onClick={() => community.onUse?.(detail)}>添加到群聊</GlowButton> : <GlowButton variant="dark" disabled={busy} onClick={() => {if (detail.public.access === 'coded' && accountId) {setError(undefined); setCodeDialog(true);} else void run(acquire);}}>获取配方</GlowButton>}
          management={route.privateView && detail.owned ? <div className="community-actions"><Button onClick={() => detail.format==='rich-v2'?setPreparation({parent:{recipeId:detail.recipeId,versionId:detail.versionId}}):open({kind:'draft',source:detail})}>准备新版</Button></div> : undefined}/>
        {!detail.owned && !detail.acquired && detail.public.access === 'coded' && accountId && <Dialog open={codeDialog} size="sm" title="获取配方" description={`${detail.public.name} · 版本 ${detail.public.version}`} initialFocusRef={codeInput} onClose={busy ? undefined : () => setCodeDialog(false)} footer={<><Button disabled={busy} onClick={() => setCodeDialog(false)}>取消</Button><GlowButton type="submit" form="community-acquire-code" variant="dark" disabled={busy || !code.trim()}>获取配方</GlowButton></>}><form id="community-acquire-code" className="community-code-form" onSubmit={event => {event.preventDefault(); if (!busy && code.trim()) void run(acquire);}}><label>分享码<input ref={codeInput} aria-label="分享码" placeholder="作者提供的分享码" autoComplete="off" value={code} maxLength={128} onChange={event => editCode(detail.versionId, event.target.value)}/></label>{error && <InlineNotice title="获取未完成" tone="warning">{error}</InlineNotice>}</form></Dialog>}
        {(detail.owned || detail.acquired) && !community.onUse && <p className="community-muted">已保存在账号中。请使用最新版 Vonvon Bot 桌面应用，把配方添加到群聊。</p>}
        {route.privateView && detail.owned && detail.public.access === 'coded' && <RecipeCodes key={detail.versionId} shell={shell} accountId={accountId!} versionId={detail.versionId}/>}
      </>}
      {sourceDialog}
      {busy && <p role="status" className="community-muted">正在读取社区…</p>}
    </>}
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
    {batch && <p role="status" className="community-muted">本批 {batch.items.length} 枚：{batch.items.filter(item => item.status === 'available').length} 枚可用，{batch.items.filter(item => item.status === 'redeemed').length} 枚已兑换，{batch.items.filter(item => item.status === 'disabled').length} 枚已停用。</p>}
    {codes && <><CopyButton key={codes} value={codes} label="复制分享码"/></>}
    {page?.items.length === 0 && <p className="community-muted">没有分享码。</p>}
    {Boolean(page?.items.length) && <div className="community-list">{page?.items.map(item => <div className="community-list-row" key={item.codeId}><div><strong>…{item.suffix}</strong><small>{{available: '可用', redeemed: '已兑换', disabled: '已停用'}[item.status]}{item.redeemedAt ? ' · ' + new Date(item.redeemedAt).toLocaleString() : ''}</small></div>{item.status === 'available' && <><Button disabled={busy} onClick={() => void run(async () => {const result = await shell.request({type: 'revealCode', accountId, codeId: item.codeId, requestId: requestId('reveal:' + item.codeId)}); if (live.current) setCodes(result.code ?? '');})}>准备复制</Button><Button disabled={busy} onClick={() => setDisable(item.codeId)}>停用</Button></>}</div>)}</div>}
    {page?.nextCursor && <div><Button disabled={busy} onClick={() => void run(() => load(page.nextCursor!))}>加载更多</Button></div>}
    <Dialog open={Boolean(disable)} title="停用这枚分享码" onClose={busy ? undefined : () => setDisable(undefined)} footer={<><Button onClick={() => setDisable(undefined)} disabled={busy}>保留</Button><Button disabled={busy} onClick={() => void run(async () => {if (!disable) return; await shell.request({type: 'disableCode', accountId, codeId: disable, requestId: requestId('disable:' + disable)}); if (!live.current) return; setCodes(''); setDisable(undefined); await load();})}>停用</Button></>}><p>这枚尚未使用的分享码将无法再兑换。</p>{error && <InlineNotice title="停用未完成" tone="warning">{error}</InlineNotice>}</Dialog>
  </section>;
}
