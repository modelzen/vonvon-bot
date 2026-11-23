const main = document.querySelector('#main');
const appGuide = main.dataset.page === 'app-guide';
const dialog = document.querySelector('#modal');
const accountButton = document.querySelector('#account');
const params = new URLSearchParams(location.search);
if (!appGuide) document.querySelector('[data-community-link]')?.setAttribute('aria-current', 'page');
const claimIntents = new Map();
let detailGeneration = 0, modalGeneration = 0;
let releaseModal;
let session, catalogSeq = 0;

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function link(text, href, className) {
  const a = el('a', text, className); a.href = href; return a;
}
function backLink(label, href) {
  const a = link(null, href, 'back'); a.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'})) svg.setAttribute(name, value);
  for (const d of ['m12 19-7-7 7-7', 'M19 12H5']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path);
  }
  a.append(svg, el('span', label.replace(/^返回\s*/, '') || '返回')); return a;
}
function detailOrigin() {
  const from = new URLSearchParams(location.search).get('from');
  if (from === 'author' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(params.get('author') || '')) return 'author';
  return ['library', 'library-all', 'published', 'creator'].includes(from) ? from : 'catalog';
}
function detailBack() {
  return detailOrigin() === 'library-all' ? backLink('返回我的配方', '/library?state=all') : ['creator','published'].includes(detailOrigin()) ? backLink('返回我的配方', '/library?state=published') : detailOrigin() === 'author' ? backLink('返回作者的配方', '/authors/' + encodeURIComponent(params.get('author'))) : detailOrigin() === 'library' ? backLink('返回我的配方', '/library?state=acquired') : backLink('返回 Bot 配方', '/');
}
function detailReturnPath() {
  const next = new URL(location.href); next.search = '';
  const origin = detailOrigin();
  if (origin !== 'catalog') next.searchParams.set('from', origin);
  if (origin === 'author') next.searchParams.set('author', params.get('author').toLowerCase());
  return next.pathname + next.search;
}
function button(text, action, cls = 'button') {
  const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', action); return b;
}
function group(cls, ...nodes) {
  const d = el('div', null, cls); d.append(...nodes); return d;
}
function message(text) {
  const info = document.querySelector('#feedback'); info.textContent = text;
  clearTimeout(message.timer); message.timer = setTimeout(() => { info.textContent = ''; }, 2700);
}
class RequestError extends Error {
  constructor(status, code, retryAfter) { super(code); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}
async function request(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await res.json();
  if (!res.ok) throw new RequestError(res.status, data.error?.code, /^[1-9][0-9]{0,12}$/.test(res.headers.get('retry-after') || '') ? Number(res.headers.get('retry-after')) : undefined);
  return data;
}
function modal(title, ...nodes) {
  dismissDialog();
  const h = el('h2', title); h.id = 'dialog-title';
  dialog.setAttribute('aria-labelledby', h.id); dialog.replaceChildren(h, ...nodes);
  dialog.showModal();
}
const closeDialog = () => {++modalGeneration; releaseModal = undefined; dialog.close();};
const dismissDialog = () => {releaseModal?.(); closeDialog();};
const closeButton = () => button('关闭', dismissDialog, 'secondary');
const continuationStorageKey = 'vv-recipe-login-continuation';
function storedContinuation() {
  try { return JSON.parse(window.sessionStorage.getItem(continuationStorageKey)); } catch { return null; }
}
function clearContinuation(nonce) {
  try {
    if (!nonce || storedContinuation()?.nonce === nonce) window.sessionStorage.removeItem(continuationStorageKey);
  } catch { /* Login still works when tab storage is unavailable. */ }
}
function openLogin(next = appGuide ? '/studio' : location.pathname + location.search, continuation) {
  clearContinuation();
  let continuationNonce;
  if (continuation === 'acquire') {
    try {
      continuationNonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
      window.sessionStorage.setItem(continuationStorageKey, JSON.stringify({path: next.split('?')[0], nonce: continuationNonce}));
    } catch { continuationNonce = undefined; }
  }
  location.assign('/login?' + new URLSearchParams({returnTo: next}));
}
function account() {
  if (!session?.signedIn) return openLogin();
  const menu = document.querySelector('.account-menu'); if (menu) menu.open = !menu.open;
}
function siteTarget(name, fallback) {
  const value = document.documentElement.dataset[name];
  return value && !value.startsWith('__') ? value : fallback;
}
async function accountMenu() {
  if (!session?.signedIn) return;
  const currentSession = session.displaySession;
  accountButton.hidden = true;
  const menu = el('details', null, 'account-menu'), summary = el('summary');
  summary.setAttribute('aria-label', '账号菜单');
  const avatar = el('span', '我', 'account-menu-avatar'), name = el('span', '我的账号');
  summary.append(avatar, name);
  const entries = el('nav'); entries.setAttribute('aria-label', '账号选项');
  const settings = el('a', '账号设置'); settings.setAttribute('aria-disabled', 'true'); settings.tabIndex = -1;
  entries.append(link('我的配方', '/library'),
    settings, button('退出登录', async () => {
      try {
        const response = await fetch('/auth/logout', {method: 'POST', credentials: 'same-origin', headers: {'X-Vonvon-Session': currentSession}});
        if (!response.ok) throw new Error('logout_failed');
        authEvents?.postMessage('check'); location.assign('/');
      } catch {message('退出未完成，请刷新后重试。');}
    }, 'text-button'));
  menu.append(summary, entries); accountButton.after(menu);
  try {
    const profile = await request('/api/v2/me/account-profile', {headers: {'X-Vonvon-Session': currentSession}});
    if (session?.displaySession !== currentSession || !menu.isConnected || typeof profile.displayName !== 'string') return;
    name.textContent = profile.displayName; avatar.textContent = Array.from(profile.displayName).slice(0, 2).join('');
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(profile.authorId || '')) {
      settings.href = siteTarget('accountUrl', '/account') + '#account=' + profile.authorId;
      settings.removeAttribute('aria-disabled'); settings.removeAttribute('tabindex');
    }
    if (typeof profile.avatarDataUrl === 'string' && profile.avatarDataUrl.length <= 174787 && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(profile.avatarDataUrl)) {
      const picture = el('img'); picture.src = profile.avatarDataUrl; picture.alt = ''; avatar.replaceChildren(picture);
    }
  } catch {settings.textContent = '账号设置暂不可用';}
}

