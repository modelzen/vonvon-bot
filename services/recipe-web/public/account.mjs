const $ = id => document.getElementById(id);
const status = $('account-status'), loginPanel = $('account-login'), mismatch = $('account-mismatch');
const form = $('account-profile'), name = $('account-name'), avatar = $('account-avatar');
const image = $('avatar-image'), initials = $('avatar-initials'), remove = $('avatar-remove');
const save = $('account-save'), feedback = $('account-feedback'), recover = $('account-recover');
const sessionActions = $('account-session-actions'), logout = $('account-logout'), retry = $('account-retry');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const expectedStorage = 'vv-account-login-expected';
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
      if (expectedAccount !== undefined && (typeof expectedAccount !== 'string' || !uuid.test(expectedAccount))) {expectedAccount = undefined; invalidExpected = true;}
      const raw = sessionStorage.getItem(expectedStorage);
      if (!expectedAccount && raw !== null) {
        let pending;
        try {pending = JSON.parse(raw);} catch {}
        if (typeof pending?.expiresAt !== 'number' || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now() || !uuid.test(pending.accountId || '')) {
          invalidExpected = true;
          history.replaceState({...history.state, invalidAccountExpected: true}, '', location.pathname);
        } else {
          expectedAccount = pending.accountId.toLowerCase();
          history.replaceState({...history.state, accountExpected: expectedAccount}, '', location.pathname);
        }
        sessionStorage.removeItem(expectedStorage);
      }
    }
  } catch {invalidExpected = true;}
}
const accountLink = new URLSearchParams(location.hash.slice(1)).get('link');
if (accountLink) history.replaceState(null, '', location.pathname);
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
const after = document.documentElement.dataset.after;
const nextPage = after && !after.startsWith('__') ? decodeURIComponent(after) : undefined;
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
  const resume = $('account-continue');
  resume.hidden = !nextPage || !profile || busy;
  if (nextPage) resume.href = nextPage;
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
  if (cropDialog.open) cropDialog.close('cancel');
  profile = undefined; form.hidden = true; name.value = ''; $('account-id').value = '';
  avatarError(); avatar.value = ''; avatarChange = {kind: 'keep'}; avatarPreview = undefined; preview();
  feedback.textContent = ''; $('name-error').textContent = ''; recover.hidden = true;
}
function showLogin() {
  loginPanel.hidden = false;
}
$('account-login-link').addEventListener('click', event => {
  if (!expectedAccount) return;
  try {sessionStorage.setItem(expectedStorage, JSON.stringify({accountId: expectedAccount, expiresAt: Date.now() + 15 * 60_000}));}
  catch {event.preventDefault(); status.textContent = '当前浏览器无法保留 App 账号核对信息。请允许此网站使用会话存储后重试。';}
});
function showMismatch() {
  clearProfile(); mismatch.hidden = false; status.textContent = '网站与 App 当前使用了不同账号。';
}
async function load() {
  const current = ++generation;
  owner.abort(); owner = new AbortController(); busy = false;
  clearProfile(); loginPanel.hidden = mismatch.hidden = sessionActions.hidden = retry.hidden = true;
  status.textContent = '正在读取账号信息…';
  if (invalidExpected) {status.textContent = 'App 账号链接不完整或已过期。请回到 App 重新打开账号设置。'; return;}
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
const cropDialog = $('avatar-crop'), canvas = $('avatar-canvas'), zoom = $('avatar-zoom');
let crop, pointer;
function avatarError(message = '') {
  $('avatar-error').textContent = message;
  avatar.setAttribute('aria-invalid', String(Boolean(message)));
}
function paintCrop() {
  if (!crop) return;
  const side = canvas.width;
  const scale = side / Math.min(crop.bitmap.width, crop.bitmap.height) * Number(zoom.value);
  const width = crop.bitmap.width * scale, height = crop.bitmap.height * scale;
  crop.x = Math.max((side - width) / 2, Math.min((width - side) / 2, crop.x));
  crop.y = Math.max((side - height) / 2, Math.min((height - side) / 2, crop.y));
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, side, side);
  context.drawImage(crop.bitmap, (side - width) / 2 + crop.x, (side - height) / 2 + crop.y, width, height);
}
zoom.addEventListener('input', paintCrop);
canvas.addEventListener('pointerdown', event => {
  if (!crop || pointer) return;
  canvas.setPointerCapture(event.pointerId);
  pointer = {id: event.pointerId, x: event.clientX, y: event.clientY};
});
canvas.addEventListener('lostpointercapture', () => {pointer = undefined;});
canvas.addEventListener('pointermove', event => {
  if (!crop || pointer?.id !== event.pointerId) return;
  const scale = canvas.width / canvas.getBoundingClientRect().width;
  crop.x += (event.clientX - pointer.x) * scale;
  crop.y += (event.clientY - pointer.y) * scale;
  pointer.x = event.clientX; pointer.y = event.clientY; paintCrop();
});
canvas.addEventListener('keydown', event => {
  if (!crop || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  crop.x += event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : 0;
  crop.y += event.key === 'ArrowUp' ? -5 : event.key === 'ArrowDown' ? 5 : 0;
  paintCrop();
});
cropDialog.addEventListener('close', () => {
  if (!crop) return;
  try {
    if (crop.generation === generation && cropDialog.returnValue === 'confirm') {
      const data = canvas.toDataURL('image/webp', 0.9);
      avatarChange = {kind: 'replace', base64: data.slice(data.indexOf(',') + 1)};
      avatarPreview = data; preview(data); feedback.textContent = '头像已裁切，保存资料后生效。';
    }
  } finally {crop.bitmap.close(); crop = undefined; pointer = undefined; update();}
});
avatar.addEventListener('change', async () => {
  const file = avatar.files?.[0]; avatar.value = '';
  if (!file || busy || !profile) return;
  avatarError();
  feedback.textContent = '';
  if (!file.size) return avatarError('所选文件为空，请重新选择。');
  if (file.size > 2 * 1024 * 1024) return avatarError('这张图片超过 2 MiB。请压缩后重试。');
  const current = generation; busy = true; update();
  let problem = '未能读取图片，请重新选择文件。';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const {staticLogoFormat} = await import('/avatar-format.mjs');
    problem = '请选择 PNG、JPEG 或 WebP 格式的静态图片。';
    const format = staticLogoFormat(bytes);
    problem = '浏览器无法解码这张图片。请重新导出为 PNG 或 JPEG 后再试。';
    const bitmap = await createImageBitmap(new Blob([bytes], {type:'image/' + format}));
    if (current !== generation) {bitmap.close(); return;}
    crop = {bitmap, generation: current, x: 0, y: 0}; zoom.value = '1'; cropDialog.returnValue = '';
    problem = '未能打开裁切预览。请刷新页面后重新选择图片。';
    paintCrop(); cropDialog.showModal(); zoom.focus();
  } catch {
    if (crop?.generation === current && !cropDialog.open) {crop.bitmap.close(); crop = undefined;}
    if (current === generation) avatarError(problem);
  }
  finally {if (current === generation) {busy = false; update();}}
});
remove.addEventListener('click', () => {if (busy) return; avatarError(); avatarChange = {kind: 'remove'}; avatarPreview = undefined; preview(); feedback.textContent = '保存后恢复默认头像。'; update();});
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
    if (nextPage) location.replace(nextPage);
  } catch (error) {
    if (current !== generation) return;
    if (['session_changed', 'login_required', 'auth_required', 'account_mismatch'].includes(error.code)) {await load(); return;}
    if (error.code === 'nickname_taken') {feedback.textContent = '这个昵称已被使用，请换一个。'; return;}
    if (error.code === 'invalid_logo') {avatarError('裁切后的头像未通过校验。请重新选择图片并裁切后再保存。'); return;}
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
async function connectAppAccount(ticket) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new AccountError('link_expired');
  const url = '/auth/account-link/consume';
  const post = data => request(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  const offer = await post({ticket});
  status.textContent = '从 App 打开账号设置';
  const confirm = document.createElement('button');
  confirm.type = 'button'; confirm.className = 'button'; confirm.textContent = '使用「' + offer.displayName + '」继续';
  status.after(confirm);
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      const value = await post({ticket, confirm: true, displaySession: offer.displaySession});
      if (value.accountId !== offer.accountId) throw new AccountError('session_changed');
      confirm.remove();
      expectedAccount = value.accountId;
      history.replaceState({accountExpected: expectedAccount}, '', location.pathname);
      events?.postMessage('check'); await load();
    } catch {confirm.remove(); status.textContent = '这个连接已失效，请回到 App 重新打开账号设置。';}
  }, {once: true});
}
if (accountLink) {
  try {await connectAppAccount(accountLink);} catch {status.textContent = '这个连接已失效，请回到 App 重新打开账号设置。';}
} else await load();
