const $ = id => document.getElementById(id);
const status = $('account-status'), loginPanel = $('account-login'), mismatch = $('account-mismatch');
const form = $('account-profile'), name = $('account-name'), avatar = $('account-avatar');
const image = $('avatar-image'), initials = $('avatar-initials'), remove = $('avatar-remove');
const save = $('account-save'), feedback = $('account-feedback'), recover = $('account-recover');
const sessionActions = $('account-session-actions'), logout = $('account-logout'), retry = $('account-retry');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const expectedStorage = 'vv-account-login-expected';
const providerNames = {github: 'GitHub', google: 'Google', apple: 'Apple'};
let expectedAccount, invalidExpected = false;
function readExpectedAccount() {
  expectedAccount = undefined; invalidExpected = false;
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (location.hash) {
      const value = fragment.get('account');
      if (fragment.size !== 1 || !uuid.test(value || '')) invalidExpected = true;
      else expectedAccount = value.toLowerCase();
      history.replaceState({...history.state, accountExpected: expectedAccount, invalidAccountExpected: invalidExpected}, '', location.pathname);
      try {sessionStorage.removeItem(expectedStorage);} catch {}
    } else {
      expectedAccount = history.state?.accountExpected;
      invalidExpected = history.state?.invalidAccountExpected === true;
      const pending = JSON.parse(sessionStorage.getItem(expectedStorage) || 'null');
      sessionStorage.removeItem(expectedStorage);
      if (!expectedAccount && pending?.expiresAt > Date.now() && uuid.test(pending.accountId || '')) {
        expectedAccount = pending.accountId.toLowerCase();
        history.replaceState({...history.state, accountExpected: expectedAccount}, '', location.pathname);
      }
    }
  } catch { if (location.hash) invalidExpected = true; }
}
readExpectedAccount();
let session, profile, generation = 0, owner = new AbortController(), busy = false;
let avatarChange = {kind: 'keep'}, avatarPreview;
const events = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vv-recipe-auth') : null;

