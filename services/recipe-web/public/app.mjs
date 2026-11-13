import {setupList} from './setup.mjs';
const main = document.querySelector('#main');
const dialog = document.querySelector('#modal');
const accountButton = document.querySelector('#account');
const params = new URLSearchParams(location.search);
const claimRequests = new WeakMap();
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
  constructor(status, code) { super(code); this.status = status; }
}
async function request(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await res.json();
  if (!res.ok) throw new RequestError(res.status, data.error?.code);
  return data;
}
function modal(title, ...nodes) {
  if (dialog.open) dialog.close();
  const h = el('h2', title); h.id = 'dialog-title';
  dialog.setAttribute('aria-labelledby', h.id); dialog.replaceChildren(h, ...nodes);
  dialog.showModal();
}
const closeDialog = () => dialog.close();
const closeButton = () => button('关闭', closeDialog, 'secondary');
const labels = { github: 'GitHub', google: 'Google', apple: 'Apple' };
function openLogin(next = location.pathname) {
  const forms = (session?.providers || []).filter(p => Object.hasOwn(labels, p)).map(p => {
    const form = el('form', null, 'provider'); form.method = 'post'; form.action = '/auth/start';
    for (const [name, value] of Object.entries({ provider: p, returnTo: next })) {
      const field = el('input'); field.type = 'hidden'; field.name = name; field.value = value; form.append(field);
    }
    const submit = el('button', '使用 ' + labels[p] + ' 登录', 'secondary'); form.append(submit); return form;
  });
  if (!forms.length) forms.push(el('p', '暂时无法登录，请稍后再试。', 'muted'));
  modal('登录', ...forms, group('actions', closeButton()));
}
function account() {
  if (!session?.signedIn) return openLogin();
  const logout = el('form'); logout.method = 'post'; logout.action = '/auth/logout';
  logout.append(el('button', '退出登录', 'secondary'));
  modal('账号', link('查看已获取的配方', '/library'), group('actions', logout, closeButton()));
}
function empty(title, description, action) {
  const box = group('empty', el('h2', title));
  if (description) box.append(el('p', description));
  if (action) box.append(action);
  return box;
}
const detailUrl = item => '/recipes/' + encodeURIComponent(item.recipeId) + '/versions/' + encodeURIComponent(item.versionId);
const versionLabel = item => '版本 ' + item.public.version;

function card(item, hero = false) {
  const a = link(null, detailUrl(item), hero ? 'hero' : 'card');
  const p = item.public;
  if (hero) {
    const text = group('intro', el('h2', p.name), el('p', p.summary));
    const cta = el('span', '查看配方 →', 'button'); text.append(group('row', cta));
    const ticket = group('ticket', el('strong', p.name), el('span', versionLabel(item)));
    ticket.setAttribute('aria-hidden', 'true'); a.append(text, ticket);
  } else a.append(el('h3', p.name), el('p', p.summary), el('span', versionLabel(item) + (p.access === 'coded' ? ' · 需分享码' : ''), 'fine'));
  return a;
}

