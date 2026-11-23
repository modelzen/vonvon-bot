const $ = id => document.getElementById(id);
const list = $('creators-list'), status = $('creators-status'), login = $('creators-login'), retry = $('creators-retry');
const account = $('creators-account');
const accountLinks = [account, ...document.querySelectorAll('[data-creators-account]')];
const accountUrl = document.documentElement.dataset.accountUrl || '/account';
const tabs = [...document.querySelectorAll('[data-tab]')];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const community = new URL(document.documentElement.dataset.communityUrl || '/', location.origin);
let tab = 'published', generation = 0, owner = new AbortController();
const events = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vv-recipe-auth') : null;
const element = (tag, text, className) => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
  if (className) node.className = className; return node;
};
const link = (text, href, className) => {const node = element('a', text, className); node.href = href; return node;};
function clear() {list.replaceChildren(); login.hidden = true; retry.hidden = true; account.replaceChildren(document.createTextNode('账号')); for (const link of accountLinks) {link.removeAttribute('href'); link.setAttribute('aria-disabled','true'); link.tabIndex = -1;}}
function enableAccount(href) {for (const link of accountLinks) {link.href = href; link.removeAttribute('aria-disabled'); link.removeAttribute('tabindex');}}
async function request(path, signal, displaySession) {
  const response = await fetch(path, {credentials:'same-origin', cache:'no-store', signal,
    ...(displaySession && {headers:{'X-Vonvon-Session':displaySession}})});
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data?.error?.code || 'unavailable'), {status:response.status});
  return data;
}
function card(item, selected) {
  if (!item || !uuid.test(selected === 'published' ? item.recipeId : item.draftId) ||
      !Number.isInteger(item.revision) || item.revision < 1 || item.revision > 2147483647 ||
      selected === 'published' && !uuid.test(item.versionId)) throw new Error('invalid_item');
  const info = item.public;
  if (!info || typeof info.name !== 'string') throw new Error('invalid_item');
  const row = element('article', undefined, 'creator-row'), content = element('div');
  content.append(element('h2', info.name || '未命名配方'));
  if (typeof info.summary === 'string' && info.summary) content.append(element('p', info.summary));
  const meta = element('div', undefined, 'creator-meta');
  meta.append(element('span', typeof info.version === 'string' ? info.version : '修订 ' + item.revision));
  if (selected === 'published') {
    meta.append(element('span', info.access === 'coded' ? '需获取码' : '可直接获取'));
    if (typeof item.creator?.displayName === 'string') {
      const author = new URL(community); author.searchParams.set('q', item.creator.displayName);
      meta.append(link(item.creator.displayName, author.href));
    }
    const destination = new URL('recipes/' + item.recipeId + '/versions/' + item.versionId, community);
    destination.searchParams.set('from', 'creator');
    row.append(content, link('查看配方', destination.href, 'secondary'));
  } else {
    meta.append(element('span', '尚未发布'));
    row.append(content, link('在 App 中继续', '/open/draft#' + item.draftId.toLowerCase() + '?revision=' + item.revision, 'secondary'));
  }
  content.append(meta); return row;
}
async function readAccount(session, signal, seq) {
  try {
    const profile = await request('/api/v2/me/account-profile', signal, session.displaySession);
    if (seq !== generation || !uuid.test(profile?.authorId || '') || typeof profile.displayName !== 'string' || !profile.displayName) return;
    const target = new URL(accountUrl, location.origin); target.hash = 'account=' + profile.authorId.toLowerCase();
    enableAccount(target.href); account.replaceChildren(document.createTextNode(profile.displayName));
    if (typeof profile.avatarDataUrl === 'string' && profile.avatarDataUrl.length <= 174787 && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(profile.avatarDataUrl)) {
      const avatar = element('img'); avatar.src = profile.avatarDataUrl; avatar.alt = ''; avatar.width = 24; avatar.height = 24;
      avatar.style.borderRadius = '50%'; account.prepend(avatar);
    }
  } catch (error) {
    if (seq !== generation || ![401,409].includes(error.status)) return;
    ++generation; owner.abort(); clear(); list.setAttribute('aria-busy','false');
    if (error.status === 401) {status.textContent = '登录已过期，请重新登录。'; login.hidden = false; account.textContent = '登录'; enableAccount('/login?returnTo=%2Fcreators');}
    else {status.textContent = '账号已变化，请重新读取创作。'; retry.hidden = false;}
  }
}
async function refresh() {
  const seq = ++generation, selected = tab;
  owner.abort(); owner = new AbortController();
  const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(12_000)]);
  clear(); status.textContent = '正在读取创作…'; list.setAttribute('aria-busy', 'true');
  try {
    const session = await request('/auth/session', signal);
    if (seq !== generation) return;
    if (!session.signedIn || typeof session.displaySession !== 'string' || !session.displaySession) {
      status.textContent = ''; login.hidden = false; account.textContent = '登录'; enableAccount('/login?returnTo=%2Fcreators'); return;
    }
    void readAccount(session, signal, seq);
    const page = await request(selected === 'published' ? '/api/v2/me/publications' : '/api/v2/me/drafts', signal, session.displaySession);
    if (seq !== generation) return;
    if (!Array.isArray(page.items)) throw new Error('invalid_page');
    const rows = page.items.map(item => card(item, selected));
    list.replaceChildren(...rows);
    status.textContent = rows.length ? '' : selected === 'published' ? '还没有发布配方。可以先在 App 中创建并预览。' : '暂时没有创作中的配方。';
  } catch (error) {
    if (seq !== generation) return;
    ++generation; owner.abort(); clear(); list.setAttribute('aria-busy','false');
    if (error.status === 401) {status.textContent = '登录已过期，请重新登录。'; login.hidden = false; account.textContent = '登录'; enableAccount('/login?returnTo=%2Fcreators');}
    else {status.textContent = error.status === 409 || error.message === 'session_changed' ? '账号已变化，请重新读取创作。' : '暂时无法读取创作，请重试。'; retry.hidden = false;}
  } finally {if (seq === generation) list.setAttribute('aria-busy', 'false');}
}
function choose(next) {
  tab = next;
  for (const button of tabs) {const active = button.dataset.tab === tab; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;}
  list.setAttribute('aria-labelledby', 'creators-' + tab);
  void refresh();
}
for (const button of tabs) {
  button.addEventListener('click', () => choose(button.dataset.tab));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs.find(item => item !== button);
    next.focus(); choose(next.dataset.tab);
  });
}
retry.addEventListener('click', () => {void refresh();});
window.addEventListener('focus', () => {void refresh();});
window.addEventListener('pageshow', event => {if (event.persisted) void refresh();});
if (events) {events.onmessage = () => {void refresh();}; events.postMessage('check');}
void refresh();