class AccountError extends Error {
  constructor(code, status) {super(code); this.code = code; this.status = status;}
}
async function request(path, options = {}) {
  const response = await fetch(path, {credentials: 'same-origin', cache: 'no-store', ...options,
    signal: AbortSignal.any([owner.signal, AbortSignal.timeout(12_000)])});
  const data = await response.json();
  if (!response.ok) throw new AccountError(data?.error?.code || 'unavailable', response.status);
  return data;
}
function profileHeaders() {return {'X-Vonvon-Session': session.displaySession};}
function parseProfile(value) {
  if (!value || !uuid.test(value.authorId || '') || typeof value.displayName !== 'string' ||
      !Number.isInteger(value.revision) || value.revision < 0 || value.revision > 2147483647 ||
      (value.avatarDataUrl !== undefined && (typeof value.avatarDataUrl !== 'string' || value.avatarDataUrl.length > 174787 ||
        !/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.avatarDataUrl)))) throw new AccountError('invalid_profile');
  if (expectedAccount && value.authorId.toLowerCase() !== expectedAccount) throw new AccountError('account_mismatch');
  return value;
}
function normalizedName() {return name.value.normalize('NFKC').replace(/\s+/gu, ' ').trim();}
function validName() {
  const raw = name.value, value = normalizedName(), length = Array.from(value).length;
  const identityText = text => text.replace(/[\u200d\ufe00-\ufe0f\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu, '');
  const invisible = /\p{Default_Ignorable_Code_Point}/u;
  const malformed = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  return length > 0 && length <= 60 && !/[@\u0000-\u001f\u007f-\u009f]/.test(raw) && !invisible.test(identityText(raw)) &&
    !malformed.test(raw) && !value.includes('@') && !invisible.test(identityText(value)) && identityText(value).trim().length > 0;
}
function update() {
  const valid = validName();
  name.setAttribute('aria-invalid', String(!valid));
  $('name-error').textContent = valid ? '' : '请输入 1–60 个字，不含 @ 或控制字符。';
  const unchanged = profile && normalizedName() === profile.displayName && avatarChange.kind === 'keep';
  save.disabled = busy || !profile || !valid || unchanged && recover.hidden;
  for (const control of [name, avatar, remove, recover]) control.disabled = busy;
  initials.textContent = Array.from(name.value.trim()).slice(0, 2).join('').toLocaleUpperCase();
}
function preview(value) {
  if (value) {image.src = value; image.hidden = false;}
  else {image.removeAttribute('src'); image.hidden = true;}
  remove.hidden = !profile?.avatarDataUrl && avatarChange.kind !== 'replace';
}
function applyProfile(value) {
  profile = value; name.value = value.displayName; $('account-id').value = value.authorId;
  avatarChange = {kind: 'keep'}; avatarPreview = value.avatarDataUrl; preview(avatarPreview);
  recover.hidden = true; update();
}
function clearProfile() {
  profile = undefined; form.hidden = true; name.value = ''; $('account-id').value = '';
  avatar.value = ''; avatarChange = {kind: 'keep'}; avatarPreview = undefined; preview();
  feedback.textContent = ''; $('name-error').textContent = ''; recover.hidden = true;
}
function showLogin() {
  loginPanel.hidden = false;
  const providers = $('account-providers'); providers.replaceChildren();
  for (const provider of session?.providers || []) {
    if (!Object.hasOwn(providerNames, provider)) continue;
    const entry = document.createElement('form'); entry.method = 'post'; entry.action = '/auth/start';
    for (const [key, value] of Object.entries({provider, returnTo: '/account'})) {
      const field = document.createElement('input'); field.type = 'hidden'; field.name = key; field.value = value; entry.append(field);
    }
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = '使用 ' + providerNames[provider] + ' 继续'; entry.append(button);
    entry.addEventListener('submit', event => {
      if (!expectedAccount) return;
      try {sessionStorage.setItem(expectedStorage, JSON.stringify({accountId: expectedAccount, expiresAt: Date.now() + 15 * 60_000}));}
      catch {event.preventDefault(); status.textContent = '当前浏览器无法保留 App 账号核对信息。请允许此网站使用会话存储后重试。';}
    });
    providers.append(entry);
  }
  if (!providers.childElementCount) providers.textContent = '暂时没有可用的登录方式，请稍后再试。';
}
function showMismatch() {
  clearProfile(); mismatch.hidden = false; status.textContent = '网站与 App 当前使用了不同账号。';
}
async function load() {
  const current = ++generation;
  owner.abort(); owner = new AbortController(); busy = false;
  clearProfile(); loginPanel.hidden = mismatch.hidden = sessionActions.hidden = retry.hidden = true;
  status.textContent = '正在读取账号信息…';
  if (invalidExpected) {status.textContent = 'App 账号链接不完整。请回到 App 重新打开账号设置。'; return;}
  try {
    const next = await request('/auth/session');
    if (current !== generation) return;
    session = next;
    if (!session.signedIn) {showLogin(); status.textContent = '登录后管理你的 Vonvon 账号。'; return;}
    sessionActions.hidden = false;
    let value = parseProfile(await request('/api/v2/me/account-profile', {headers: profileHeaders()}));
    if (current !== generation) return;
    if (value.revision === 0) {
      const accountId = value.authorId;
      value = parseProfile(await request('/api/v2/me/account-profile/initialize', {method: 'POST', headers: {...profileHeaders(), 'Content-Type': 'application/json'}, body: JSON.stringify({displayName: 'Vonvon 用户'})}));
      if (current !== generation) return;
      if (value.authorId !== accountId || value.revision === 0) throw new AccountError('invalid_profile');
    }
    applyProfile(value); form.hidden = false; status.textContent = '';
  } catch (error) {
    if (current !== generation) return;
    if (error.code === 'account_mismatch') return showMismatch();
    if (['login_required', 'auth_required'].includes(error.code)) {session = undefined; status.textContent = '网站登录已失效，请重新登录。'; retry.hidden = false; return;}
    status.textContent = '暂时无法读取账号，请稍后重试。'; retry.hidden = false;
  }
}
async function reconcile(current) {
  const value = parseProfile(await request('/api/v2/me/account-profile', {headers: profileHeaders()}));
  if (current !== generation) return;
  if (value.authorId !== profile.authorId) throw new AccountError('session_changed');
  profile = value;
  feedback.textContent = `当前云端昵称为「${value.displayName}」。请核对后再次保存希望使用的资料。`;
  recover.hidden = false;
}
name.addEventListener('input', () => {feedback.textContent = ''; update();});
image.addEventListener('error', () => {image.hidden = true;});
avatar.addEventListener('change', async () => {
  const file = avatar.files?.[0]; avatar.value = '';
  if (!file || busy || !profile) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 2 * 1024 * 1024) {
    feedback.textContent = '请选择不超过 2 MiB 的 PNG、JPEG 或 WebP 静态图片。'; return;
  }
  const current = generation; busy = true; feedback.textContent = ''; update();
  try {
    const bitmap = await createImageBitmap(file);
    try {if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 2048 || bitmap.height > 2048) throw new AccountError('invalid_logo');}
    finally {bitmap.close();}
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
    });
    if (current !== generation) return;
    avatarChange = {kind: 'replace', base64: data.slice(data.indexOf(',') + 1)};
    avatarPreview = data; preview(avatarPreview); feedback.textContent = '头像将在保存时居中裁成方形。';
  } catch {if (current === generation) feedback.textContent = '图片无法使用。请选择最大 2048 × 2048 像素、不超过 2 MiB 的 PNG、JPEG 或 WebP 静态图片。';}
  finally {if (current === generation) {busy = false; update();}}
});
remove.addEventListener('click', () => {if (busy) return; avatarChange = {kind: 'remove'}; avatarPreview = undefined; preview(); feedback.textContent = '保存后恢复默认头像。'; update();});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !profile || !validName() || save.disabled) return;
  const current = generation, accountId = profile.authorId;
  busy = true; feedback.textContent = ''; update();
  try {
    const value = parseProfile(await request('/api/v2/me/account-profile', {method: 'POST', headers: {...profileHeaders(), 'Content-Type': 'application/json'},
      body: JSON.stringify({displayName: normalizedName(), revision: profile.revision, avatar: avatarChange})}));
    if (current !== generation) return;
    if (value.authorId !== accountId) throw new AccountError('session_changed');
    applyProfile(value); feedback.textContent = '个人资料已保存。';
  } catch (error) {
    if (current !== generation) return;
    if (['session_changed', 'login_required', 'auth_required', 'account_mismatch'].includes(error.code)) {await load(); return;}
    if (error.code === 'nickname_taken') {feedback.textContent = '这个昵称已被使用，请换一个。'; return;}
    if (error.code === 'invalid_logo') {feedback.textContent = '头像未通过校验。请选择最大 2048 × 2048 像素、不超过 2 MiB 的 PNG、JPEG 或 WebP 静态图片。'; return;}
    if (error.code === 'invalid_input') {feedback.textContent = '请检查昵称和头像格式后再保存。'; return;}
    recover.hidden = false;
    feedback.textContent = error.code === 'conflict' ? '资料已在其他页面更新。请重新读取后再确认保存。' : '保存结果暂未确认，请重新读取云端资料后再确认。';
    try {await reconcile(current);} catch (next) {if (current === generation && ['account_mismatch', 'session_changed'].includes(next.code)) await load();}
  } finally {if (current === generation) {busy = false; update();}}
});
recover.addEventListener('click', async () => {
  if (busy || !profile) return;
  const current = generation; busy = true; update();
  try {await reconcile(current);}
  catch (error) {if (current === generation) {if (['account_mismatch', 'session_changed'].includes(error.code)) await load(); else feedback.textContent = '暂时无法读取云端资料，请稍后重试。';}}
  finally {if (current === generation) {busy = false; update();}}
});
$('account-copy').addEventListener('click', async () => {
  const current = generation;
  try {await navigator.clipboard.writeText(profile.authorId); if (current === generation) feedback.textContent = '用户 ID 已复制。';}
  catch {if (current === generation) {feedback.textContent = '请选中用户 ID 手动复制。'; $('account-id').select();}}
});
logout.addEventListener('click', async () => {
  if (logout.disabled || !session?.signedIn) return;
  const displaySession = session.displaySession;
  ++generation; owner.abort(); owner = new AbortController(); clearProfile(); logout.disabled = true;
  try {
    const response = await fetch('/auth/logout', {method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: {'X-Vonvon-Session': displaySession}, signal: AbortSignal.timeout(12_000)});
    void response.body?.cancel().catch(() => {});
    if (!response.ok) throw new AccountError('logout_failed');
    events?.postMessage('check'); await load();
  } catch {status.textContent = '退出结果未确认，请重新读取账号状态。'; retry.hidden = false;}
  finally {logout.disabled = false;}
});
retry.addEventListener('click', load);
let checking = false;
async function checkSession() {
  if (document.visibilityState !== 'visible' || checking || !session) return;
  const current = generation; checking = true;
  try {
    const next = await request('/auth/session');
    if (current !== generation) return;
    if (next.signedIn !== session.signedIn || next.displaySession !== session.displaySession) await load();
  } catch { /* Retain the edit during a temporary connection failure. */ }
  finally {checking = false;}
}
window.addEventListener('hashchange', () => {
  if (!location.hash) return;
  ++generation; owner.abort(); clearProfile();
  readExpectedAccount();
  void load();
});
window.addEventListener('focus', checkSession);
document.addEventListener('visibilitychange', checkSession);
window.addEventListener('pageshow', event => {if (event.persisted) void load();});
if (events) {events.onmessage = checkSession; events.postMessage('check');}
await load();
