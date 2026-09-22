/**
 * 随问 AskAlong · Content Script
 * 职责:
 *  1. 正文提取器:平台适配器优先,Readability 简化算法兜底,输出 Markdown;
 *  2. 划词工具条:选中文字后浮出「解释 / 翻译 / 问AI」;
 *  3. 行内快答卡:解释/翻译直接在页面内流式作答;
 *  4. 响应侧边栏的 GET_ARTICLE / GET_SELECTION 消息。
 * 所有 UI 挂在 Shadow DOM 里,样式与页面完全隔离。
 */
(function () {
  'use strict';

  if (window.__askalongInjected) return;
  window.__askalongInjected = true;

  const HOST_ID = 'askalong-host';

  /* ============================== 平台适配器 ============================== */
  /* content 数组按顺序取第一个非空者;multiple: true 时收集全部(如多回答页) */

  const SITE_ADAPTERS = [
    { host: /mp\.weixin\.qq\.com$/i, title: '#activity-name,.rich_media_title', content: ['#js_content', '.rich_media_content'] },
    { host: /csdn\.net$/i, title: 'h1.title-article,#articleContentId', content: ['#content_views', 'article'] },
    { host: /zhihu\.com$/i, title: 'h1.Post-Title,.QuestionHeader-title', content: ['.Post-RichTextContainer', '.RichContent-inner'], multiple: true },
    { host: /juejin\.cn$/i, title: 'h1.article-title', content: ['article.article-content', '.markdown-body', 'article'] },
    { host: /jianshu\.com$/i, title: 'h1._1RuRku', content: ['article'] },
    { host: /cnblogs\.com$/i, title: '#post_title,.postTitle a', content: ['#cnblogs_post_body'] },
    { host: /segmentfault\.com$/i, title: 'h1.h3,.article-header', content: ['.article', 'article'] },
    { host: /github\.com$/i, title: 'strong[itemprop="name"] a,h1', content: ['article.markdown-body', '#readme .markdown-body', 'article'] },
    { host: /stackoverflow\.com$/i, title: '#question-header a,h1', content: ['.js-post-body'], multiple: true },
    { host: /xiaohongshu\.com$/i, title: '#detail-title,.title', content: ['#detail-desc', '.note-text', '.desc'] },
    { host: /bilibili\.com$/i, title: '.title-container,h1', content: ['#article-content', '.opus-modules'] },
    { host: /runoob\.com$/i, title: 'h1', content: ['#content', '.article-body'] },
    { host: /sspai\.com$/i, title: 'h1.title', content: ['article.article', '.content.wangEditor-txt'] },
    { host: /oschina\.net$/i, title: 'h1', content: ['article.detail', '.article-detail'] },
    { host: /51cto\.com$/i, title: 'h1', content: ['.article-content', 'article'] },
    { host: /infoq\.cn$/i, title: 'h1', content: ['.article-content', 'article'] },
    { host: /cloud\.tencent\.com$/i, title: 'h1.j-title', content: ['.J-articleContent', 'article'] },
    { host: /developer\.aliyun\.com$/i, title: 'h1', content: ['.markdown-body', 'article'] }
  ];

  function firstMatch(selList) {
    for (const sel of selList) {
      for (const el of document.querySelectorAll(sel)) {
        if (el && el.textContent.trim().length > 50 && !insideOwnUI(el)) return el;
      }
    }
    return null;
  }

  function insideOwnUI(el) {
    let n = el;
    while (n) {
      if (n.id === HOST_ID) return true;
      n = n.parentElement;
    }
    return false;
  }

  /* ============================ Readability 兜底 ============================ */

  function genericExtractRoot() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(
      'script,style,noscript,iframe,svg,nav,header,footer,aside,form,button,select,textarea,link,template,canvas,video,audio'
    ).forEach((n) => n.remove());
    clone.querySelectorAll('[hidden],[aria-hidden="true"]').forEach((n) => n.remove());

    const noise = /(comment|sidebar|side-bar|related|recommend|advert|ads?[-_]|banner|breadcrumb|copyright|pagination|login|modal|popup|tooltip|subscribe|newsletter|donate|reward|social|share|footer|header|navbar|menu|catalog|operator|toolbar|drawer)/i;
    const total = clone.textContent.length;
    clone.querySelectorAll('div,section,ul,ol').forEach((n) => {
      const sig = (typeof n.className === 'string' ? n.className : '') + ' ' + (n.id || '');
      if (noise.test(sig) && n.textContent.length < total * 0.6) n.remove();
    });

    // 按文本密度给容器打分,p/pre 权重最高
    const scores = new Map();
    for (const el of clone.querySelectorAll('p,pre,li,blockquote,h1,h2,h3,h4,h5,h6,td')) {
      const len = el.textContent.trim().length;
      if (len < 30) continue;
      const w = el.tagName === 'P' ? 1.2 : el.tagName === 'PRE' ? 2 : 0.7;
      let p = el.parentElement;
      let depth = 0;
      while (p && depth < 4) {
        scores.set(p, (scores.get(p) || 0) + (len * w) / (depth === 0 ? 1 : depth * 2));
        p = p.parentElement;
        depth++;
      }
    }
    let best = null, bestScore = 0;
    for (const [el, sc] of scores) {
      if (sc > bestScore) { bestScore = sc; best = el; }
    }
    if (!best || bestScore < 300) return clone;
    return best;
  }

  /* ============================ DOM → Markdown ============================ */

  function mdFrom(root) {
    const out = [];
    walk(root);
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const t = child.textContent.replace(/\s+/g, ' ').trim();
          if (t) out.push(t);
          continue;
        }
        if (child.nodeType !== 1 || child.id === HOST_ID) continue;
        if (isHidden(child)) continue;

        switch (child.tagName.toLowerCase()) {
          case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
            const n = +child.tagName[1];
            const t = inlineText(child);
            if (t) out.push('\n' + '#'.repeat(n) + ' ' + t);
            break;
          }
          case 'pre':
            out.push('\n' + fence(child));
            break;
          case 'ul': case 'ol':
            out.push('\n' + listMd(child, child.tagName === 'OL'));
            break;
          case 'blockquote':
            out.push('\n' + quoteMd(child));
            break;
          case 'table':
            out.push('\n' + tableMd(child));
            break;
          case 'hr':
            out.push('\n---');
            break;
          case 'br':
            out.push('\n');
            break;
          case 'img': {
            const alt = child.getAttribute('alt');
            if (alt) out.push(`[图:${alt}]`);
            break;
          }
          case 'script': case 'style': case 'noscript': case 'iframe':
          case 'svg': case 'button': case 'select': case 'input': case 'form':
            break;
          default: {
            if (hasBlockChildren(child)) walk(child);
            else {
              const t = inlineText(child);
              if (t) out.push('\n' + t);
            }
          }
        }
      }
    }
  }

  function hasBlockChildren(el) {
    for (const c of el.children) {
      const t = c.tagName.toLowerCase();
      if (['p', 'div', 'section', 'article', 'pre', 'ul', 'ol', 'table', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'figure'].includes(t)) {
        return true;
      }
    }
    return false;
  }

  function inlineText(el) {
    let s = '';
    (function w(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.textContent;
        else if (c.nodeType === 1) {
          const t = c.tagName.toLowerCase();
          if (t === 'br') { s += '\n'; continue; }
          if (['script', 'style', 'button', 'select', 'input'].includes(t)) continue;
          if (['code', 'kbd', 'samp'].includes(t)) { s += '`' + c.textContent + '`'; continue; }
          w(c);
        }
      }
    })(el);
    return s.replace(/[ \t]+/g, ' ').trim();
  }

  function fence(pre) {
    const code = pre.querySelector('code') || pre;
    const cls = (code.className || '') + ' ' + (pre.className || '');
    const m = cls.match(/(?:language|lang)-([\w+#.-]+)/);
    const lang = m ? m[1] : '';
    const text = code.textContent.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');
    if (!text) return '';
    return '```' + lang + '\n' + text + '\n```';
  }

  function listMd(el, ordered) {
    const lines = [];
    let i = 0;
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      i++;
      const clone = li.cloneNode(true);
      clone.querySelectorAll('ul,ol').forEach((n) => n.remove());
      const marker = ordered ? i + '. ' : '- ';
      let line = marker + (inlineText(clone) || li.textContent.trim());
      const subs = [];
      li.querySelectorAll(':scope > ul, :scope > ol').forEach((sub) => {
        subs.push(listMd(sub, sub.tagName === 'OL'));
      });
      if (subs.length) {
        line += '\n' + subs.join('\n').split('\n').map((l) => '  ' + l).join('\n');
      }
      if (line.trim() !== marker.trim()) lines.push(line);
    }
    return lines.join('\n');
  }

  function quoteMd(el) {
    const parts = [];
    for (const c of el.children) {
      const t = c.tagName.toLowerCase();
      if (t === 'pre') parts.push(fence(c));
      else if (t === 'ul' || t === 'ol') parts.push(listMd(c, t === 'ol'));
      else {
        const x = inlineText(c);
        if (x) parts.push(x);
      }
    }
    const text = parts.join('\n') || el.textContent.trim();
    return text.split('\n').map((l) => '> ' + l).join('\n');
  }

  function tableMd(table) {
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      const cells = [...tr.querySelectorAll('th,td')].map((c) => inlineText(c).replace(/\|/g, '\\|'));
      if (cells.length) rows.push('| ' + cells.join(' | ') + ' |');
    }
    if (!rows.length) return '';
    const colCount = rows[0].split('|').length - 2;
    rows.splice(1, 0, '|' + ' --- |'.repeat(Math.max(colCount, 1)));
    return rows.join('\n');
  }

  function isHidden(el) {
    try {
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
      if (el.style && /display:\s*none|visibility:\s*hidden/i.test(el.style.cssText)) return true;
      if (el.isConnected) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      }
    } catch (e) { /* noop */ }
    return false;
  }

  /* ============================== 提取入口 ============================== */

  function extractArticle() {
    let title = (document.querySelector('meta[property="og:title"]') || {}).content || document.title || '';
    title = String(title).trim();
    let rootEl = null;
    let joined = null;

    const adapter = SITE_ADAPTERS.find((a) => a.host.test(location.hostname));
    if (adapter) {
      const t = firstMatch([adapter.title]);
      if (t) title = t.textContent.trim();
      const els = adapter.multiple
        ? [...document.querySelectorAll(adapter.content.join(','))].filter((el) => el.textContent.trim().length > 30 && !insideOwnUI(el))
        : [];
      if (els.length > 1) {
        joined = els.map((el) => mdFrom(el)).filter(Boolean).join('\n\n---\n\n');
      } else {
        rootEl = firstMatch(adapter.content);
      }
    }

    let text = joined || (rootEl ? mdFrom(rootEl) : '');
    if (!text || text.length < 80) {
      rootEl = genericExtractRoot();
      const fallback = mdFrom(rootEl);
      if (fallback.length > text.length) text = fallback;
    }

    return {
      ok: text.length > 40,
      title,
      url: location.href,
      site: location.hostname,
      text,
      charCount: text.length
    };
  }

  /* ============================== Shadow DOM UI ============================== */

  const CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }

    .aa-toolbar {
      position: fixed; z-index: 2147483646; display: none; align-items: center;
      background: #1e1e2e; border-radius: 8px; padding: 4px; gap: 2px;
      box-shadow: 0 4px 20px rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12);
    }
    .aa-toolbar button {
      all: unset; cursor: pointer; color: #e5e7eb; font-size: 12.5px; line-height: 1;
      padding: 7px 11px; border-radius: 6px; white-space: nowrap;
    }
    .aa-toolbar button:hover { background: rgba(255,255,255,.14); color: #fff; }
    .aa-toolbar button.primary { color: #a5b4fc; font-weight: 600; }
    .aa-toolbar .aa-logo { color: #8b8fa3; font-size: 11px; padding: 0 4px 0 8px; user-select: none; }

    .aa-card {
      position: fixed; z-index: 2147483647; display: none; flex-direction: column;
      width: 430px; max-height: 440px; background: #fff; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.06);
      overflow: hidden;
    }
    .aa-card-head {
      display: flex; align-items: center; gap: 8px; padding: 9px 12px;
      background: linear-gradient(90deg, #eef2ff, #faf5ff); border-bottom: 1px solid #eef0f4;
      cursor: default; user-select: none;
    }
    .aa-card-head .aa-dot { width: 8px; height: 8px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #a855f7); flex: none; }
    .aa-card-head .aa-ttl { font-size: 12.5px; font-weight: 700; color: #3730a3; flex: none; }
    .aa-card-head .aa-ctx {
      flex: 1; font-size: 11px; color: #8b8fa3; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    }
    .aa-card-head button {
      all: unset; cursor: pointer; color: #9ca3af; font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 4px;
    }
    .aa-card-head button:hover { color: #4b5563; background: rgba(0,0,0,.05); }
    .aa-card-body { padding: 12px 14px; overflow-y: auto; font-size: 13.5px; line-height: 1.7; color: #1f2937; overscroll-behavior: contain; }
    .aa-card-body.aa-empty::before { content: "思考中"; color: #9ca3af; }
    .aa-card-foot {
      display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-top: 1px solid #f0f1f4; background: #fafafa;
    }
    .aa-card-foot button {
      all: unset; cursor: pointer; font-size: 12px; color: #6b7280; padding: 4px 9px; border-radius: 6px;
      border: 1px solid #e5e7eb; background: #fff;
    }
    .aa-card-foot button:hover { border-color: #c7d2fe; color: #4f46e5; }
    .aa-card-foot .aa-stat { flex: 1; text-align: right; font-size: 11px; color: #b0b4c0; }
    .aa-card-foot button.aa-stop { color: #dc2626; border-color: #fecaca; }
    .aa-cursor::after { content: "▍"; color: #6366f1; animation: aa-blink 1s step-start infinite; }
    @keyframes aa-blink { 50% { opacity: 0; } }

    /* —— markdown-lite 渲染样式(快答卡内) —— */
    .aa-body h1,.aa-body h2,.aa-body h3,.aa-body h4,.aa-body h5,.aa-body h6 { margin: .8em 0 .35em; line-height: 1.4; color: #111827; }
    .aa-body h1 { font-size: 1.25em; } .aa-body h2 { font-size: 1.15em; } .aa-body h3 { font-size: 1.05em; }
    .aa-body h4,.aa-body h5,.aa-body h6 { font-size: 1em; }
    .aa-body p { margin: .45em 0; }
    .aa-body ul,.aa-body ol { margin: .45em 0; padding-left: 1.4em; }
    .aa-body li { margin: .18em 0; }
    .aa-body blockquote { margin: .5em 0; padding: .35em .8em; border-left: 3px solid #c7d2fe; background: #f8faff; border-radius: 0 6px 6px 0; color: #4b5563; }
    .aa-body code.aa-ic { background: #f1f2f6; padding: .1em .35em; border-radius: 4px; font-size: .92em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #b3459c; }
    .aa-body pre.aa-pre { position: relative; background: #0f172a; color: #e2e8f0; padding: 10px 12px; border-radius: 8px; overflow-x: auto; margin: .55em 0; }
    .aa-body pre.aa-pre code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; white-space: pre; }
    .aa-body pre.aa-pre .aa-lang { position: absolute; top: 4px; right: 8px; font-size: 10px; color: #64748b; }
    .aa-body table.aa-table { border-collapse: collapse; margin: .55em 0; font-size: 12.5px; width: 100%; }
    .aa-body .aa-table th,.aa-body .aa-table td { border: 1px solid #e5e7eb; padding: 4px 8px; text-align: left; }
    .aa-body .aa-table th { background: #f8f9fb; }
    .aa-body hr.aa-hr { border: none; border-top: 1px solid #e5e7eb; margin: .8em 0; }
    .aa-body a { color: #4f46e5; }
    .aa-body .aa-err { color: #dc2626; }

    .aa-body .aa-think {
      margin: .3em 0 .5em; font-size: 12px; color: #6b7280;
      background: #f5f6fa; border: 1px solid #eceef3; border-radius: 8px; padding: 6px 10px;
    }
    .aa-body .aa-think summary { cursor: pointer; font-weight: 600; user-select: none; }
    .aa-body .aa-think .aa-think-body {
      margin-top: 4px; line-height: 1.6; word-break: break-word;
      max-height: 150px; overflow-y: auto;
    }
  `;

  let host, root, toolbarEl, cardEl, cardBodyEl, cardCtxEl, cardStatEl, cardCopyBtn, cardFollowBtn, cardStopBtn;
  let cardStream = null;   // 当次流式控制句柄
  let cardRaw = '';        // 累积的原始回答
  let cardThink = '';      // 累积的思考过程(reasoning_content)
  let articleCache = null; // {url, article}
  let rafPending = false;

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial; position:fixed; z-index:2147483647; top:0; left:0; width:0; height:0;';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    toolbarEl = document.createElement('div');
    toolbarEl.className = 'aa-toolbar';
    toolbarEl.innerHTML =
      '<span class="aa-logo">随问</span>' +
      '<button data-act="explain">解释</button>' +
      '<button data-act="translate">翻译</button>' +
      '<button data-act="chat" class="primary">问AI ➤</button>';
    root.appendChild(toolbarEl);

    cardEl = document.createElement('div');
    cardEl.className = 'aa-card';
    cardEl.innerHTML =
      '<div class="aa-card-head"><span class="aa-dot"></span><span class="aa-ttl">随问</span>' +
      '<span class="aa-ctx"></span><button data-act="close" title="关闭">✕</button></div>' +
      '<div class="aa-card-body aa-body aa-empty"></div>' +
      '<div class="aa-card-foot">' +
      '<button data-act="copy">复制</button>' +
      '<button data-act="follow">↳ 侧栏追问</button>' +
      '<button data-act="stop" class="aa-stop" style="display:none">■ 停止</button>' +
      '<span class="aa-stat"></span></div>';
    root.appendChild(cardEl);
    cardBodyEl = cardEl.querySelector('.aa-card-body');
    cardCtxEl = cardEl.querySelector('.aa-ctx');
    cardStatEl = cardEl.querySelector('.aa-stat');
    cardCopyBtn = cardEl.querySelector('[data-act="copy"]');
    cardFollowBtn = cardEl.querySelector('[data-act="follow"]');
    cardStopBtn = cardEl.querySelector('[data-act="stop"]');

    toolbarEl.addEventListener('mousedown', (e) => e.preventDefault());
    toolbarEl.addEventListener('click', onToolbarClick);
    cardEl.addEventListener('click', onCardClick);
  }

  /* ============================== 划词工具条 ============================== */

  function currentSelectionText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    const text = String(sel);
    if (!text || text.length < 2) return '';
    if (text.length > 4000) return text.slice(0, 4000);
    return text;
  }

  function selectionInOwnUI() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    let n = sel.anchorNode;
    while (n) {
      if (n === host) return true;
      n = n.parentNode;
    }
    return false;
  }

  function maybeShowToolbar() {
    ensureHost();
    const text = currentSelectionText();
    if (!text || selectionInOwnUI()) { toolbarEl.style.display = 'none'; return; }
    chrome.storage.sync.get({ showToolbar: true }, (s) => {
      if (!s.showToolbar || !currentSelectionText()) { toolbarEl.style.display = 'none'; return; }
      const range = window.getSelection().getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { toolbarEl.style.display = 'none'; return; }
      toolbarEl.style.display = 'flex';
      const tw = toolbarEl.offsetWidth || 180;
      const th = toolbarEl.offsetHeight || 34;
      let x = rect.left + rect.width / 2 - tw / 2;
      let y = rect.top - th - 8;
      if (y < 8) y = rect.bottom + 8;
      x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
      toolbarEl.style.left = x + 'px';
      toolbarEl.style.top = y + 'px';
      toolbarEl.dataset.sel = text;
    });
  }

  function onToolbarClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const sel = toolbarEl.dataset.sel || currentSelectionText();
    toolbarEl.style.display = 'none';
    if (!sel) return;
    if (btn.dataset.act === 'chat') {
      // 划选内容随消息直接带给侧栏,避免面板打开过程中的时序问题
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', selection: sel });
    } else {
      openQuickCard(btn.dataset.act, sel);
    }
  }

  /* ============================== 行内快答卡 ============================== */

  function positionCard(anchorRect) {
    const w = Math.min(430, window.innerWidth - 24);
    cardEl.style.width = w + 'px';
    let x, y;
    if (anchorRect) {
      x = anchorRect.left + anchorRect.width / 2 - w / 2;
      y = anchorRect.bottom + 10;
      if (y + 300 > window.innerHeight) y = Math.max(10, (anchorRect.top || 100) - 320);
    } else {
      x = window.innerWidth / 2 - w / 2;
      y = window.innerHeight * 0.2;
    }
    x = Math.max(10, Math.min(x, window.innerWidth - w - 10));
    cardEl.style.left = x + 'px';
    cardEl.style.top = y + 'px';
  }

  async function openQuickCard(kind, selection) {
    ensureHost();
    const question = AskAlong.PROMPT_TEMPLATES[kind](selection);
    cardEl.dataset.question = question;
    const rect = window.getSelection().rangeCount
      ? window.getSelection().getRangeAt(0).getBoundingClientRect()
      : null;
    const anchor = rect && (rect.width || rect.height) ? rect : null;

    cardRaw = '';
    cardThink = '';
    cardBodyEl.classList.add('aa-empty');
    cardBodyEl.innerHTML = '';
    cardCtxEl.textContent = '';
    cardStatEl.textContent = '';
    cardCopyBtn.style.display = 'none';
    cardFollowBtn.style.display = 'none';
    cardStopBtn.style.display = '';
    cardEl.style.display = 'flex';
    positionCard(anchor);

    const settings = await AskAlong.getSettings();
    const article = await getArticleCached();

    if (article && article.ok) {
      cardCtxEl.textContent = '📄 ' + article.title + ' · ' + article.charCount + ' 字';
    } else {
      cardCtxEl.textContent = '⚠ 未提取到正文,仅基于划选内容回答';
    }

    const messages = AskAlong.buildMessages({
      settings,
      article: article && article.ok ? article : null,
      selection,
      history: [],
      question
    });

    if (cardStream) cardStream.stop();
    cardStream = AskAlong.streamChat(
      { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, temperature: settings.temperature, messages },
      {
        onDelta: (d) => {
          cardRaw += d;
          cardBodyEl.classList.remove('aa-empty');
          scheduleRender();
        },
        onThink: (d) => {
          cardThink += d;
          cardBodyEl.classList.remove('aa-empty');
          scheduleRender();
        },
        onDone: () => finishCard(true),
        onError: (err) => {
          cardRaw += '\n\n**⚠ 请求失败:** ' + err + '\n\n请在扩展设置页检查 API Key / 模型服务配置。';
          cardBodyEl.classList.remove('aa-empty');
          scheduleRender();
          finishCard(false);
        }
      }
    );

    function finishCard(ok) {
      cardStream = null;
      cardStopBtn.style.display = 'none';
      cardCopyBtn.style.display = '';
      cardFollowBtn.style.display = '';
      cardStatEl.textContent = ok ? '完成' : '已中断';
      scheduleRender();
    }
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      let html = AskAlongMD.thinkBlock(cardThink, !cardRaw);
      html += AskAlongMD.render(cardRaw);
      cardBodyEl.innerHTML = html;
      cardBodyEl.classList.toggle('aa-cursor', !!cardStream);
      cardBodyEl.scrollTop = cardBodyEl.scrollHeight;
    });
  }

  function onCardClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'close') {
      if (cardStream) { cardStream.stop(); cardStream = null; }
      cardEl.style.display = 'none';
    } else if (act === 'copy') {
      navigator.clipboard.writeText(cardRaw).then(() => {
        btn.textContent = '✓ 已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1200);
      });
    } else if (act === 'stop') {
      if (cardStream) { cardStream.stop(); cardStream = null; }
      cardStopBtn.style.display = 'none';
      cardCopyBtn.style.display = '';
      cardFollowBtn.style.display = '';
      cardStatEl.textContent = '已中断';
    } else if (act === 'follow') {
      // 把本轮问答交给侧边栏继续
      chrome.runtime.sendMessage({
        type: 'SAVE_HANDOFF',
        payload: { question: cardEl.dataset.question || '(划选提问)', answer: cardRaw }
      });
      cardEl.style.display = 'none';
    }
  }

  async function getArticleCached() {
    if (articleCache && articleCache.url === location.href) return articleCache.article;
    const article = extractArticle();
    articleCache = { url: location.href, article };
    return article;
  }

  /* ============================== 事件与消息 ============================== */

  let mouseupTimer = null;
  document.addEventListener('mouseup', (e) => {
    if (host && (e.composedPath().includes(host) || host.contains(e.target))) return;
    clearTimeout(mouseupTimer);
    mouseupTimer = setTimeout(maybeShowToolbar, 30);
  });
  document.addEventListener('selectionchange', () => {
    if (!window.getSelection() || window.getSelection().isCollapsed) {
      if (toolbarEl) toolbarEl.style.display = 'none';
    }
  });
  window.addEventListener('scroll', () => {
    if (toolbarEl) toolbarEl.style.display = 'none';
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (toolbarEl) toolbarEl.style.display = 'none';
      if (cardEl && cardEl.style.display !== 'none') {
        if (cardStream) { cardStream.stop(); cardStream = null; }
        cardEl.style.display = 'none';
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_ARTICLE') {
      sendResponse(extractArticle());
    } else if (msg.type === 'GET_SELECTION') {
      sendResponse({ text: currentSelectionText() });
    }
  });
})();
