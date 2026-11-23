const host = document.getElementById('site-account');
// App-rendered pages own their existing account control.
if (host && !document.getElementById('account')) {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const dataset = document.documentElement.dataset;
  const siteUrl = (name, fallback) => {
    const raw = dataset[name];
    if (!raw || raw.startsWith('__')) return new URL(fallback, location.origin);
    const url = new URL(raw, location.origin);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('invalid_site_url');
    return url;
  };
  const node = (tag, text, className) => {
    const value = document.createElement(tag); if (text !== undefined) value.textContent = text;
    if (className) value.className = className; return value;
  };
  const link = (text, href) => {const value = node('a',text); value.href = href; return value;};
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vv-recipe-auth') : null;
  let generation = 0, owner = new AbortController();
  host.setAttribute('aria-live','polite');
  function clear() {host.replaceChildren();}
  function retry(text) {
    clear(); const message = node('span',text,'site-account-status'), button = node('button','重新读取','text-button');
    message.setAttribute('role','status'); button.type = 'button'; button.addEventListener('click',()=>{void refresh();}); host.append(message,button);
  }
  async function request(path, signal, displaySession) {
    const response = await fetch(path,{credentials:'same-origin',cache:'no-store',signal,
      ...(displaySession && {headers:{'X-Vonvon-Session':displaySession}})});
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data?.error?.code || 'unavailable'),{status:response.status});
    return data;
  }
  function profile(value) {
    if (!value || !uuid.test(value.authorId || '') || typeof value.displayName !== 'string' || !value.displayName.trim() ||
        !value.displayName.isWellFormed() || [...value.displayName].length > 60 || /[\x00-\x1f\x7f-\x9f]/.test(value.displayName) ||
        value.avatarDataUrl !== undefined && (typeof value.avatarDataUrl !== 'string' || value.avatarDataUrl.length > 174787 ||
          !/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.avatarDataUrl))) throw Error('invalid_profile');
    return value;
  }
  async function refresh() {
    const seq = ++generation; owner.abort(); owner = new AbortController();
    const signal = AbortSignal.any([owner.signal,AbortSignal.timeout(12_000)]);
    clear(); host.setAttribute('aria-busy','true');
    try {
      const accountUrl = siteUrl('accountUrl','/account'), libraryUrl = siteUrl('libraryUrl','/library');
      const session = await request('/auth/session',signal);
      if (seq !== generation) return;
      if (!session.signedIn) {host.append(link('登录','/login?' + new URLSearchParams({returnTo: location.pathname.startsWith('/auth/') ? '/library' : location.pathname + location.search}))); return;}
      if (typeof session.displaySession !== 'string' || !session.displaySession) throw Error('invalid_session');
      const current = profile(await request('/api/v2/me/account-profile',signal,session.displaySession));
      if (seq !== generation) return;
      accountUrl.hash = 'account=' + current.authorId.toLowerCase();
      const menu = node('details',undefined,'account-menu'), summary = node('summary');
      summary.setAttribute('aria-label','网站账号菜单');
      const avatar = node('span',undefined,'account-menu-avatar'), name = node('span',current.displayName,'account-menu-name');
      if (current.avatarDataUrl) {const image = node('img'); image.src = current.avatarDataUrl; image.alt = ''; avatar.append(image);}
      else avatar.textContent = [...current.displayName].slice(0,2).join('');
      summary.append(avatar,name);
      const entries = node('nav'); entries.setAttribute('aria-label','网站账号选项');
      const logout = node('button','退出网站账号','text-button'); logout.type = 'button';
      logout.addEventListener('click',async()=>{
        if (seq !== generation || !menu.isConnected || logout.disabled) return;
        logout.disabled = true;
        try {
          const logoutSignal = AbortSignal.any([owner.signal,AbortSignal.timeout(12_000)]);
          const response = await fetch('/auth/logout',{method:'POST',credentials:'same-origin',cache:'no-store',signal:logoutSignal,
            headers:{'X-Vonvon-Session':session.displaySession}});
          if (seq !== generation) return;
          if (!response.ok) {
            if ([401,409].includes(response.status)) {void refresh(); return;}
            throw Error('logout_failed');
          }
          channel?.postMessage('check'); void refresh();
        } catch {if (seq === generation) retry('退出未完成，请重新读取网站账号。');}
      });
      entries.append(link('我的配方',libraryUrl.href),link('账号设置',accountUrl.href),logout);
      menu.append(summary,entries); host.append(menu);
    } catch (error) {
      if (seq !== generation) return;
      clear();
      if (error.status === 401) host.append(link('登录','/login?' + new URLSearchParams({returnTo: location.pathname.startsWith('/auth/') ? '/library' : location.pathname + location.search})));
      else retry(error.status === 409 || error.message === 'session_changed' ? '网站账号已变化。' : '网站账号暂时无法读取。');
    } finally {if (seq === generation) host.setAttribute('aria-busy','false');}
  }
  window.addEventListener('focus',()=>{void refresh();});
  window.addEventListener('pageshow',event=>{if(event.persisted)void refresh();});
  if (channel) {channel.onmessage=()=>{void refresh();};channel.postMessage('check');}
  void refresh();
}