function empty(title, description, action) {
  const box = group('empty', el('h2', title));
  if (description) box.append(el('p', description));
  if (action) box.append(action);
  return box;
}
const detailUrl = item => '/recipes/' + encodeURIComponent(item.recipeId) + '/versions/' + encodeURIComponent(item.versionId);
const versionLabel = item => '版本 ' + item.public.version;

function card(item, hero = false, context = 'catalog', authorId) {
  const a = el('article', null, hero ? 'hero' : 'card');
  const primary = link(null, detailUrl(item) + (context === 'library-all' ? '?from=library-all' : context === 'library' ? '?from=library' : context === 'published' ? '?from=published' : context === 'author' ? '?from=author&author=' + encodeURIComponent(authorId) : ''), hero ? 'featured-main' : 'card-main');
  const p = item.public;
  const logo = item.logo || (item.hasDisplayLogo ? '/media/versions/' + encodeURIComponent(item.versionId) + '/logo.webp' : null);
  const mark = el(logo ? 'img' : 'span', logo ? null : Array.from(p.name)[0], hero ? 'featured-mark' : 'card-mark');
  if (logo) {
    mark.src = logo; mark.alt = '';
    mark.addEventListener('error', () => {const fallback = el('span', Array.from(p.name)[0], mark.className); fallback.setAttribute('aria-hidden', 'true'); mark.replaceWith(fallback);}, {once: true});
  }
  else mark.setAttribute('aria-hidden', 'true');
  const author = item.creator?.displayName;
  const meta = group(hero ? 'featured-meta' : 'fine card-meta');
  if (author) meta.append(link(author, '/?q=' + encodeURIComponent(author), 'author-link'));
  meta.append(el('span', [versionLabel(item), context === 'catalog' && p.access === 'coded' ? '需分享码' : ''].filter(Boolean).join(' · ')));
  if (hero) {
    primary.append(el('h2', p.name), el('p', p.summary), el('span', '了解这份配方 →', 'featured-cta'));
    const text = group('intro', primary, meta);
    a.append(mark, text);
  } else {primary.append(mark, el('h3', p.name), el('p', p.summary)); a.append(primary, meta);}
  return a;
}

function communityNav(mine = false) {
  const nav = el('nav', null, 'community-nav'); nav.setAttribute('aria-label', '社区内容');
  const discover = link('Bot 配方', '/'); discover.setAttribute('aria-current', 'page'); nav.append(discover);
  const rental = el('button',null,'community-rental'); rental.type = 'button'; rental.disabled = true;
  rental.append(el('span','Bot 租赁'),el('small','敬请期待')); nav.append(rental);
  return nav;
}

function creationLink(label = '创建配方') {
  const action = link(label, '/create?' + new URLSearchParams({from:location.pathname + location.search}), 'button');
  action.setAttribute('data-create-site', '');
  return action;
}
function searchMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({width:'20',height:'20',viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','aria-hidden':'true'})) svg.setAttribute(name,value);
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); circle.setAttribute('cx','10.5'); circle.setAttribute('cy','10.5'); circle.setAttribute('r','7');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d','m16 16 4.5 4.5'); path.setAttribute('stroke-linecap','round'); svg.append(circle,path);
  return svg;
}

function mountSearch(onClear) {
  const search = el('form', null, 'search catalog-search'), q = el('input');
  search.setAttribute('role', 'search'); search.setAttribute('aria-label', '搜索社区配方');
  q.type = 'search'; q.name = 'q'; q.maxLength = 120; q.placeholder = '搜索配方名称、用途或作者'; q.setAttribute('aria-label', '搜索配方');
  q.value = params.get('q')?.slice(0, 120) || '';
  const clear = button('×', () => {q.value=''; if (onClear) onClear(); else q.focus();}, 'search-clear'); clear.setAttribute('aria-label', '清除搜索'); clear.hidden = !q.value;
  const submit = el('button', '搜索', 'search-submit'); submit.type = 'submit';
  search.action='/'; search.method='get';
  search.append(searchMark(), q, clear, submit);
  const header = document.querySelector('.community-mast .site-header-inner');
  if (header) {header.classList.add('catalog-header'); header.insertBefore(communityNav(), header.querySelector('.actions')); header.insertBefore(search, header.querySelector('.actions'));}
  return {search,q,clear};
}

