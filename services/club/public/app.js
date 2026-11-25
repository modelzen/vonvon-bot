(() => {
  const state = { sort: 'hot', q: '' };
  let pendingDocRefresh = null;

  const toolbarEl = document.getElementById('toolbar');
  const gridEl = document.getElementById('card-grid');
  const emptyEl = document.getElementById('empty-state');
  const emptyTitleEl = document.getElementById('empty-title');
  const emptyDescEl = document.getElementById('empty-desc');
  const searchInput = document.getElementById('search-input');
  const createModal = document.getElementById('create-modal');
  const toastEl = document.getElementById('toast');

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

  function createMiniDocElement(item) {
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
    return mini;
  }

  function renderCard(item, index = 0) {
    const card = document.createElement('article');
    card.className = 'card';

    // Native anchor wraps the whole card so middle-click, Cmd/Ctrl+click and URL hover preview work seamlessly.
    const link = document.createElement('a');
    link.className = 'card-link';
    if (isSafeHttps(item.docUrl)) {
      link.href = item.docUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    link.setAttribute('aria-label', `${item.name} — 打开宣传文档`);

    // Upper preview: real cover image if present, otherwise Plan A miniature Feishu document sheet.
    const preview = document.createElement('div');
    const hasCover = Boolean(item.coverUrl && /^\/covers\/[a-f0-9]+\.(?:png|jpg|webp)$/.test(item.coverUrl));
    preview.className = hasCover ? 'card-preview has-cover' : 'card-preview';

    if (hasCover) {
      const img = document.createElement('img');
      img.className = 'card-cover-img';
      img.src = item.coverUrl;
      img.alt = item.name;
      img.loading = index < 8 ? 'eager' : 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        preview.className = 'card-preview';
        img.replaceWith(createMiniDocElement(item));
      }, { once: true });
      preview.appendChild(img);
    } else {
      preview.appendChild(createMiniDocElement(item));
    }

    const sourceBadge = document.createElement('span');
    sourceBadge.className = 'source-badge';
    sourceBadge.textContent = isFeishuHost(item.docUrl) ? '飞书云文档 ↗' : '宣传页 ↗';
    preview.appendChild(sourceBadge);

    // Lower Feishu-style footer
    const titleRow = document.createElement('div');
    titleRow.className = 'card-title-row';
    titleRow.appendChild(createDocSvgIcon());

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = item.name;
    title.title = item.name;
    titleRow.appendChild(title);

    const body = document.createElement('div');
    body.className = 'card-body';

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

    const installCount = Number.isFinite(Number(item.installCount)) ? Number(item.installCount) : 0;
    const installs = document.createElement('span');
    installs.className = 'install-count';
    installs.textContent = `${installCount} 安装`;
    installs.title = `已有 ${installCount} 个唯一用户安装`;
    metrics.appendChild(installs);

    if (typeof item.docLikeCount === 'number' && item.docLikeCount > 0) {
      const docLikes = document.createElement('span');
      docLikes.className = 'doc-like-pill';
      docLikes.textContent = `👍 ${item.docLikeCount}`;
      docLikes.title = `飞书宣传文档获赞 ${item.docLikeCount}（点击打开文档可点赞）`;
      metrics.appendChild(docLikes);
    }

    if (isFeishuHost(item.docUrl)) {
      link.addEventListener('click', () => {
        pendingDocRefresh = {
          id: item.id,
          authorPublicKey: item.authorPublicKey,
          clickedAt: Date.now(),
          metricsEl: metrics,
          item,
        };
      });
    }

    metaRow.append(authorInfo, metrics);
    body.append(metaRow);
    link.append(preview, titleRow, body);
    card.append(link);
    return card;
  }

  async function loadList() {
    const params = new URLSearchParams({ sort: state.sort });
    if (state.q) params.set('q', state.q);
    try {
      const res = await fetch(`/api/list?${params}`);
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
        items.forEach((item, idx) => gridEl.appendChild(renderCard(item, idx)));
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

  const modeTabs = document.querySelectorAll('.modal-mode-tab');
  const feishuPanel = document.getElementById('mode-panel-feishu');
  const agentPanel = document.getElementById('mode-panel-agent');
  for (const tab of modeTabs) {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode || 'feishu';
      for (const other of modeTabs) {
        const active = other === tab;
        other.classList.toggle('active', active);
        other.setAttribute('aria-selected', String(active));
      }
      feishuPanel.classList.toggle('hidden', mode !== 'feishu');
      agentPanel.classList.toggle('hidden', mode !== 'agent');
    });
  }

  for (const btn of document.querySelectorAll('.copy-prompt-btn')) {
    btn.addEventListener('click', () => {
      const targetEl = document.getElementById(btn.dataset.copyTarget || '');
      if (!targetEl) return;
      const promptText = targetEl.textContent.trim();
      copyText(promptText, btn.dataset.toast || '已复制');
      btn.textContent = '已复制 ✓';
      setTimeout(() => { btn.textContent = '一键复制'; }, 1800);
    });
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !pendingDocRefresh) return;
    const pending = pendingDocRefresh;
    const elapsed = Date.now() - pending.clickedAt;
    if (elapsed < 2000) return;
    pendingDocRefresh = null;
    if (elapsed > 30 * 60 * 1000) return;
    try {
      const res = await fetch('/api/refresh-doc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: pending.id, authorPublicKey: pending.authorPublicKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) return;
      if (typeof data.docLikeCount === 'number') {
        pending.item.docLikeCount = data.docLikeCount;
        let pill = pending.metricsEl.querySelector('.doc-like-pill');
        if (data.docLikeCount > 0) {
          if (!pill) {
            pill = document.createElement('span');
            pill.className = 'doc-like-pill';
            pending.metricsEl.appendChild(pill);
          }
          pill.textContent = `👍 ${data.docLikeCount}`;
          pill.title = `飞书宣传文档获赞 ${data.docLikeCount}（点击打开文档可点赞）`;
        } else if (pill) {
          pill.remove();
        }
      }
    } catch {
      // Best-effort silent refresh
    }
  });

  loadList();
})();
