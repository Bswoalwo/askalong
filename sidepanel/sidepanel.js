/**
 * 随问 AskAlong · 侧边栏
 * 架构:每个标签页一个独立会话(Session),包含各自的历史、文章上下文、
 * 划选、流式状态与专属 DOM 容器。切换标签页 = 挂载/卸载对应容器,
 * 后台会话的生成不会中断 → 多标签页可并行提问,回答互不干扰、不丢失。
 * 历史存 chrome.storage.session(按 tabId 键控,关浏览器即清)。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const msgsEl = $('msgs');
  const chipsEl = $('chips');
  const inputEl = $('input');
  const sendEl = $('btn-send');
  const ctxTitleEl = $('ctx-title');
  const ctxBarEl = $('ctx-bar');
  const ctxCarryEl = $('ctx-carry');
  const selChipEl = $('sel-chip');
  const selTextEl = $('sel-text');

  /** tabId -> session */
  const sessions = new Map();
  /** 当前展示的会话 */
  let active = null;

  function sessionFor(tabId) {
    if (tabId == null) return null;
    if (!sessions.has(tabId)) {
      sessions.set(tabId, {
        tabId,
        loaded: false,        // 是否已从 storage 载入历史
        history: [],          // {role, content}
        article: null,        // 最近一次正文提取
        selection: '',        // 待随下一条消息发送的划选
        lastSentSelection: '',// 最近一次已发送的划选(防止陈旧选区反复附带)
        stream: null,
        streaming: false,
        container: null       // 该会话专属的 DOM 容器
      });
    }
    return sessions.get(tabId);
  }

  function containerOf(sess) {
    if (!sess.container) {
      sess.container = document.createElement('div');
      sess.container.className = 'session';
    }
    return sess.container;
  }

  async function loadSession(sess) {
    sess.loaded = true;
    const key = 'chat:' + sess.tabId;
    const obj = await chrome.storage.session.get(key);
    sess.history = obj[key] || [];

    // 快答卡「追问」带过来的一轮问答
    const hKey = 'handoff:' + sess.tabId;
    const h = await chrome.storage.session.get(hKey);
    if (h[hKey]) {
      sess.history.push(
        { role: 'user', content: h[hKey].question },
        { role: 'assistant', content: h[hKey].answer }
      );
      await chrome.storage.session.remove(hKey);
    }

    // 工具条「问AI」随消息带来的划选(确定性传递,优先采用)
    const pKey = 'pendSel:' + sess.tabId;
    const p = await chrome.storage.session.get(pKey);
    if (p[pKey]) {
      sess.selection = p[pKey];
      sess.lastSentSelection = p[pKey];
      await chrome.storage.session.remove(pKey);
    }
  }

  function saveHistory(sess) {
    return chrome.storage.session.set({ ['chat:' + sess.tabId]: sess.history.slice(-40) });
  }

  /* ------------------------------ 会话切换 ------------------------------ */

  let switchSeq = 0;

  async function switchToTab(tabId) {
    if (active && active.tabId === tabId) return;
    const seq = ++switchSeq;
    const sess = sessionFor(tabId);
    if (!sess) return;
    // 注意:不停止其他会话的流——后台生成继续,支持多页并行
    active = sess;
    if (!sess.loaded) await loadSession(sess);
    // 等待期间又发生了新的切换:放弃这次过期挂载,避免 DOM 与 active 错位
    if (seq !== switchSeq) return;
    mount(sess);
    renderCtxBar();
    paintChips();
    updateSendButton();
    updateSelChip();
    refreshContext(sess);
  }

  function mount(sess) {
    const c = containerOf(sess);
    if (c.parentNode !== msgsEl) {
      msgsEl.innerHTML = '';
      msgsEl.appendChild(c);
    }
    if (!c.childNodes.length) renderHistory(sess);
    scrollBottom(sess);
  }

  /* ------------------------------ 上下文 ------------------------------ */

  async function refreshContext(sess, { silent } = {}) {
    let article = null;
    try {
      article = await withTimeout(chrome.tabs.sendMessage(sess.tabId, { type: 'GET_ARTICLE' }), 8000);
    } catch (e) { /* 页面无 content script(chrome:// 等) */ }
    sess.article = article && article.ok ? article : null;
    if (active === sess) renderCtxBar();
    if (!silent) {
      const text = await fetchSelection(sess.tabId);
      if (text && text !== sess.lastSentSelection) sess.selection = text;
      if (active === sess) updateSelChip();
    }
  }

  async function fetchSelection(tabId) {
    try {
      const r = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'GET_SELECTION' }), 3000);
      return (r && r.text) || '';
    } catch (e) { return ''; }
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
    ]);
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderCtxBar() {
    const sess = active;
    if (sess && sess.article) {
      ctxBarEl.classList.remove('no-carry');
      ctxTitleEl.textContent = `📄 ${sess.article.title} · ${fmtChars(sess.article.charCount)}`;
      ctxBarEl.title = sess.article.url;
    } else {
      ctxTitleEl.textContent = '未提取到文章正文(此页面可能不支持)';
      ctxBarEl.title = '';
    }
    ctxBarEl.classList.toggle('no-carry', !ctxCarryEl.checked);
  }

  function fmtChars(n) {
    if (n == null) return '';
    return n >= 10000 ? (n / 10000).toFixed(1) + ' 万字' : n + ' 字';
  }

  function welcomeHTML() {
    return (
      '<div class="welcome"><div class="big">✦</div>' +
      '<h2>边读边问,不用复制粘贴</h2>' +
      '<p>我会自动阅读当前页面的文章全文来回答你。</p>' +
      '<p class="hint">在网页里<b>划选</b>一段文字 → 点「问AI」,或直接在下方提问。<br>快捷键 <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> 随时呼出。</p></div>'
    );
  }

  function renderHistory(sess) {
    const c = containerOf(sess);
    c.innerHTML = '';
    if (!sess.history.length) {
      c.innerHTML = welcomeHTML();
      return;
    }
    sess.history.forEach((m, i) => appendMsg(sess, m.role, m.content, { hidx: i }));
  }

  function appendMsg(sess, role, content, { error, hidx } = {}) {
    const div = document.createElement('div');
    div.className = 'msg ' + role + (error ? ' error' : '');
    if (Number.isInteger(hidx)) div.dataset.hidx = hidx;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (role === 'user') {
      bubble.textContent = content;
    } else {
      bubble.innerHTML = AskAlongMD.render(content);
    }
    div.appendChild(bubble);
    if (role === 'user') {
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = '✎ 编辑';
      btn.title = '编辑此提问并重新生成';
      btn.onclick = () => startEdit(sess, div, bubble, content);
      div.appendChild(btn);
    } else if (role === 'assistant' && !error && content) {
      div.appendChild(copyButton(content));
    }
    containerOf(sess).appendChild(div);
    return bubble;
  }

  function copyButton(text) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '复制';
    btn.onclick = () => {
      navigator.clipboard.writeText(text);
      btn.textContent = '✓ 已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    };
    return btn;
  }

  function paintChips() {
    chipsEl.innerHTML = '';
    if (!active || active.history.length) return;
    for (const q of AskAlong.QUICK_PROMPTS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = q.icon + ' ' + q.label;
      b.onclick = () => send(q.q);
      chipsEl.appendChild(b);
    }
  }

  function scrollBottom(sess) {
    if (sess && active && sess !== active) return;
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function updateSendButton() {
    const sess = active;
    if (sess && sess.streaming) {
      sendEl.textContent = '■';
      sendEl.classList.add('stop');
      sendEl.title = '停止生成';
    } else {
      sendEl.textContent = '➤';
      sendEl.classList.remove('stop');
      sendEl.title = '发送';
    }
  }

  function updateSelChip() {
    const sess = active;
    if (sess && sess.selection) {
      selChipEl.style.display = 'flex';
      selTextEl.textContent = sess.selection;
    } else {
      selChipEl.style.display = 'none';
    }
  }

  function hideSelChip() {
    selChipEl.style.display = 'none';
  }

  /* ------------------------------ 发送 ------------------------------ */

  async function send(prepared) {
    const sess = active;
    if (!sess || sess.streaming) return;
    const question = (prepared !== undefined ? prepared : inputEl.value).trim();
    if (!question) return;
    if (prepared === undefined) inputEl.value = '';
    autoGrow();

    // 发送前的兜底:页面此刻若有新划选(与上次发送的不同)则一并携带
    if (!sess.selection) {
      const text = await fetchSelection(sess.tabId);
      if (text && text !== sess.lastSentSelection) sess.selection = text;
    }
    const selection = sess.selection;
    if (selection) sess.lastSentSelection = selection;
    sess.selection = '';
    hideSelChip();

    sess.history.push({ role: 'user', content: question });
    const welcomeEl = containerOf(sess).querySelector('.welcome');
    if (welcomeEl) welcomeEl.remove();
    appendMsg(sess, 'user', question, { hidx: sess.history.length - 1 });
    if (sess === active) paintChips();
    scrollBottom(sess);
    // 立即落盘:即使立刻切走/关面板,问题也不丢
    saveHistory(sess);
    sess.streaming = true;
    if (sess === active) updateSendButton();

    let article = null;
    if (ctxCarryEl.checked) {
      if (!sess.article) await refreshContext(sess, { silent: true });
      article = sess.article;
    }
    if (sess === active) renderCtxBar();

    const settings = await AskAlong.getSettings();
    if (!settings.apiKey && !/localhost|127\.0\.0\.1/.test(settings.baseUrl)) {
      const tip = '尚未配置 API Key。请点击右上角 ⚙ 打开设置页,选择模型服务并填入 Key。';
      appendMsg(sess, 'assistant', tip, { error: true });
      scrollBottom(sess);
      sess.history.pop();
      sess.streaming = false;
      if (sess === active) updateSendButton();
      return;
    }

    const messages = AskAlong.buildMessages({
      settings, article, selection, history: sess.history.slice(0, -1), question
    });

    const bubble = appendMsg(sess, 'assistant', '');
    scrollBottom(sess);

    let raw = '';
    let think = '';
    let done = false;
    let raf = false;
    const paint = () => {
      if (raf) return;
      raf = true;
      requestAnimationFrame(() => {
        raf = false;
        if (done) return;
        let html = AskAlongMD.thinkBlock(think, !raw);
        if (raw) html += AskAlongMD.render(raw);
        if (!think && !raw) html = '<span style="color:var(--text-3)">思考中…</span>';
        bubble.innerHTML = html;
        scrollBottom(sess);
      });
    };

    const stream = AskAlong.streamChat(
      { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, temperature: settings.temperature, messages },
      {
        onDelta: (d) => { raw += d; paint(); },
        onThink: (d) => { think += d; paint(); },
        onDone: () => finish(true),
        onError: (err) => {
          raw += (raw ? '\n\n' : '') + '**⚠ 请求失败:** ' + err;
          finish(false);
        }
      }
    );
    sess.stream = stream;

    function finish(ok) {
      if (done) return;
      done = true;
      const wrap = bubble.parentElement;
      wrap.classList.remove('streaming');
      let html = AskAlongMD.thinkBlock(think, false);
      if (raw) html += AskAlongMD.render(raw);
      else html += '<span style="color:var(--text-3)">已停止</span>';
      bubble.innerHTML = html;

      if (raw && !raw.startsWith('**⚠')) {
        sess.history.push({ role: 'assistant', content: raw });
        saveHistory(sess);
        wrap.appendChild(copyButton(raw));
      }

      sess.streaming = false;
      sess.stream = null;
      if (sess === active) updateSendButton();
      scrollBottom(sess);
    }
    bubble.parentElement.classList.add('streaming');
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  /* ------------------------------ 编辑重发 ------------------------------ */

  function startEdit(sess, msgDiv, bubble, original) {
    if (sess.streaming || sess !== active) return;
    const hidx = parseInt(msgDiv.dataset.hidx, 10);
    if (!Number.isInteger(hidx)) return;

    bubble.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'edit-area';
    ta.value = original;
    const row = document.createElement('div');
    row.className = 'edit-row';
    const cancel = document.createElement('button');
    cancel.className = 'btn-cancel';
    cancel.textContent = '取消';
    const resend = document.createElement('button');
    resend.className = 'btn-resend';
    resend.textContent = '↻ 重新生成';
    row.append(cancel, resend);
    bubble.append(ta, row);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    cancel.onclick = () => { bubble.textContent = original; };
    resend.onclick = () => {
      const newText = ta.value.trim();
      if (!newText) return;
      regenerateFrom(sess, hidx, newText);
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancel.click();
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        resend.click();
      }
    });
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    });
  }

  async function regenerateFrom(sess, hidx, newText) {
    if (sess.streaming || sess !== active) return;
    sess.history = sess.history.slice(0, hidx);
    await saveHistory(sess);
    renderHistory(sess);
    paintChips();
    send(newText);
  }

  /* ------------------------------ 事件 ------------------------------ */

  sendEl.addEventListener('click', () => {
    if (active && active.streaming) { if (active.stream) active.stream.stop(); return; }
    send();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener('input', autoGrow);

  $('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btn-clear').addEventListener('click', async () => {
    const sess = active;
    if (!sess) return;
    if (sess.streaming && sess.stream) sess.stream.stop();
    sess.history = [];
    await saveHistory(sess);
    renderHistory(sess);
    paintChips();
  });
  $('ctx-refresh').addEventListener('click', () => { if (active) refreshContext(active); });
  ctxCarryEl.addEventListener('change', renderCtxBar);
  $('sel-close').addEventListener('click', () => {
    if (!active) return;
    active.selection = '';
    hideSelChip();
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    switchToTab(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, info) => {
    const sess = sessions.get(tabId);
    if (sess && info.url) {
      sess.article = null;
      if (active === sess) refreshContext(sess, { silent: true });
    }
  });

  // 标签页关闭:清理会话与存储
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    sessions.delete(tabId);
    const keys = ['chat:' + tabId, 'handoff:' + tabId, 'pendSel:' + tabId];
    try { await chrome.storage.session.remove(keys); } catch (e) { /* noop */ }
  });

  // 面板已打开时收到快答卡的「追问」交接
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      // 工具条「问AI」的新划选:面板已开也要实时显示(不再经过首次加载路径)
      if (key.startsWith('pendSel:') && newValue) {
        const sess = sessionFor(Number(key.split(':')[1]));
        sess.selection = newValue;
        sess.lastSentSelection = newValue;
        chrome.storage.session.remove(key);
        if (sess === active) {
          updateSelChip();
          inputEl.focus();
        }
        continue;
      }
      if (!key.startsWith('handoff:') || !newValue) continue;
      const tabId = Number(key.split(':')[1]);
      const sess = sessionFor(tabId);
      const { question, answer } = newValue;
      chrome.storage.session.remove(key);
      sess.loaded = true;
      const welcomeEl = containerOf(sess).querySelector('.welcome');
      if (welcomeEl) welcomeEl.remove();
      sess.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      const base = sess.history.length - 2;
      appendMsg(sess, 'user', question, { hidx: base });
      appendMsg(sess, 'assistant', answer, { hidx: base + 1 });
      saveHistory(sess);
      if (active === sess) { paintChips(); scrollBottom(sess); }
    }
  });

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await switchToTab(tab ? tab.id : null);
  }

  init();
})();