async function home() {
  const intro = group('catalog-intro catalog-welcome', el('h1', '发现配方'), el('p', '从社区的好方法开始，再用自己的方式完善。'));
  const {search,q,clear} = mountSearch(() => resetSearch());
  const results = el('section'); results.setAttribute('aria-label', '配方目录'); results.setAttribute('aria-busy','true');
  main.replaceChildren(intro, results);
  let cursor, items, hero, heroKind, timer, stableQuery, loadingMore, composing = false;
  function resetSearch() {clearTimeout(timer); q.value = ''; clear.hidden = true; q.focus(); void load();}
  const restore = history.state?.catalog;
  function remember() {
    history.replaceState({ catalog: { query: stableQuery, count: items?.length || 0, y: scrollY } }, '');
  }
  results.addEventListener('click', ev => { if (ev.target.closest('a[href]')) remember(); });
  function render() {
    results.replaceChildren();
    if (stableQuery && (hero || items.length)) results.append(group('catalog-results-heading', el('h2', '“' + stableQuery + '”的搜索结果'), button('查看全部配方', resetSearch, 'text-button')));
    const cards = hero ? [hero, ...items] : items;
    if (cards.length) results.append(group('cards', ...cards.map(item => card(item))));
    if (!hero && !items.length) results.append(stableQuery ?
      empty('没有找到匹配的配方', '换一个名称、用途或作者试试。', button('查看全部配方', resetSearch, 'secondary')) :
      empty('社区里还没有配方', '把自己的好配置整理出来，成为第一位分享者。', creationLink()));
    if (cursor) results.append(button('加载更多', more, 'secondary more'));
  }
  const listUrl = (s, next) => {
    const query = new URLSearchParams(); if (s) query.set('q', s);
    if (next) query.set('cursor', next);
    return '/api/v2/community/recipes?' + query;
  };
  function appendPage(data) {
    const ids = new Set([hero?.recipeId, ...items.map(x => x.recipeId)]);
    for (const row of data.items) if (!ids.has(row.recipeId)) { ids.add(row.recipeId); items.push(row); }
    cursor = data.nextCursor;
  }
  async function more(ev) {
    if (!cursor || loadingMore) return;
    const seq = catalogSeq; loadingMore = true; const b = ev.currentTarget; b.disabled = true;
    try {
      const data = await request(listUrl(stableQuery, cursor)); if (seq !== catalogSeq) return;
      appendPage(data); render();
    } catch { if (seq === catalogSeq) { b.disabled = false; message('加载失败，请重试。'); } }
    finally { if (seq === catalogSeq) loadingMore = false; }
  }
  async function load(initial = false) {
    const seq = ++catalogSeq; loadingMore = false; const term = q.value.trim();
    const url = new URL(location.href); term ? url.searchParams.set('q', term) : url.searchParams.delete('q');
    history.replaceState(null, '', url); results.setAttribute('aria-busy', 'true');
    if (!items) {const status = el('p', '正在读取配方…', 'catalog-status'); status.setAttribute('role', 'status'); results.replaceChildren(status);}
    try {
      const data = await request(listUrl(term)); if (seq !== catalogSeq) return;
      stableQuery = term; hero = data.hero; heroKind = data.heroKind; items = []; appendPage(data);
      if (initial && restore?.query === term) {
        while (cursor && items.length < restore.count) {
          const before = cursor, next = await request(listUrl(term, cursor)); if (seq !== catalogSeq) return;
          appendPage(next); if (before === cursor) break;
        }
      }
      render();
      if (initial && restore?.query === term) window.scrollTo(0, restore.y);
    } catch { if (seq === catalogSeq) results.replaceChildren(empty('配方暂时无法加载', null, button('重试', () => load(), 'secondary'))); }
    finally { if (seq === catalogSeq) results.setAttribute('aria-busy', 'false'); }
  }
  q.addEventListener('input', event => {++catalogSeq; clear.hidden = !q.value; clearTimeout(timer); if (!composing && !event.isComposing) timer = setTimeout(load, 300);});
  q.addEventListener('compositionstart', () => {composing = true; ++catalogSeq; clearTimeout(timer);});
  q.addEventListener('compositionend', () => {composing = false; clear.hidden = !q.value; clearTimeout(timer); timer = setTimeout(load, 300);});
  search.addEventListener('submit', e => {e.preventDefault(); if (composing) return; clearTimeout(timer); void load();});
  await load(true);
}

