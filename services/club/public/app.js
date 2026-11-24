(() => {
  const VOTER_STORAGE_KEY = 'vonvon_club_voter_id';
  const state = { sort: 'hot', q: '' };

  const toolbarEl = document.getElementById('toolbar');
  const gridEl = document.getElementById('card-grid');
  const emptyEl = document.getElementById('empty-state');
  const emptyTitleEl = document.getElementById('empty-title');
  const emptyDescEl = document.getElementById('empty-desc');
  const searchInput = document.getElementById('search-input');
  const createModal = document.getElementById('create-modal');
  const toastEl = document.getElementById('toast');

  function getVoterId() {
    try {
      let id = localStorage.getItem(VOTER_STORAGE_KEY);
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        localStorage.setItem(VOTER_STORAGE_KEY, id);
      }
      return id;
    } catch {
      return '';
    }
  }

  let toastTimer = null;
  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2400);
  }

  async function copyText(text, successMsg) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMsg);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      showToast(successMsg);
    }
  }

  function isSafeHttps(url) {
    return typeof url === 'string' && /^https:\/\//i.test(url);
  }

  function isFeishuHost(url) {
    try {
      const host = new URL(url).hostname;
      return /(?:^|\.)(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/i.test(host);
    } catch {
      return false;
    }
  }

  function createDocSvgIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'doc-icon');
    svg.setAttribute('aria-hidden', 'true');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '3');
    rect.setAttribute('y', '2');
    rect.setAttribute('width', '18');
    rect.setAttribute('height', '20');
    rect.setAttribute('rx', '4');
    rect.setAttribute('fill', '#2b6ddb');
    svg.appendChild(rect);
    for (const [y, w] of [[8, 10], [12, 10], [16, 6]]) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      line.setAttribute('x', '7');
      line.setAttribute('y', String(y));
      line.setAttribute('width', String(w));
      line.setAttribute('height', '1.8');
      line.setAttribute('rx', '0.9');
      line.setAttribute('fill', '#ffffff');
      svg.appendChild(line);
    }
    return svg;
  }

  function renderCard(item) {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', `${item.name} — 打开宣传文档`);

    const openDoc = () => {
      if (isSafeHttps(item.docUrl)) window.open(item.docUrl, '_blank', 'noopener,noreferrer');
    };
    card.addEventListener('click', openDoc);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDoc();
      }
    });

    // Upper preview: real cover image if present, otherwise Plan A miniature Feishu document sheet.
    const preview = document.createElement('div');
    preview.className = item.coverUrl ? 'card-preview has-cover' : 'card-preview';

    if (item.coverUrl && /^\/covers\/[a-f0-9]+\.(?:png|jpg|webp)$/.test(item.coverUrl)) {
      const img = document.createElement('img');
      img.className = 'card-cover-img';
      img.src = item.coverUrl;
      img.alt = item.name;
      img.loading = 'lazy';
      preview.appendChild(img);
    } else {
      const mini = document.createElement('div');
      mini.className = 'mini-doc';
      const accent = document.createElement('div');
      accent.className = 'mini-doc-accent';
      const miniTitle = document.createElement('div');
      miniTitle.className = 'mini-doc-title';
      miniTitle.textContent = item.name;
      const miniSummary = document.createElement('div');
      miniSummary.className = 'mini-doc-summary';
      miniSummary.textContent = item.summary;
      mini.append(accent, miniTitle, miniSummary);

      if (Array.isArray(item.skillNames) && item.skillNames.length > 0) {
        const skillsRow = document.createElement('div');
        skillsRow.className = 'mini-doc-skills';
        for (const s of item.skillNames.slice(0, 2)) {
          const pill = document.createElement('span');
          pill.className = 'mini-skill-pill';
          pill.textContent = s;
          skillsRow.appendChild(pill);
        }
        if (item.skillNames.length > 2) {
          const more = document.createElement('span');
          more.className = 'mini-skill-pill mini-skill-more';
          more.textContent = `+${item.skillNames.length - 2}`;
          skillsRow.appendChild(more);
        }
        mini.appendChild(skillsRow);
      }
      preview.appendChild(mini);
    }

    const sourceBadge = document.createElement('span');
    sourceBadge.className = 'source-badge';
    sourceBadge.textContent = isFeishuHost(item.docUrl) ? '飞书云文档 ↗' : '宣传页 ↗';
    preview.appendChild(sourceBadge);

    // Lower Feishu-style footer
    const body = document.createElement('div');
    body.className = 'card-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'card-title-row';
    titleRow.appendChild(createDocSvgIcon());

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = item.name;
    title.title = item.name;
    titleRow.appendChild(title);

    if (item.installHint) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'copy-hint-btn';
      copyBtn.textContent = '复制安装';
      copyBtn.title = '复制一句话发给你的飞书 Bot 私聊安装';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyText(item.installHint, '已复制安装话术，去飞书私聊发给你的 Bot 吧');
      });
      titleRow.appendChild(copyBtn);
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'card-meta-row';

    const authorInfo = document.createElement('div');
    authorInfo.className = 'author-info';
    const authorName = document.createElement('span');
    authorName.className = 'author-name';
    authorName.textContent = item.author?.name || '匿名创作者';
    if (item.author?.contact) authorName.title = `${authorName.textContent} · ${item.author.contact}`;
    authorInfo.appendChild(authorName);

    const metrics = document.createElement('div');
    metrics.className = 'meta-metrics';

    if (item.installCount > 0) {
      const installs = document.createElement('span');
      installs.className = 'install-count';
      installs.textContent = `${item.installCount} 安装`;
      metrics.appendChild(installs);
    }

    const likeBtn = document.createElement('button');
    likeBtn.type = 'button';
    likeBtn.className = item.liked ? 'like-btn liked' : 'like-btn';
    likeBtn.setAttribute('aria-pressed', String(Boolean(item.liked)));
    const likeIcon = document.createElement('span');
    likeIcon.textContent = '👍';
    const likeNum = document.createElement('span');
    likeNum.textContent = item.likeCount > 0 ? String(item.likeCount) : '赞';
    likeBtn.append(likeIcon, likeNum);

    likeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      likeBtn.disabled = true;
      try {
        const res = await fetch('/api/like', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-club-voter': getVoterId() },
          body: JSON.stringify({ id: item.id, authorPublicKey: item.authorPublicKey }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          item.liked = data.liked;
          item.likeCount = data.likeCount;
          likeBtn.className = data.liked ? 'like-btn liked' : 'like-btn';
          likeBtn.setAttribute('aria-pressed', String(Boolean(data.liked)));
          likeNum.textContent = data.likeCount > 0 ? String(data.likeCount) : '赞';
        } else {
          showToast(data.error || '点赞失败，请稍后重试');
        }
      } catch {
        showToast('网络开小差了，请稍后重试');
      } finally {
        likeBtn.disabled = false;
      }
    });

    metrics.appendChild(likeBtn);
    metaRow.append(authorInfo, metrics);
    body.append(titleRow, metaRow);
    card.append(preview, body);
    return card;
  }

  async function loadList() {
    const params = new URLSearchParams({ sort: state.sort });
    if (state.q) params.set('q', state.q);
    try {
      const res = await fetch(`/api/list?${params}`, {
        headers: { 'x-club-voter': getVoterId() },
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '加载失败');

      const totalTemplates = data.stats?.totalTemplates ?? 0;
      toolbarEl.classList.toggle('hidden', totalTemplates < 6 && !state.q);

      gridEl.replaceChildren();
      const items = data.items ?? [];
      if (!items.length) {
        emptyEl.classList.remove('hidden');
        if (state.q) {
          emptyTitleEl.textContent = '没有找到匹配的配方';
          emptyDescEl.textContent = '试试换个关键词，或者自己做一个分享给大家。';
        } else {
          emptyTitleEl.textContent = '还没有公开配方';
          emptyDescEl.textContent = '成为第一位创作者：把你的好玩法整理成配方和公开飞书文档，分享给更多飞书玩家。';
        }
      } else {
        emptyEl.classList.add('hidden');
        for (const item of items) gridEl.appendChild(renderCard(item));
      }
    } catch {
      showToast('列表加载失败，请刷新重试');
    }
  }

  // Event bindings
  for (const tab of document.querySelectorAll('.sort-tab')) {
    tab.addEventListener('click', () => {
      state.sort = tab.dataset.sort || 'hot';
      for (const other of document.querySelectorAll('.sort-tab')) {
        const active = other === tab;
        other.classList.toggle('active', active);
        other.setAttribute('aria-selected', String(active));
      }
      loadList();
    });
  }

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = searchInput.value.trim();
      loadList();
    }, 180);
  });

  function openModal() {
    createModal.classList.remove('hidden');
  }
  function closeModal() {
    createModal.classList.add('hidden');
  }
  document.getElementById('open-create-btn').addEventListener('click', openModal);
  document.getElementById('empty-create-btn').addEventListener('click', openModal);
  document.getElementById('close-modal-btn').addEventListener('click', closeModal);
  createModal.addEventListener('click', (e) => { if (e.target === createModal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  const copyPromptBtn = document.getElementById('copy-prompt-btn');
  copyPromptBtn.addEventListener('click', () => {
    const promptText = document.getElementById('create-prompt-text').textContent.trim();
    copyText(promptText, '已复制，打开飞书发给你的 Vonvon Bot 私聊即可开始');
    copyPromptBtn.textContent = '已复制 ✓';
    setTimeout(() => { copyPromptBtn.textContent = '一键复制'; }, 1800);
  });

  loadList();
})();
