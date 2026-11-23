export function recipeCreationUrl(channel) {
  if (channel === 'preview') return 'vonvon-preview://recipes/create';
  if (channel === 'stable') return 'vonvon://recipes/create';
  return undefined;
}

if (typeof document !== 'undefined') {
  let dialog;
  document.addEventListener('click', event => {
    const action = event.target instanceof Element && event.target.closest('a[data-create-recipe]');
    if (!action) return;
    const expected = recipeCreationUrl(document.documentElement.dataset.desktopChannel);
    if (!expected || action.getAttribute('href') !== expected) {event.preventDefault(); return;}
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'creation-dialog';
      dialog.setAttribute('aria-labelledby', 'creation-title');
      const title = document.createElement('h2'); title.id = 'creation-title'; title.textContent = '在 App 中分享配方';
      const text = document.createElement('p'); text.textContent = 'App 会打开「创作配方」。选择已有 Bot 和群聊后，就可以开始整理自己的配方。';
      const preview = document.documentElement.dataset.desktopChannel === 'preview';
      const hint = document.createElement('p'); hint.className = 'fine'; hint.textContent = preview ? '当前是测试社区，需要使用本轮验收的 Vonvon Bot Preview。请先打开已安装的 Preview，再重试。' : '如果 App 没有打开，可以再试一次；尚未安装的话，请先前往官网下载。';
      const actions = document.createElement('div'); actions.className = 'actions';
      const retry = document.createElement('a'); retry.href = expected; retry.className = 'button'; retry.textContent = preview ? '重新打开 Preview' : '重新打开 App';
      const download = document.createElement('a'); download.href = 'https://vonvon.cc/get/'; download.className = 'secondary'; download.textContent = preview ? '了解正式版' : '下载 App';
      const close = document.createElement('button'); close.type = 'button'; close.className = 'secondary'; close.textContent = '关闭'; close.addEventListener('click', () => dialog.close());
      actions.append(retry, download, close); dialog.append(title, text, hint, actions); document.body.append(dialog);
    }
    if (!dialog.open) dialog.showModal();
  });
}