async function library() {
  document.title = '我的配方 · Vonvon Bot';
  const labels = {all:'全部',acquired:'已获取',drafts:'创作中',published:'我发布的'};
  let selected = Object.hasOwn(labels,params.get('state')) ? params.get('state') : 'all';
  const heading = group('library-heading', group('intro', el('p','个人配方库','eyebrow'),el('h1','我的配方'),el('p','获取和发布的配方，都在这里。','muted')));
  const tabs = el('nav', null, 'library-filters'); tabs.setAttribute('aria-label', '配方状态');
  const content = group('library-content');
  main.replaceChildren(backLink('浏览社区', '/'), heading, tabs, content);
  const updateTabs = () => {for (const tab of tabs.children) tab.setAttribute('aria-pressed',String(tab.dataset.state === selected));};
  for (const value of Object.keys(labels)) {
    const tab = button(labels[value], () => {
      selected = value; updateTabs();
      history.replaceState(history.state,'',value === 'all' ? '/library' : '/library?state=' + value);
      if (session?.signedIn) void refresh();
    }, 'library-filter'); tab.dataset.state = value; tabs.append(tab);
  }
  updateTabs();
  if (!session?.signedIn) {
    content.append(empty('登录后查看我的配方','获取配方和创建自己的配方，都使用同一个账号。',button('登录',() => openLogin(selected === 'all' ? '/library' : '/library?state=' + selected))));
    return;
  }
  const displaySession = session.displaySession, idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const pages = new Map(), versions = new Map(), choices = new Map(), versionRequests = new Map(), selectionRequests = new Map();
  let generation = 0, owner = new AbortController();
  const cacheKey = (scope,recipeId) => scope + '/' + recipeId;
  const signal = () => AbortSignal.any([owner.signal,AbortSignal.timeout(12_000)]);
  const current = (seq,scope) => seq === generation && scope === selected;
  async function checkSession(lease) {
    const value = await request('/auth/session',{signal:lease});
    if (!value.signedIn || value.displaySession !== displaySession) throw new RequestError(409,'session_changed');
  }
  function clearCaches() {pages.clear();versions.clear();choices.clear();versionRequests.clear();selectionRequests.clear();}
  function privateFailure(error) {
    if (![401,409].includes(error.status) && error.code !== 'session_changed') return false;
    ++generation; owner.abort(); clearCaches(); content.replaceChildren(); content.setAttribute('aria-busy','false'); location.reload(); return true;
  }
  function summary(item,recipeId) {
    if (!item || !idPattern.test(item.recipeId || '') || !idPattern.test(item.versionId || '') ||
        recipeId && item.recipeId !== recipeId || !Number.isInteger(item.revision) || item.revision < 1 ||
        typeof item.public?.name !== 'string' || typeof item.public?.version !== 'string' ||
        !['listed','withdrawn','deleted'].includes(item.state) || typeof item.owned !== 'boolean' || typeof item.acquired !== 'boolean') throw new Error('invalid_page');
    return item;
  }
  function page(value,recipeId) {
    if (!value || !Array.isArray(value.items) || value.items.length > 50 ||
        value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 1600 || !/^[a-f0-9]+[.][a-f0-9]{64}$/.test(value.nextCursor))) throw new Error('invalid_page');
    for (const item of value.items) {summary(item,recipeId);if (!recipeId && (!Number.isInteger(item.versionCount) || item.versionCount < 1)) throw new Error('invalid_page');}
    return value;
  }
  function merge(before,next,key) {
    const items = [...(before?.items || [])], seen = new Set(items.map(item=>item[key]));
    for (const item of next.items) if (!seen.has(item[key])) {seen.add(item[key]);items.push(item);}
    return {items,nextCursor:next.nextCursor};
  }
  async function loadVersions(scope,root,panel,seq,more = false) {
    const key = cacheKey(scope,root.recipeId), requestId = (versionRequests.get(key) || 0) + 1;
    versionRequests.set(key,requestId);
    const valid = () => current(seq,scope) && versionRequests.get(key) === requestId && panel.isConnected;
    panel.replaceChildren(el('p','正在读取版本…','fine'));
    try {
      const lease = signal(); await checkSession(lease); if (!valid()) return;
      let stored = versions.get(key);
      if (!stored || more && stored.nextCursor) {
        const query = new URLSearchParams({scope}); if (more) query.set('cursor',stored.nextCursor);
        const result = page(await request('/api/v2/me/recipe-groups/' + encodeURIComponent(root.recipeId) + '/versions?' + query,
          {signal:lease,headers:{'X-Vonvon-Session':displaySession}}),root.recipeId);
        if (!valid()) return;
        stored = merge(more ? stored : undefined,result,'versionId'); versions.set(key,stored);
      }
      if (!valid()) return;
      const options = el('div',null,'library-version-options');
      for (const item of stored.items) {
        const option = button('版本 ' + item.public.version + (item.state === 'withdrawn' ? ' · 已下架' : item.state === 'deleted' ? ' · 已删除' : ''),async()=>{
          if (!current(seq,scope) || !option.isConnected) return;
          const intent = (selectionRequests.get(key) || 0) + 1; selectionRequests.set(key,intent);
          try {
            await checkSession(signal()); if (!current(seq,scope) || !option.isConnected || selectionRequests.get(key) !== intent) return;
            choices.set(key,item); render(scope);
          } catch(error) {if (current(seq,scope) && selectionRequests.get(key) === intent && !privateFailure(error)) message('暂时无法切换版本，请重试。');}
        },'secondary library-version-option');
        option.dataset.versionId = item.versionId;
        option.setAttribute('aria-pressed',String((choices.get(key)?.versionId || root.versionId) === item.versionId)); options.append(option);
      }
      panel.replaceChildren(options);
      panel.append(el('p','已加载 ' + stored.items.length + ' 个可查看版本','fine library-version-count'));
      if (!stored.items.length) panel.append(el('p','暂时没有可查看的版本。','fine'));
      if (stored.nextCursor) panel.append(button('加载更多版本',()=>{void loadVersions(scope,root,panel,seq,true);},'secondary library-version-more'));
    } catch (error) {
      if (!valid()) return;
      if (privateFailure(error)) return;
      panel.replaceChildren(el('p','版本暂时无法读取。','fine'),button('重新读取版本',()=>{void loadVersions(scope,root,panel,seq,more);},'secondary'));
    }
  }
  // The link from a detail page carries both IDs. Resolve ownership again with the current session.
  const focus = new URLSearchParams(new URL(location.href,location.origin).hash.slice(1));
  const focusRecipe = focus.get('recipe'), focusVersion = focus.get('version');
  let focused = false;
  async function resolveFocus(scope, seq, lease) {
    if (focused || !idPattern.test(focusRecipe || '') || !idPattern.test(focusVersion || '')) return;
    const query = new URLSearchParams({scope});
    const headers = {'X-Vonvon-Session':displaySession};
    let root = pages.get(scope)?.items.find(item => item.recipeId === focusRecipe);
    if (!root) {
      const groupVersions = page(await request('/api/v2/me/recipe-groups/' + focusRecipe + '/versions?' + query, {headers,signal:lease}),focusRecipe);
      if (!current(seq,scope) || !groupVersions.items.length) return;
      versions.set(cacheKey(scope,focusRecipe), groupVersions);
    }
    const detail = await readDetail('/recipes/' + focusRecipe + '/versions/' + focusVersion, displaySession);
    if (!current(seq,scope) || !(scope === 'published' ? detail.owned : detail.acquired) || detail.recipeId !== focusRecipe || detail.versionId !== focusVersion) return;
    const key = cacheKey(scope,focusRecipe);
    choices.set(key, detail);
    if (!root) {
      const stored = versions.get(key);
      root = {...stored.items[0],versionCount:stored.nextCursor ? null : stored.items.length};
      // Pin the linked recipe separately from cursor pages so pagination stays stable.
      pinnedGroup = root;
    }
    focused = true;
  }
  let pinnedGroup;
  function render(scope) {
    const cards = group('cards library-cards'), seq = generation;
    const rows = pages.get(scope)?.items || [];
    for (const root of pinnedGroup && choices.has(cacheKey(scope,pinnedGroup.recipeId)) && !rows.some(item => item.recipeId === pinnedGroup.recipeId) ? [pinnedGroup,...rows] : rows) {
      const key = cacheKey(scope,root.recipeId), item = choices.get(key) || root;
      const row = card(item,false,scope === 'all' ? 'library-all' : scope === 'acquired' ? 'library' : 'published');
      row.dataset.recipeId = root.recipeId;
      if (item.state !== 'listed') row.append(el('span',item.state === 'deleted' ? '已删除' : '已下架','fine'));
      const panel = group('library-version-panel'); panel.hidden = true;
      const toggle = button(root.versionCount == null ? '选择版本' : '选择版本（' + root.versionCount + '）',()=>{
        if (!current(seq,scope)) return;
        panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded',String(!panel.hidden));
        if (!panel.hidden) void loadVersions(scope,root,panel,seq);
      },'secondary library-version-toggle'); toggle.setAttribute('aria-expanded','false');
      if (root.versionCount == null || root.versionCount > 1) row.append(toggle,panel);
      if (item.owned && item.state !== 'deleted') {
        const remove = () => {
          const cancel = button('取消', dismissDialog, 'secondary');
          const confirm = button('确认删除', async () => {
            if (!current(seq,scope) || confirm.disabled) return;
            confirm.disabled = true;
            try {
              await request('/api/v2/versions/' + item.versionId + '/delete', {method: 'POST', headers: {
                'Content-Type': 'application/json', 'X-Vonvon-Session': displaySession}, body: '{}'});
              if (current(seq,scope)) {if (dialog.contains(confirm)) dismissDialog(); clearCaches(); await refresh();}
            } catch {
              if (current(seq,scope)) {if (dialog.contains(confirm)) dismissDialog(); message('删除结果尚未确认，请刷新后核对该版本。');}
            }
          }, 'button');
          modal('删除此版本？', el('p','「' + item.public.name + ' · ' + item.public.version + '」删除后无法恢复。剩余分享码会停用，已获取者会看到「已删除」。'),
            el('p','其他版本和已经部署的群聊继续使用。'), group('actions',cancel,confirm));
          cancel.focus();
        };
        const controls = group('library-version-controls');
        controls.append(button('删除此版本',remove,'text-button')); row.append(controls);
      }
      cards.append(row);
    }
    content.replaceChildren(cards);
    if (!cards.childElementCount) content.append(empty('暂时没有' + (scope === 'all' ? '' : labels[scope]) + '配方','可以先去社区看看，也可以创建自己的配方。',link('浏览社区','/','secondary')));
    if (pages.get(scope)?.nextCursor) content.append(button('加载更多',()=>{void refresh(true);},'secondary more'));
  }
  function localDrafts() {
    const channel = document.documentElement.dataset.desktopChannel;
    const expected = channel === 'preview' ? 'vonvon-preview://recipes/drafts' : channel === 'stable' ? 'vonvon://recipes/drafts' : undefined;
    const configured = document.documentElement.dataset.recipeDraftsUrl;
    const action = expected && (!configured || configured === expected) ? link('在 App 中继续创作',expected,'button') : null;
    if (action) action.setAttribute('data-app-drafts','');
    content.replaceChildren(empty('在本地继续整理配方','创作中的配方保存在本地，发布后才会同步到社区。',action));
  }
  async function refresh(more = false) {
    const seq = ++generation, scope = selected;
    owner.abort(); owner = new AbortController(); const lease = signal();
    content.setAttribute('aria-busy','true');
    if (!more) content.replaceChildren(el('p','正在读取配方…','catalog-status'));
    else for (const value of content.querySelectorAll('button')) value.disabled = true;
    try {
      await checkSession(lease); if (!current(seq,scope)) return;
      if (scope === 'drafts') {localDrafts();return;}
      const before = pages.get(scope);
      if (!before || more && before.nextCursor) {
        const query = new URLSearchParams({scope}); if (more) query.set('cursor',before.nextCursor);
        const next = page(await request('/api/v2/me/recipe-groups?' + query,{signal:lease,headers:{'X-Vonvon-Session':displaySession}}));
        if (!current(seq,scope)) return;
        pages.set(scope,merge(more ? before : undefined,next,'recipeId'));
      }
      if (!more && !focused && (scope === 'published' || scope === 'acquired')) {
        try {await resolveFocus(scope,seq,lease);} catch (error) {if (error.status !== 404) throw error;}
      }
      if (current(seq,scope)) {
        render(scope);
        if (!more && focused && focusRecipe) content.querySelector('[data-recipe-id="' + focusRecipe + '"]')?.scrollIntoView?.({block:'nearest'});
      }
    } catch (error) {
      if (!current(seq,scope)) return;
      if (privateFailure(error)) return;
      content.replaceChildren(empty('暂时无法读取配方','请稍后重试。',button('重新读取',()=>{void refresh(more);},'secondary')));
    } finally {if (current(seq,scope)) content.setAttribute('aria-busy','false');}
  }
  window.addEventListener('focus',()=>{clearCaches();void refresh();});
  await refresh();
}

