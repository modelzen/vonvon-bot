import {recipeCreationUrl,recipeDraftsUrl,recipeHandoffUrl} from './app-links.mjs';
export {recipeCreationUrl};

if (typeof document !== 'undefined') {
  let dialog;
  document.addEventListener('click', event => {
    const action = event.target instanceof Element && event.target.closest('a[data-create-recipe],a[data-app-drafts],a[data-handoff-recipe]');
    if (!action) return;
    const kinds = ['data-create-recipe','data-app-drafts','data-handoff-recipe'].filter(name => action.hasAttribute(name));
    const channel = document.documentElement.dataset.desktopChannel;
    const kind = kinds[0];
    const expected = kind === 'data-create-recipe' ? recipeCreationUrl(channel) : kind === 'data-app-drafts' ? recipeDraftsUrl(channel) : recipeHandoffUrl(channel,action.dataset.recipeId,action.dataset.versionId);
    if (kinds.length !== 1 || !expected || action.getAttribute('href') !== expected) {event.preventDefault(); return;}
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'creation-dialog';
      dialog.setAttribute('aria-labelledby','app-link-title'); document.body.append(dialog);
    }
    const title = document.createElement('h2'); title.id = 'app-link-title';
    const text = document.createElement('p');
    if (kind === 'data-create-recipe') {
      title.textContent = '在 App 中准备发布';
      text.textContent = 'App 会打开「创作配方」。选择 Bot，在私聊里提供链接、文档或教程，也可以选取已有群配置。草稿保存在本地，确认发布后才上传。你可以免费分享，也可以自行售卖分享码。';
    } else if (kind === 'data-app-drafts') {
      title.textContent = '在 App 中继续创作';
      text.textContent = 'App 会打开本地「创作中」。尚未发布的内容保存在本地，确认发布后才同步到社区。';
    } else {
      title.textContent = '在 App 中使用这个版本';
      text.textContent = 'App 会打开这份配方的指定版本。请在 App 中选择 Bot 并确认后续操作；打开链接不会自动获取、发送或安装配方。';
    }
    const preview = channel === 'preview';
    const hint = document.createElement('p'); hint.className = 'fine';
    hint.textContent = preview ? '当前是测试社区，需要使用本轮验收的 Vonvon Bot Preview。如果 App 没有打开，请先打开 Preview，再重试。' : '如果 App 没有打开，可以再试一次；尚未安装的话，请先前往官网下载。';
    const actions = document.createElement('div'); actions.className = 'actions';
    const retry = document.createElement('a'); retry.href = expected; retry.className = 'button'; retry.textContent = preview ? '重新打开 Preview' : '重新打开 App';
    const download = document.createElement('a'); download.href = 'https://vonvon.cc/get/'; download.className = 'secondary'; download.textContent = preview ? '了解正式版' : '下载 App';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'secondary'; close.textContent = '关闭'; close.addEventListener('click',()=>dialog.close());
    actions.append(retry,download,close); dialog.replaceChildren(title,text,hint,actions);
    if (!dialog.open) dialog.showModal();
  });
}

if (typeof document !== 'undefined' && document.documentElement.dataset.createReady === 'true' && !history.state?.openedCreate) {
  const open = document.querySelector('.studio-create [data-create-recipe]');
  if (open) {
    history.replaceState({...history.state, openedCreate: true}, '', location.href);
    open.click();
  }
}
