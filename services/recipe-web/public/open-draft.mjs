const fragmentPattern = /^#([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})\?revision=([1-9][0-9]{0,15})$/;

export function draftAppUrl(fragment, channel) {
  if (channel !== 'preview' && channel !== 'stable') return undefined;
  const match = typeof fragment === 'string' && fragmentPattern.exec(fragment);
  if (!match || match[0] !== fragment || !Number.isSafeInteger(Number(match[2]))) return undefined;
  const scheme = channel === 'preview' ? 'vonvon-preview' : 'vonvon';
  return scheme + '://recipes/drafts/' + match[1].toLowerCase() + '?revision=' + match[2];
}

if (typeof document !== 'undefined') {
  const button = document.getElementById('open-app');
  const status = document.getElementById('status');
  function update() {
    const link = location.search ? undefined : draftAppUrl(location.hash, document.documentElement.dataset.desktopChannel);
    button.removeAttribute('href');
    button.hidden = true;
    if (link) {
      button.href = link;
      button.hidden = false;
      button.textContent = document.documentElement.dataset.desktopChannel === 'preview' ? '打开 Vonvon Bot 预览版' : '打开 Vonvon Bot';
      status.textContent = '请点击按钮打开 App，查看完整配方。';
    } else {
      status.textContent = '配方链接不完整或已损坏。请回到飞书重新打开预览，或在 App 的「我的配方」查找作品。';
    }
  }
  update();
  window.addEventListener('hashchange', update);
  window.addEventListener('popstate', update);
}