async function authorPage(authorId) {
  const data = await request('/api/v2/authors/' + encodeURIComponent(authorId) + '/recipes');
  document.title = data.creator.displayName + '的配方 · Vonvon Bot';
  const intro = group('catalog-intro', el('p', '社区作者', 'eyebrow'), el('h1', data.creator.displayName), el('p', '发布的配方'));
  const cards = group('cards'), seen = new Set(); let cursor;
  const more = button('加载更多', async () => {
    if (more.disabled || !cursor) return; more.disabled = true;
    try {add(await request('/api/v2/authors/' + encodeURIComponent(authorId) + '/recipes?cursor=' + encodeURIComponent(cursor)));}
    catch {message('加载失败，请重试。');}
    finally {more.disabled = false;}
  }, 'secondary more');
  function add(page) {
    for (const item of page.items) if (!seen.has(item.recipeId)) {seen.add(item.recipeId); cards.append(card(item, false, 'author', authorId));}
    cursor = page.nextCursor; more.hidden = !cursor;
  }
  add(data);
  main.replaceChildren(backLink('返回 Bot 配方', '/'), communityNav(), intro, cards, more);
  if (!data.items.length) main.append(empty('暂时没有公开发布的配方'));
}

function metric(label, value) { return group('metric', el('span', label), el('strong', value)); }
async function readDetail(path, displaySession) {
  const options = displaySession ? {headers: {'X-Vonvon-Session': displaySession}} : {};
  return request('/api/v2' + path + '/preview', options);
}
async function detail(confirmed) {
  const generation = ++detailGeneration, path = location.pathname;
  const detailSession = session?.displaySession;
  const currentDetail = () => generation === detailGeneration && path === location.pathname && detailSession === session?.displaySession;
  const data = confirmed ?? await readDetail(path, detailSession);
  if (!currentDetail()) return;
  if (path.toLowerCase() !== detailUrl(data).toLowerCase()) throw new Error('unconfirmed');
  async function resumeAcquisition() {
    const pending = storedContinuation();
    if (!currentDetail() || session?.continuation !== path || pending?.path !== path || !/^[a-f0-9]{64}$/.test(pending.nonce)) return;
    const result = await request('/auth/continuation', {method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'X-Vonvon-Session': detailSession,
    }, body: new URLSearchParams({returnTo: path, continuationNonce: pending.nonce}).toString()});
    if (!currentDetail()) return;
    clearContinuation(pending.nonce);
    delete session.continuation;
    if (result.consumed && !data.acquired && !data.owned) {
      const trigger = [...main.querySelectorAll('button')].find(b => b.textContent === '获取配方');
      if (trigger) await claim(data, trigger, detailSession, currentDetail, true);
    }
  }
  const p = data.public; document.title = p.name + ' · Vonvon Bot';
  if (data.format === 'rich-v2' || data.preview || data.previewUnavailable || ['withdrawn','deleted'].includes(data.state)) {
    const {renderRecipe} = await import('/viewer.mjs');
    if (!currentDetail()) return;
    renderRecipe(main, data, trigger => claim(data, trigger, detailSession, currentDetail), detailOrigin());
    await resumeAcquisition();
    return;
  }
  const actions = group('actions');
  const channel = document.documentElement.dataset.desktopChannel;
  const appScheme = channel === 'preview' ? 'vonvon-preview' : channel === 'stable' ? 'vonvon' : undefined;
  if (appScheme && (data.acquired || data.owned)) {
    const handoff = link('在 App 中交给 Bot', appScheme + '://recipes/' + data.recipeId + '/versions/' + data.versionId + '/handoff', 'secondary');
    handoff.setAttribute('data-handoff-recipe',''); handoff.dataset.recipeId = data.recipeId; handoff.dataset.versionId = data.versionId;
    actions.append(handoff);
  }
  if (data.acquired || data.owned) actions.append(el('span', data.owned ? '我的作品' : '已获取', 'pill'));
  else {
    const acquire = button('获取配方', ev => claim(data, ev.currentTarget, detailSession, currentDetail));
    actions.append(acquire);
  }
  const top = group('page-top detail-title', group('intro', el('p', 'Bot 配方', 'eyebrow'), el('h1', p.name), el('p', p.summary, 'muted')), actions);
  const meta = group('metrics panel', ...(data.creator ? [group('metric', el('span', '作者'), link(data.creator.displayName, '/?q=' + encodeURIComponent(data.creator.displayName), 'author-link'))] : []), metric('版本', p.version), metric('获取方式', p.access === 'coded' ? '需要分享码' : '直接获取'));
  const content = el('section');
  const overview = () => {
    content.replaceChildren(meta);
    const prose = el('article', null, 'prose');
    if (p.overview) { content.append(prose); import('./markdown.mjs').then(({ markdown }) => { prose.innerHTML = markdown(p.overview); }).catch(() => { prose.textContent = p.overview; }); }
    if (data.config?.setup?.steps.length) {
      const notes = el('details', null, 'additional-notes'); notes.append(el('summary', '补充说明'));
      for (const step of data.config.setup.steps) {
        const item = el('article'); item.append(el('h3', step.title), el('p', step.instructions));
        if (step.check) item.append(el('p', '核对方式：' + step.check));
        notes.append(item);
      }
      content.append(notes);
    }
  };
  const tabs = group('tabs');
  function setTab(mode) {
    for (const elem of tabs.children) elem.setAttribute('aria-pressed', String(elem.dataset.tab === mode));
    if (mode === 'intro') overview();
    else {
      content.replaceChildren(el('h2', '角色', 'section-title'), el('p', data.config.role || '未指定', 'panel role'));
    }
  }
  for (const [key,label] of [['intro','概览'], ...(Object.hasOwn(data, 'config') ? [['settings','配置']] : [])]) {
    const b = button(label, () => setTab(key), 'secondary'); b.dataset.tab = key; tabs.append(b);
  }
  tabs.classList.add('web-contents');
  main.replaceChildren(detailBack(), top, tabs, content); setTab('intro');
  await resumeAcquisition();
}

function newAcquisitionKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let n = 5; n >= 0; n--) {bytes[n] = time % 256; time = Math.floor(time / 256);}
  bytes[6] = 0x70 | (bytes[6] & 15); bytes[8] = 0x80 | (bytes[8] & 63);
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `a2.${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
async function claim(recipe, trigger, sessionId, currentDetail, resumed = false) {
  if (!currentDetail()) return;
  if (!session?.signedIn) return openLogin(detailReturnPath(), 'acquire');
  const coded = recipe.public.access === 'coded';
  const confirmation = coded || resumed;
  const logical = sessionId + ':' + recipe.versionId;
  const intent = claimIntents.get(logical) ?? {input: ''};
  claimIntents.set(logical, intent);
  const form = el('form'), field = el('input'), error = el('p', null, 'error');
  const confirm = el('button', '获取配方', 'button');
  field.value = intent.input;
  if (confirmation) {
    field.required = true; field.maxLength = 128; field.autocomplete = 'off'; field.placeholder = '作者提供的分享码'; field.setAttribute('aria-label', '分享码');
    form.append(...(coded ? [field] : [el('p', '确认获取这个版本的配方？')]), error, group('actions', button('取消', () => {if (current()) dismissDialog();}, 'secondary'), confirm));
    modal(coded ? '输入分享码' : '确认获取配方', group('claim-recipe', el('strong', recipe.public.name), el('span', versionLabel(recipe))), form);
  }
  const modalId = modalGeneration;
  const current = () => currentDetail() && (!confirmation || modalId === modalGeneration);
  if (confirmation) {
    releaseModal = () => {if (currentDetail()) trigger.disabled = false;};
    field.addEventListener('input', () => {if (current()) intent.input = field.value;});
  }
  async function reconcile() {
    const next = await readDetail('/recipes/' + recipe.recipeId + '/versions/' + recipe.versionId, sessionId);
    if (!current()) return;
    if (next.versionId !== recipe.versionId || next.recipeId !== recipe.recipeId) throw new Error('unconfirmed');
    if (next.owned || next.acquired) {
      claimIntents.delete(logical);
      if (confirmation) closeDialog();
      message('已获取配方'); await detail(next);
    }
    return next;
  }
  async function submit() {
    if (!current()) return;
    confirm.disabled = trigger.disabled = true; error.textContent = '';
    intent.input = field.value;
    const raw = intent.input.trim();
    const attempt = intent.submitted;
    try {
      if (attempt && attempt.raw !== raw) {
        const next = await reconcile();
        if (!current() || !next || next.owned || next.acquired) return;
        delete intent.submitted;
        error.textContent = '已确认尚未获取。请再次点击获取，提交当前输入。'; return;
      }
      const submitted = intent.submitted ??= {raw, key: newAcquisitionKey()};
      await request('/api/' + (recipe.format === 'rich-v2' ? 'v2' : 'v1') + '/versions/' + recipe.versionId + (coded ? '/redeem' : '/acquire'), {
        method: 'POST', headers: {'Content-Type':'application/json', 'Idempotency-Key':submitted.key, 'X-Vonvon-Session':sessionId},
        body: JSON.stringify(coded ? {code: submitted.raw} : {}),
      });
      if (!current()) return;
      await reconcile();
    } catch (e) {
      if (!current()) return;
      if (['operation_expired', 'request_upgrade_required', 'operation_clock_skew'].includes(e.code)) {
        try {
          const next = await reconcile();
          if (!current() || !next || next.owned || next.acquired) return;
          delete intent.submitted;
          const msg = e.code === 'operation_clock_skew' ? '已确认尚未获取。请校准设备时间后，再次点击获取，重新提交。' : '已确认尚未获取。请再次点击获取，重新提交。';
          if (confirmation) error.textContent = msg; else message(msg);
        } catch {if (current()) {if (confirmation) error.textContent = '获取结果暂未确认，请保留输入并重试。'; else message('获取结果暂未确认，请重试。');}}
        return;
      }
      if (e.code === 'session_changed') {location.reload(); return;}
      if (e.status === 401) {session.signedIn = false; accountButton.textContent = '登录'; openLogin(detailReturnPath(), 'acquire'); return;}
      if (e.code === 'invalid_code') delete intent.submitted;
      const msg = e.status === 429 ? '操作过于频繁，请保留输入。' + (e.retryAfter ? ` 请在 ${e.retryAfter} 秒后重试。` : '') :
        e.code === 'invalid_code' ? '这个分享码无法兑换此版本，请核对后重试。' : '获取结果暂未确认，请重试同一操作。';
      if (confirmation) error.textContent = msg; else message(msg);
    } finally {if (current()) confirm.disabled = trigger.disabled = false;}
  }
  if (confirmation) form.addEventListener('submit', ev => {ev.preventDefault(); if (!confirm.disabled && (!coded || field.value.trim())) submit();});
  else await submit();
}

accountButton.addEventListener('click', account);
dialog.addEventListener('cancel', ev => {ev.preventDefault(); dismissDialog();});
try {
  if (params.has('auth')) clearContinuation();
  session = await request('/auth/session');
  accountButton.hidden = Boolean(session.signedIn); accountButton.textContent = '登录';
  if (session.signedIn) void accountMenu();
  if (location.pathname !== '/' && !appGuide) mountSearch();
  if (location.pathname === '/') await home();
  else if (location.pathname === '/library') await library();
  else if (['/publications','/creators'].includes(location.pathname)) location.assign('/library?state=published');
  else if (/^\/authors\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(location.pathname)) await authorPage(location.pathname.split('/')[2]);
  else if (!appGuide) await detail();
  if (params.has('auth')) message('登录未完成，请重试。');
  if (params.get('login') === '1') openLogin(appGuide || params.get('next') === 'studio' ? '/studio' : '/');
  if (params.has('login') || params.has('auth')) {
    const url = new URL(location.href); for (const k of ['login','auth','next']) url.searchParams.delete(k);
    history.replaceState(history.state, '', url);
  }
} catch (e) {
  if (!appGuide) main.replaceChildren(detailBack(), empty(e.status === 404 ? '找不到这份配方' : '暂时无法打开', null, button('重试', () => location.reload(), 'secondary')));
}
let checkingSession = false;
async function checkSession() {
  if (document.visibilityState !== 'visible' || !session || checkingSession) return;
  checkingSession = true;
  try {
    const current = await request('/auth/session');
    if (current.signedIn !== session.signedIn || current.displaySession !== session.displaySession) {
      ++detailGeneration; closeDialog();
      if (!appGuide) main.replaceChildren();
      location.reload();
    }
  } catch { /* A later action will report any connection or session error. */ }
  finally { checkingSession = false; }
}
document.addEventListener('visibilitychange', checkSession);
window.addEventListener('focus', checkSession);
const authEvents = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vv-recipe-auth') : null;
if (authEvents) {
  authEvents.onmessage = checkSession;
  authEvents.postMessage('check');
}
// The browser may restore a sensitive detail from its back/forward cache after logout.
window.addEventListener('pageshow', ev => { if (ev.persisted && location.pathname !== '/') location.reload(); });
