const status = document.querySelector('#status'), choices = document.querySelector('#providers'), cancel = document.querySelector('#cancel');
const storageKey = 'vv-native-tab';
const names = { github: 'GitHub', google: 'Google', apple: 'Apple' };
const fragment = new URLSearchParams(location.hash.slice(1));
const ticket = fragment.get('ticket'), receipt = fragment.get('receipt');
const completing = location.pathname === '/auth/native/complete';
history.replaceState(null, '', completing ? '/auth/native/complete' : '/auth/native');
let binding, active = true, deadline = 0;

async function request(path, data) {
  const response = await fetch('/auth/native/' + path, {
    method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/json', 'X-Vonvon-Native-Tab': binding },
    ...(data !== undefined && { body: JSON.stringify(data) }),
  });
  if (!response.ok) throw new Error('login_unavailable');
  return response.json();
}

function finish(text) {
  active = false; status.textContent = text; choices.hidden = true; cancel.hidden = true;
}

async function poll() {
  if (!active) return;
  if (Date.now() >= deadline) return finish('登录已过期。请回到 App 重新登录。');
  try { render(await request('browser')); }
  catch { status.textContent = '连接中断，正在重试。你也可以回到 App 取消登录。'; }
  if (active) setTimeout(poll, 1000);
}

function render(view) {
  if (!active) return;
  deadline = view.expiresAt;
  if (['ready', 'acknowledged'].includes(view.status)) return finish('授权已完成。请回到 App 查看登录结果。');
  if (view.status === 'cancelled') return finish('登录已取消。你可以关闭这个页面。');
  if (view.status === 'expired') return finish('登录已过期。请回到 App 重新登录。');
  if (view.status === 'failed') return finish('登录未完成。请回到 App 重新登录。');
  cancel.hidden = false;
  if (view.status === 'authorized' && view.authorizeUrl) {
    active = false; status.textContent = '正在前往授权页面…'; location.replace(view.authorizeUrl); return;
  }
  if (view.status === 'selected') { choices.hidden = true; status.textContent = '正在连接 App，请稍候…'; return; }
  if (view.status === 'choosing' && choices.childElementCount === 0) {
    status.textContent = '选择登录方式，授权后回到 App。'; choices.hidden = false;
    for (const provider of view.providers) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary'; button.textContent = '使用 ' + names[provider] + ' 登录';
      button.addEventListener('click', async () => {
        for (const item of choices.children) item.disabled = true;
        try { render(await request('select', { provider })); }
        catch { finish('未能选择登录方式。请回到 App 重新登录。'); }
      });
      choices.append(button);
    }
  }
}

cancel.addEventListener('click', async () => {
  cancel.disabled = true;
  try { render(await request('cancel', {})); }
  catch { finish('未能确认取消。请回到 App 取消登录。'); }
});

try {
  if (ticket && !completing) {
    binding = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    sessionStorage.setItem(storageKey, binding);
    render(await request('launch', { ticket, binding }));
  } else {
    binding = sessionStorage.getItem(storageKey);
    if (!binding) throw new Error('missing_tab');
    if (completing) {
      if (!receipt) throw new Error('missing_receipt');
      render(await request('complete', { receipt }));
    } else render(await request('browser'));
  }
  if (active) setTimeout(poll, 1000);
} catch { finish('此登录链接已失效，或不属于当前页面。请回到 App 重新登录。'); }
