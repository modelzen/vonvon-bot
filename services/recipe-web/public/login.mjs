if (document.documentElement.dataset.loginMode !== 'app') {
const $ = id => document.getElementById(id);
const providers = $('login-providers'), current = $('login-current'), actions = $('login-session-actions');
const status = $('login-status'), retry = $('login-retry'), firstUse = $('login-first-use'), switchHint = $('login-switch-hint');
const configuredOrigin = document.documentElement.dataset.authOrigin;
const authOrigin = configuredOrigin && !configuredOrigin.startsWith('__') ? configuredOrigin : '';
const siteDestination = path => path === '/account' ? path : authOrigin + path;
const credentials = authOrigin ? 'include' : 'same-origin';
const providerNames = {github:'GitHub', google:'Google'};
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const detail = new RegExp('^/recipes/' + uuid + '/versions/' + uuid + '$', 'i');
function destination(encoded = document.documentElement.dataset.loginReturnTo) {
  try {
    const value = decodeURIComponent(encoded || '%2F');
    if (!value.startsWith('/') || value.startsWith('//') || /[\\#\x00-\x1f\x7f-\x9f]/.test(value)) return '/';
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || value.split('?')[0] !== url.pathname) return '/';
    const params = url.searchParams;
    for (const [key, item] of params) if (params.getAll(key).length !== 1 || /[\\\x00-\x1f\x7f-\x9f]/.test(item)) return '/';
    if (/^\/release-code\/confirm\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname)) return value === url.pathname ? url.pathname : '/';
    if (url.pathname === '/') {
      if ([...params.keys()].some(key => key !== 'q') || [...(params.get('q') || '')].length > 120) return '/';
    } else if (url.pathname === '/library') {
      if ([...params.keys()].some(key => key !== 'state') || params.has('state') && !['all','acquired','drafts','published'].includes(params.get('state'))) return '/';
    } else if (detail.test(url.pathname)) {
      if ([...params.keys()].some(key => !['from','author'].includes(key))) return '/';
      const from = params.get('from'), author = params.get('author');
      if (from !== null && !['library','library-all','published','author','creator'].includes(from)) return '/';
      if (from === 'author' ? !new RegExp('^' + uuid + '$', 'i').test(author || '') : author !== null) return '/';
    } else if ((!['/library','/publications','/studio','/account','/creators','/create'].includes(url.pathname) && !new RegExp('^/authors/' + uuid + '$','i').test(url.pathname)) || params.size) return '/';
    return url.pathname + (params.size ? '?' + params.toString() : '');
  } catch {return '/';}
}
const returnTo = destination(), storageKey = 'vv-recipe-login-continuation';
if (authOrigin && window.location.hash) {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const nonce = fragment.size === 1 ? fragment.get('acquire') : '';
  const continuationNonce = detail.test(returnTo.split('?')[0]) && /^[a-f0-9]{64}$/.test(nonce || '') ? nonce : undefined;
  window.history.replaceState({...window.history.state, continuationNonce}, '', window.location.pathname + window.location.search);
}
function continuation() {
  if (authOrigin) {
    const nonce = window.history.state?.continuationNonce;
    if (detail.test(returnTo.split('?')[0]) && /^[a-f0-9]{64}$/.test(nonce || '')) return {nonce};
    return;
  }
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    const path = new URL(returnTo, location.origin).pathname;
    if (detail.test(path) && value?.path === path && /^[a-f0-9]{64}$/.test(value.nonce || '')) return value;
  } catch {}
}
const from = document.documentElement.dataset.loginBackTo;
const originPath = from && !from.startsWith('__') ? destination(from) : returnTo;
$('login-continue').href = siteDestination(returnTo);
const loginError = document.documentElement.dataset.loginError;
$('login-error').hidden = !['true','failed','cancelled'].includes(loginError);
$('login-error').textContent = loginError === 'cancelled' ? '你已取消登录，可以重新选择登录方式。' : '这次登录没有完成，请重新选择登录方式。';
let generation = 0, owner = new AbortController(), enabled = [], shownAccount;
const events = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vv-recipe-auth') : null;
function clear() {
  shownAccount = undefined;
  current.hidden = true; actions.hidden = true; providers.hidden = true; providers.replaceChildren();
  $('login-name').textContent = ''; $('login-initials').textContent = ''; $('login-avatar').removeAttribute('src'); $('login-avatar').hidden = true;
  firstUse.hidden = true; switchHint.hidden = true; retry.hidden = true;
}
async function request(path, signal, displaySession) {
  const response = await fetch(authOrigin + path, {credentials,cache:'no-store',signal,...(displaySession && {headers:{'X-Vonvon-Session':displaySession}})});
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data?.error?.code || 'unavailable'), {status:response.status});
  return data;
}
function showProviders(switching = false) {
  providers.replaceChildren();
  const pending = continuation();
  for (const provider of Object.keys(providerNames)) {
    const button = document.createElement('button');
    button.dataset.brand = providerNames[provider];
    if (!enabled.includes(provider)) {
      button.type = 'button'; button.disabled = true; button.setAttribute('aria-disabled','true');
      button.textContent = '使用 ' + providerNames[provider] + ' 登录 · 暂不可用';
      const row = document.createElement('div'); row.className = 'auth-provider-unavailable'; row.append(button); providers.append(row);
      continue;
    }
    const form = document.createElement('form'); form.method = 'post'; form.action = authOrigin + '/auth/start';
    const fields = {provider,returnTo,...(from && !from.startsWith('__') && originPath !== returnTo && {backTo:originPath}),...(pending && {continuation:'acquire',continuationNonce:pending.nonce})};
    for (const [name,value] of Object.entries(fields)) {const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);}
    button.type = 'submit'; button.textContent = '使用 ' + providerNames[provider] + ' 登录';
    form.append(button); providers.append(form);
  }
  providers.hidden = false; firstUse.hidden = enabled.length === 0; switchHint.hidden = !switching;
  status.textContent = enabled.length ? '' : '登录暂时不可用，请稍后重试。';
}
async function refresh() {
  const seq = ++generation; owner.abort(); owner = new AbortController();
  const signal = AbortSignal.any([owner.signal,AbortSignal.timeout(12_000)]);
  clear(); enabled = []; showProviders(); status.textContent = '正在准备登录…';
  try {
    const session = await request('/auth/session', signal);
    if (seq !== generation) return;
    enabled = [...new Set((Array.isArray(session.providers) ? session.providers : []).filter(name => Object.hasOwn(providerNames,name)))];
    if (!session.signedIn || typeof session.displaySession !== 'string' || !session.displaySession) {showProviders(); return;}
    const profile = await request('/api/v2/me/account-profile', signal, session.displaySession);
    if (seq !== generation) return;
    if (typeof profile?.displayName !== 'string' || !profile.displayName || !new RegExp('^' + uuid + '$','i').test(profile.authorId || '')) throw new Error('invalid_profile');
    $('login-name').textContent = profile.displayName;
    $('login-initials').textContent = [...profile.displayName].slice(0,2).join('');
    if (typeof profile.avatarDataUrl === 'string' && profile.avatarDataUrl.length <= 174787 && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(profile.avatarDataUrl)) {
      $('login-avatar').src = profile.avatarDataUrl; $('login-avatar').hidden = false; $('login-initials').textContent = '';
    }
    showProviders();
    shownAccount = {displaySession:session.displaySession,authorId:profile.authorId.toLowerCase(),generation:seq};
    current.hidden = false; actions.hidden = false; status.textContent = '';
  } catch (error) {
    if (seq !== generation) return;
    clear();
    if (error.status === 401) {showProviders(); status.textContent = '登录已过期，请重新登录。';}
    else {enabled = []; showProviders(); status.textContent = error.status === 409 || error.message === 'session_changed' ? '网页账号已变化，请重新读取。' : '暂时无法读取登录状态，请重试。'; retry.hidden = false;}
  }
}
$('login-continue').addEventListener('click', async event => {
  event.preventDefault();
  const shown = shownAccount;
  if (!shown || shown.generation !== generation) return;
  try {
    const signal = AbortSignal.any([owner.signal,AbortSignal.timeout(12_000)]);
    const profile = await request('/api/v2/me/account-profile', signal, shown.displaySession);
    if (shownAccount !== shown || generation !== shown.generation) return;
    if (typeof profile.authorId !== 'string' || profile.authorId.toLowerCase() !== shown.authorId) {void refresh(); return;}
    location.assign(siteDestination(returnTo));
  } catch {if (shownAccount === shown) void refresh();}
});
$('login-switch').addEventListener('click', () => {actions.hidden = true; showProviders(true);});
retry.addEventListener('click', () => {void refresh();});
window.addEventListener('focus', () => {void refresh();});
window.addEventListener('pageshow', event => {if (event.persisted) void refresh();});
if (events) events.onmessage = () => {void refresh();};
void refresh();

}
