if (document.documentElement.dataset.loginMode === 'app' || location.pathname.startsWith('/auth/native')) {
const status = document.querySelector('#status'), choices = document.querySelector('#providers'), cancel = document.querySelector('#cancel');
const configuredOrigin = document.documentElement.dataset.authOrigin;
const authOrigin = configuredOrigin && !configuredOrigin.startsWith('__') ? configuredOrigin : '';
const storageKey = 'vv-native-tab';
const names = { github: 'GitHub', google: 'Google' };
const fragment = new URLSearchParams(location.hash.slice(1));
const ticket = fragment.get('ticket'), receipt = fragment.get('receipt');
const query = new URLSearchParams(location.search);
const completionMarker = query.getAll('complete').length === 1 && query.get('complete') === '1';
const completing = receipt !== null || completionMarker || location.pathname === '/auth/native/complete';
const completionStates = new Set(['ready','confirming','confirmed','acknowledged','switching','cancelled','expired','failed']);
history.replaceState(null, '', completing ? '/login?mode=app&complete=1' : '/login?mode=app');
const identity = document.querySelector('#native-identity'), confirm = document.querySelector('#native-confirm'), change = document.querySelector('#native-switch');
let binding, active = true, deadline = 0, deciding = false;

async function request(path, data) {
  const response = await fetch(authOrigin + '/auth/native/' + path, {
    method: data === undefined ? 'GET' : 'POST', credentials: authOrigin ? 'include' : 'same-origin', cache: 'no-store',
    signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/json', 'X-Vonvon-Native-Tab': binding },
    ...(data !== undefined && { body: JSON.stringify(data) }),
  });
  if (!response.ok) throw Object.assign(new Error('login_unavailable'), {status:response.status});
  return response.json();
}

function finish(text) {
  active = false; status.textContent = text; choices.hidden = true; cancel.hidden = true;
  clearIdentity();
  document.querySelector('#login-help').hidden = true;
}
function clearIdentity() {
  identity.hidden = true; document.querySelector('#native-name').textContent = '';
  document.querySelector('#native-account-id').textContent = ''; document.querySelector('#native-initials').textContent = '';
  document.querySelector('#native-avatar').removeAttribute('src'); document.querySelector('#native-avatar').hidden = true;
}
function showIdentity(value) {
  if (!value || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.accountId || '') || typeof value.displayName !== 'string' || !value.displayName || Array.from(value.displayName).length > 60) return false;
  document.querySelector('#native-name').textContent = value.displayName;
  document.querySelector('#native-account-id').textContent = value.accountId;
  document.querySelector('#native-initials').textContent = Array.from(value.displayName).slice(0,2).join('');
  const avatar = document.querySelector('#native-avatar');
  if (typeof value.avatarDataUrl === 'string' && value.avatarDataUrl.length <= 174787 && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.avatarDataUrl)) {avatar.src = value.avatarDataUrl; avatar.hidden = false;}
  else {avatar.removeAttribute('src'); avatar.hidden = true;}
  identity.hidden = false; return true;
}

async function poll() {
  if (!active) return;
  if (Date.now() >= deadline) return finish('登录已过期。请回到 App 重新登录。');
  try { render(await request('browser')); }
  catch (error) {
    if ([401,403,404,409,410].includes(error.status)) return finish('此登录流程已失效。请回到 App 重新登录。');
    status.textContent = '连接中断，正在重试。你也可以回到 App 取消登录。';
  }
  if (active) setTimeout(poll, 1000);
}

function render(view) {
  if (!active) return;
  deadline = view.expiresAt;
  if (completing && !completionStates.has(view.status)) {
    clearIdentity(); choices.hidden = true; cancel.hidden = false; cancel.disabled = deciding;
    document.querySelector('#login-help').hidden = true;
    status.textContent = '授权未返回有效结果。请取消本次登录，再回到 App 重试。'; return;
  }
  if (view.status === 'acknowledged') {
    finish('App 已确认登录，正在打开账号管理…');
    location.replace('/account');
    return;
  }
  if (view.status === 'switching') return finish('正在重新选择账号，请在新的登录页继续。');
  if (view.status === 'cancelled') return finish('登录已取消。你可以关闭这个页面。');
  if (view.status === 'expired') return finish('登录已过期。请回到 App 重新登录。');
  if (view.status === 'failed') return finish('登录未完成。请回到 App 重新登录。');
  cancel.hidden = false;
  cancel.disabled = deciding;
  if (['confirming','confirmed'].includes(view.status)) {
    if (!showIdentity(view.identity)) return finish('未能核对登录账号。请回到 App 重新登录。');
    choices.hidden = true; document.querySelector('#login-help').hidden = true;
    document.querySelector('#native-decisions').hidden = view.status === 'confirmed';
    confirm.disabled = change.disabled = deciding;
    cancel.hidden = view.status === 'confirmed';
    status.textContent = view.status === 'confirmed' ? '已确认连接，正在等待 App 完成登录…' : '请确认将这个账号连接到 Vonvon Bot App。';
    return;
  }
  clearIdentity();
  if (view.status === 'ready') {choices.hidden = true; status.textContent = '正在核对登录账号，请保留 App 中的登录窗口…'; return;}
  if (view.status === 'authorized' && view.authorizeUrl) {
    active = false; status.textContent = '正在前往授权页面…'; location.replace(view.authorizeUrl); return;
  }
  if (view.status === 'selected') { choices.hidden = true; status.textContent = '正在连接 App，请稍候…'; return; }
  if (view.status === 'choosing' && choices.childElementCount === 0) {
    status.textContent = ''; choices.hidden = false;
    for (const provider of Object.keys(names)) {
      const button = document.createElement('button');
      button.dataset.brand = names[provider];
      button.type = 'button'; button.className = 'secondary'; button.textContent = '使用 ' + names[provider] + ' 登录';
      if (!view.providers.includes(provider)) {button.disabled = true; const note = document.createElement('small'); note.textContent = '暂不可用'; button.append(note); choices.append(button); continue;}
      button.addEventListener('click', async () => {
        for (const item of choices.children) item.disabled = true;
        try { render(await request('select', { provider })); }
        catch { finish('未能选择登录方式。请回到 App 重新登录。'); }
      });
      choices.append(button);
    }
  }
}

async function decide(action) {
  if (deciding || !active) return;
  deciding = true; confirm.disabled = change.disabled = cancel.disabled = true;
  try {render(await request(action, {}));}
  catch {status.textContent = '操作结果尚未确认，正在重新核对。';}
  finally {deciding = false;}
}
confirm.addEventListener('click', () => {void decide('confirm');});
change.addEventListener('click', () => {void decide('switch');});
cancel.addEventListener('click', () => {void decide('cancel');});

try {
  if (ticket && !completing) {
    binding = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    sessionStorage.setItem(storageKey, binding);
    render(await request('launch', { ticket, binding }));
  } else {
    binding = sessionStorage.getItem(storageKey);
    if (!binding) throw new Error('missing_tab');
    if (completing) {
      if (receipt) render(await request('complete', { receipt }));
      else {
        render(await request('browser'));
      }
    } else render(await request('browser'));
  }
  if (active) setTimeout(poll, 1000);
} catch { finish('此登录链接已失效，或不属于当前页面。请回到 App 重新登录。'); }
}
