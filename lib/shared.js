/**
 * 随问 AskAlong · 共享库
 * 在 content script / side panel / options / service worker 四个上下文中都会加载。
 * 挂载到全局 AskAlong 命名空间。
 */
(function (g) {
  'use strict';

  const DEFAULTS = {
    preset: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKey: '',
    model: 'glm-5.3-flash',
    temperature: 0.6,
    maxContextChars: 16000,
    showToolbar: true
  };

  const PRESETS = {
    glm: {
      label: '智谱 GLM(有免费模型,推荐新手)',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      model: 'glm-5.3-flash',
      keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
    },
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      keyUrl: 'https://platform.deepseek.com/api_keys'
    },
    moonshot: {
      label: 'Moonshot / Kimi',
      baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
      model: 'moonshot-v1-8k',
      keyUrl: 'https://platform.moonshot.cn/console/api-keys'
    },
    openai: {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      keyUrl: 'https://platform.openai.com/api-keys'
    },
    ollama: {
      label: 'Ollama(本地模型)',
      baseUrl: 'http://localhost:11434/v1/chat/completions',
      model: 'qwen2.5',
      keyUrl: 'https://ollama.com'
    }
  };

  const PROMPT_TEMPLATES = {
    explain: (s) =>
      `请解释下面这段内容(选自我正在阅读的文章),面向初学者:先用一句话说清它是什么,再展开关键细节,必要时给一个直观类比或简短代码示例。如果它依赖某些前置概念而文章没有讲清,请顺便简要补课:\n\n"""\n${s}\n"""`,
    translate: (s) =>
      `请将下面内容准确翻译成简体中文,保留专有名词、代码与命令的原文;首次出现的重要术语请附英文对照:\n\n"""\n${s}\n"""`,
    chat: (s) => s
  };

  const QUICK_PROMPTS = [
    { icon: '📝', label: '总结全文', q: '请总结这篇文章:核心观点、关键概念、适用场景与局限,用要点输出。' },
    { icon: '🧱', label: '提炼概念', q: '请从文中提炼所有技术名词/概念,逐个用一两句话解释,并标注哪些是理解本文的关键前置知识。' },
    { icon: '🎯', label: '出题自测', q: '基于这篇文章出 5 道自测题(附答案与解析),覆盖文中最重要的知识点。' },
    { icon: '🧭', label: '学习路径', q: '如果要系统掌握这篇文章涉及的技术,应该按什么顺序学习?给出学习路径和推荐的资源类型。' }
  ];

  function getSettings() {
    return chrome.storage.sync.get(DEFAULTS);
  }

  /**
   * 文章过长时按「标题分节 + 与问题相关性」截断:
   * 保留开头、完整目录、与划选/问题最相关的若干节。
   */
  function smartTrim(text, max, focus) {
    if (!max || text.length <= max) return text;
    const parts = text.split(/\n(?=#{1,6} )/);
    const head = parts[0];
    const rest = parts.slice(1);
    const note = `\n\n[注意:文章过长已截断,原文共 ${text.length} 字,以上为与问题最相关的部分及完整目录]`;

    if (!rest.length) {
      const half = Math.max(200, Math.floor((max - 100) / 2));
      return text.slice(0, half) + '\n……(中间省略)……\n' + text.slice(-half) + note;
    }

    const outline = rest
      .map((s) => (s.match(/^#{1,6} [^\n]*/g) || []).join('\n'))
      .filter(Boolean)
      .join('\n');

    const focusWords = (focus || '')
      .split(/[\s,。,;:、??"'""''()()\[\]{}]+/)
      .filter((w) => w.length >= 2);
    const scored = rest
      .map((s) => ({
        s,
        score: focusWords.reduce((n, w) => n + (s.includes(w) ? 1 : 0), 0)
      }))
      .sort((a, b) => b.score - a.score);

    let used = Math.min(head.length, 2000) + outline.length + 100;
    const picked = [];
    for (const item of scored) {
      if (used >= max) break;
      if (item.score === 0 && used > max * 0.5) break;
      const slice = item.s.slice(0, Math.max(200, max - used));
      picked.push(slice);
      used += slice.length;
    }

    return (
      head.slice(0, 2000) +
      '\n\n## [文章目录]\n' + outline + '\n\n' +
      picked.join('\n\n') + note
    );
  }

  function systemPrompt(article, selection) {
    let p =
      '你是「随问 AskAlong」,一个嵌入浏览器的技术学习助手。用户正在浏览器里阅读一篇技术文章,并就可能看不懂的术语或知识点向你提问。\n' +
      '回答准则:\n' +
      '1. 使用与用户提问相同的语言回答(默认简体中文)。\n' +
      '2. 优先依据 <文章上下文> 回答;文章没讲到的用你自己的知识补充,并区分「文章中的说法」与「你的补充」。\n' +
      '3. 默认面向初学者:先给一句话直观解释,再展开细节;善用类比、小例子和简短代码。\n' +
      '4. 用 Markdown 结构化输出,保持简洁,不堆砌客套话。\n' +
      '5. 若上下文缺失或与问题无关,直接基于问题回答,并提示用户可以在网页上划选具体内容来获得更精准的解答。';

    if (article && article.text) {
      p += `\n\n<文章上下文 title="${article.title}" url="${article.url}" site="${article.site}">\n${article.text}\n</文章上下文>`;
    }
    if (selection) {
      p += `\n\n<用户划选>\n${selection}\n</用户划选>\n用户接下来的问题通常针对这段划选内容。`;
    }
    return p;
  }

  /**
   * 组装最终发给模型的消息:
   * system(角色 + 文章全文 + 划选) + 最近历史 + 当前问题
   */
  function buildMessages({ settings, article, selection = '', history = [], question }) {
    let art = article;
    if (art && art.text && settings.maxContextChars && art.text.length > settings.maxContextChars) {
      art = { ...art, text: smartTrim(art.text, settings.maxContextChars, selection || question) };
    }
    const msgs = [{ role: 'system', content: systemPrompt(art, selection) }];
    (history || []).slice(-12).forEach((m) => msgs.push({ role: m.role, content: m.content }));
    msgs.push({ role: 'user', content: question });
    return msgs;
  }

  /**
   * 通过 Service Worker 代理的流式对话客户端(content script 与页面脚本
   * 不能直接跨域请求,统一走 background)。
   * 返回 { stop() },调用 stop 可中断本次流式输出。
   */
  function streamChat(payload, handlers) {
    const port = chrome.runtime.connect({ name: 'chat-stream' });
    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      try { port.disconnect(); } catch (e) { /* noop */ }
    };
    port.onMessage.addListener((m) => {
      if (m.type === 'DELTA' && handlers.onDelta) handlers.onDelta(m.delta);
      else if (m.type === 'THINK' && handlers.onThink) handlers.onThink(m.delta);
      else if (m.type === 'DONE') { cleanup(); if (handlers.onDone) handlers.onDone(); }
      else if (m.type === 'ERROR') { cleanup(); if (handlers.onError) handlers.onError(m.error); }
    });
    port.onDisconnect.addListener(() => {
      // stopped=true 说明是用户主动停止,stop() 里已经本地触发过 onDone,这里不再报错
      if (!stopped && handlers.onError) handlers.onError('连接中断');
    });
    port.postMessage({ type: 'CHAT_REQUEST', requestId: 'r' + Date.now() + Math.random().toString(36).slice(2, 6), payload });
    return {
      stop: () => {
        if (stopped) return;
        cleanup();
        // 用户主动停止:立即本地触发 onDone 复位 UI,并保留已生成的部分内容
        if (handlers.onDone) handlers.onDone();
      }
    };
  }

  const AskAlong = {
    DEFAULTS,
    PRESETS,
    PROMPT_TEMPLATES,
    QUICK_PROMPTS,
    getSettings,
    smartTrim,
    systemPrompt,
    buildMessages,
    streamChat
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AskAlong;
  g.AskAlong = AskAlong;
})(typeof window !== 'undefined' ? window : globalThis);
