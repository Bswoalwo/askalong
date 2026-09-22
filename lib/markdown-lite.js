/**
 * 随问 AskAlong · 轻量 Markdown 渲染器(无依赖,输出安全转义的 HTML)
 * 支持: fenced code / 标题 / 列表 / 引用 / 表格 / 分隔线 / 行内代码 / 加粗 / 斜体 / 链接
 * 挂载到全局 AskAlongMD。
 */
(function (g) {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code class="aa-ic">$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return s;
  }

  /**
   * 思考模型的推理过程展示块。
   * live=true: 正在思考,灰底滚动展示推理文本尾部;
   * live=false: 完成后折叠为 <details>。
   */
  function thinkBlock(think, live) {
    const text = String(think || '');
    if (!text) return '';
    const body = esc(text).replace(/\n/g, '<br>');
    if (live) {
      return (
        '<div class="aa-think aa-think-live"><b>💭 深度思考中…</b>' +
        '<div class="aa-think-body">' + body.slice(-500) + '</div></div>'
      );
    }
    return (
      '<details class="aa-think"><summary>💭 已深度思考(' + text.length + ' 字)</summary>' +
      '<div class="aa-think-body">' + body + '</div></details>'
    );
  }

  const BLOCK_START = /^\s*(```|#{1,6} |> |(?:[-*+]|\d+[.)])\s|\|)/;

  function render(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // fenced code
      const fence = line.match(/^\s*```\s*(\S*)\s*$/);
      if (fence) {
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        out.push(
          '<pre class="aa-pre">' +
          (lang ? '<span class="aa-lang">' + esc(lang) + '</span>' : '') +
          '<code>' + esc(buf.join('\n')) + '</code></pre>'
        );
        continue;
      }

      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const n = h[1].length;
        out.push(`<h${n} class="aa-h">` + inline(h[2]) + `</h${n}>`);
        i++;
        continue;
      }

      // hr
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push('<hr class="aa-hr">');
        i++;
        continue;
      }

      // table (| a | b | 分隔行)
      if (
        line.includes('|') &&
        i + 1 < lines.length &&
        /^\s*\|?\s*:?-{2,}[-\s:|]*\|?\s*$/.test(lines[i + 1]) &&
        lines[i + 1].includes('-')
      ) {
        const splitRow = (l) =>
          l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push(
          '<table class="aa-table"><thead><tr>' +
          head.map((c) => '<th>' + inline(c) + '</th>').join('') +
          '</tr></thead><tbody>' +
          rows
            .map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>')
            .join('') +
          '</tbody></table>'
        );
        continue;
      }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote class="aa-quote">' + inline(buf.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
        continue;
      }

      // list(平铺一层,不处理嵌套缩进,足够覆盖模型输出)
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(
          `<${tag} class="aa-list">` +
          items.map((it) => '<li>' + inline(it) + '</li>').join('') +
          `</${tag}>`
        );
        continue;
      }

      // blank
      if (!line.trim()) {
        i++;
        continue;
      }

      // paragraph
      const buf = [];
      while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (buf.length) {
        out.push('<p class="aa-p">' + inline(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
      } else {
        i++; // 防御:异常行直接跳过,避免死循环
      }
    }

    return out.join('\n');
  }

  const AskAlongMD = { render, esc, thinkBlock };
  if (typeof module !== 'undefined' && module.exports) module.exports = AskAlongMD;
  g.AskAlongMD = AskAlongMD;
})(typeof window !== 'undefined' ? window : globalThis);