async function home() {
  const title = el('h1', '社区');
  const seg = group('seg', el('strong', 'Bot 配方'), group('', el('span', 'Bot 租赁'), el('small', '敬请期待')));
  const search = el('form', null, 'search'), q = el('input');
  q.type = 'search'; q.maxLength = 120; q.placeholder = '搜索配方'; q.setAttribute('aria-label', '搜索配方');
  q.value = params.get('q')?.slice(0, 120) || ''; search.append(q);
  const results = el('section'); results.setAttribute('aria-label', '配方目录'); results.setAttribute('aria-busy','true');
  main.replaceChildren(group('page-top', title, seg), search, results);
  let cursor, items, hero, timer, stableQuery, loadingMore;
  const restore = history.state?.catalog;
  function remember() {
    history.replaceState({ catalog: { query: stableQuery, count: items?.length || 0, y: scrollY } }, '');
  }
  results.addEventListener('click', ev => { if (ev.target.closest('a[href]')) remember(); });
  function render() {
    results.replaceChildren();
    search.hidden = !stableQuery && !hero && !items.length;
    if (hero) results.append(el('h2', '最新配方', 'section-title'), card(hero, true));
    if (items.length) {
      results.append(el('h2', stableQuery ? '搜索结果' : (hero ? '更多配方' : '配方'), 'section-title'));
      results.append(group('cards', ...items.map(x => card(x))));
    }
    if (!hero && !items.length) results.append(stableQuery ?
      empty('没有找到匹配的配方', null, button('清除搜索', () => { q.value = ''; load(); }, 'secondary')) :
      empty('社区里还没有配方', '发布后，配方会出现在这里。', link('去创作中心', '/studio', 'secondary')));
    if (cursor) results.append(button('加载更多', more, 'secondary more'));
  }
  const listUrl = (s, next) => {
    const query = new URLSearchParams(); if (s) query.set('q', s);
    if (next) query.set('cursor', next);
    return '/api/v1/community/recipes?' + query;
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
    try {
      const data = await request(listUrl(term)); if (seq !== catalogSeq) return;
      stableQuery = term; hero = data.hero; items = []; appendPage(data);
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
  q.addEventListener('input', () => { ++catalogSeq; clearTimeout(timer); timer = setTimeout(load, 200); });
  search.addEventListener('submit', e => { e.preventDefault(); clearTimeout(timer); load(); });
  await load(true);
}

async function library() {
  main.replaceChildren(link('← 社区', '/', 'back'), group('page-top', el('h1', '已获取')));
  if (!session?.signedIn) { main.append(empty('登录后查看已获取的配方', null, button('登录', () => openLogin('/library')))); return; }
  const firstPage = await request('/api/v1/me/recipes');
  if (!firstPage.items.length) {
    main.append(empty('还没有获取配方', null, link('浏览社区', '/', 'secondary'))); return;
  }
  const cards = group('cards');
  const seen = new Set();
  let cursor;
  const next = button('加载更多', async () => {
    if (next.disabled || !cursor) return;
    next.disabled = true;
    try { add(await request('/api/v1/me/recipes?cursor=' + encodeURIComponent(cursor))); }
    catch { message('加载失败，请重试。'); }
    finally { next.disabled = false; }
  }, 'secondary more');
  function add(page) {
    for (const item of page.items) {
      if (!seen.has(item.recipeId)) { cards.append(card(item)); seen.add(item.recipeId); }
    }
    cursor = page.nextCursor;
    next.hidden = !cursor;
  }
  add(firstPage);
  main.append(cards, next);
}

async function copy(button) {
  const url = location.origin + location.pathname;
  try {
    await navigator.clipboard.writeText(url); button.textContent = '✓ 已复制';
    setTimeout(() => { button.textContent = '分享链接'; }, 2000);
  } catch {
    const box = el('input'); box.type = 'url'; box.readOnly = true; box.value = url; box.setAttribute('aria-label','配方链接');
    modal('复制分享链接', box, group('actions', closeButton())); box.select();
  }
}
function metric(label, value) { return group('metric', el('span', label), el('strong', value)); }
async function detail() {
  const detailSession = session?.displaySession;
  const data = await request('/api/v1' + location.pathname);
  const p = data.public; document.title = p.name + ' · Vonvon Bot';
  const sharing = button('分享链接', ev => copy(ev.currentTarget), 'secondary');
  const actions = group('actions', sharing);
  if (data.acquired || data.owned) actions.append(el('span', data.owned ? '我的作品' : '已获取', 'pill'));
  else actions.append(button('获取配方', ev => claim(data, ev.currentTarget, detailSession)));
  const top = group('page-top detail-title', group('intro', el('p', 'Bot 配方', 'eyebrow'), el('h1', p.name), el('p', p.summary, 'muted')), actions);
  const meta = group('metrics panel', metric('版本', p.version), metric('获取方式', p.access === 'coded' ? '需要分享码' : '直接获取'));
  const content = el('section');
  const overview = () => {
    content.replaceChildren(meta);
    const prose = el('article', null, 'prose');
    if (p.overview) { content.append(prose); import('./markdown.mjs').then(({ markdown }) => { prose.innerHTML = markdown(p.overview); }).catch(() => { prose.textContent = p.overview; }); }
  };
  const tabs = group('tabs');
  function setTab(mode) {
    for (const elem of tabs.children) elem.setAttribute('aria-pressed', String(elem.dataset.tab === mode));
    if (mode === 'intro') overview();
    else {
      content.replaceChildren(el('h2', '角色', 'section-title'), el('p', data.config.role || '未指定', 'panel role'));
      if (data.config.setup?.steps.length) content.append(el('h2', '使用前准备', 'section-title'), setupList(data.config.setup.steps));
    }
  }
  for (const [key,label] of [['intro','概览'], ...(Object.hasOwn(data, 'config') ? [['settings','配置']] : [])]) {
    const b = button(label, () => setTab(key), 'secondary'); b.dataset.tab = key; tabs.append(b);
  }
  main.replaceChildren(link('← 社区', '/', 'back'), top, tabs, content); setTab('intro');
}

async function claim(recipe, trigger, generation) {
  if (!session?.signedIn) return openLogin();
  const coded = recipe.public.access === 'coded';
  const form = el('form'); const field = el('input'), error = el('p', null, 'error');
  const confirm = el('button', '获取配方', 'button');
  if (coded) {
    field.required = true; field.maxLength = 128; field.autocomplete = 'off'; field.placeholder = '输入分享码'; field.setAttribute('aria-label', '分享码');
    form.append(field, error, group('actions', button('取消', closeDialog, 'secondary'), confirm));
    modal('输入分享码', form);
  }
  const requestIds = claimRequests.get(recipe) || new Map();
  claimRequests.set(recipe, requestIds);
  async function submit() {
    confirm.disabled = trigger.disabled = true; error.textContent = '';
    const code = field.value.trim(); const key = requestIds.get(code) || crypto.randomUUID();
    requestIds.set(code, key);
    try {
      await request('/api/v1/versions/' + recipe.versionId + (coded ? '/redeem' : '/acquire'), {
        method: 'POST', headers: {'Content-Type':'application/json', 'Idempotency-Key':key, 'X-Vonvon-Session':generation},
        body: JSON.stringify(coded ? {code} : {}),
      });
      if (dialog.open) dialog.close(); message('已获取配方'); await detail();
    } catch (e) {
      if (e.message === 'session_changed') { location.reload(); return; }
      if (e.status === 401) { session.signedIn = false; accountButton.textContent = '登录'; openLogin(); }
      else {
        const msg = e.status === 429 ? '操作过于频繁，请稍后再试。' :
          (coded && [400,403,404,409,422].includes(e.status) ? '这个分享码无法兑换此版本，请核对后重试。' : '获取结果暂未确认，请重试。');
        if (coded && dialog.open) error.textContent = msg; else message(msg);
      }
    } finally { confirm.disabled = trigger.disabled = false; }
  }
  if (coded) form.addEventListener('submit', ev => { ev.preventDefault(); if (!confirm.disabled && field.value.trim()) submit(); });
  else await submit();
}

accountButton.addEventListener('click', account);
try {
  session = await request('/auth/session');
  accountButton.hidden = false; accountButton.textContent = session.signedIn ? '账号' : '登录';
  if (location.pathname === '/') await home();
  else if (location.pathname === '/library') await library();
  else await detail();
  if (params.has('auth')) message('登录未完成，请重试。');
  if (params.get('login') === '1') openLogin(params.get('next') === 'studio' ? '/studio' : '/');
  if (params.has('login') || params.has('auth')) {
    const url = new URL(location.href); for (const k of ['login','auth','next']) url.searchParams.delete(k);
    history.replaceState(history.state, '', url);
  }
} catch (e) {
  main.replaceChildren(link('← 社区', '/', 'back'), empty(e.status === 404 ? '找不到这份配方' : '暂时无法打开', null, button('重试', () => location.reload(), 'secondary')));
}
let checkingSession = false;
async function checkSession() {
  if (document.visibilityState !== 'visible' || !session || checkingSession) return;
  checkingSession = true;
  try {
    const current = await request('/auth/session');
    if (current.signedIn !== session.signedIn || current.displaySession !== session.displaySession) {
      if (dialog.open) dialog.close();
      main.replaceChildren();
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
