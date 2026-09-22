/**
 * 随问 AskAlong · Service Worker
 * 职责:
 *  1. 作为所有 LLM 请求的流式代理(content script / side panel 通过
 *     名为 chat-stream 的 Port 连接过来,这里做 SSE 解析并回推增量);
 *  2. 打开侧边栏(工具条按钮 / 快答卡的「追问」);
 *  3. 在 storage.session 里落一份「快答卡 → 侧边栏」的交接数据。
 */
importScripts('/lib/shared.js');

const sessionKeysByTab = new Map(); // tabId -> Set<AbortController>

chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.sync.get(null);
  const missing = {};
  for (const [k, v] of Object.entries(AskAlong.DEFAULTS)) {
    if (!(k in cur)) missing[k] = v;
  }
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);

  // 旧默认模型升级到 GLM 旗舰 Flash(仅当用户未自行改过模型时触发)
  if ((cur.preset || 'glm') === 'glm' && cur.model === 'glm-4-flash') {
    await chrome.storage.sync.set({ model: AskAlong.DEFAULTS.model, preset: 'glm' });
  }

  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

try {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
} catch (e) { /* 旧版本 Chrome 无 sidePanel API 时忽略 */ }

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab || !sender.tab.id) return;
  const tabId = sender.tab.id;

  if (msg.type === 'OPEN_SIDE_PANEL') {
    // 必须在消息到达的同步栈内立即打开:sidePanel.open 依赖用户手势,
    // 放进 .then() 异步链会丢失手势导致"点了没反应"。
    // 划选并行落盘即可——面板加载(数百毫秒)远慢于一次存储写入。
    openPanel(tabId);
    if (msg.selection) {
      chrome.storage.session
        .set({ ['pendSel:' + tabId]: msg.selection })
        .catch(() => {});
    }
  } else if (msg.type === 'SAVE_HANDOFF') {
    // 行内快答卡 → 侧边栏:把这一轮问答带入完整对话
    chrome.storage.session
      .set({ ['handoff:' + tabId]: msg.payload })
      .then(() => openPanel(tabId))
      .catch(() => {});
  }
});

function openPanel(tabId) {
  try {
    const p = chrome.sidePanel.open({ tabId });
    if (p && p.catch) p.catch(() => fallbackOpen());
  } catch (e) {
    fallbackOpen();
  }
}

/** sidePanel.open 失败(如手势受限)时,退而求其次用标签页打开面板 */
function fallbackOpen() {
  try {
    console.warn('随问: sidePanel.open 不可用,已改用标签页打开面板。', chrome.runtime.lastError || '');
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
  } catch (e) { /* noop */ }
}

/* MV3 SW 空闲 30s 会被 Chrome 杀掉;思考模型出首字前可能静默数十秒,
 * 期间没有任何 Port 消息 → SW 挂掉 → “连接中断”。
 * 有请求在飞时,每 20s 调一次扩展 API 重置空闲计时器(官方认可的保活方式)。 */
let inflightCount = 0;
let keepAliveTimer = null;

function keepAliveTick() {
  try {
    chrome.runtime.getPlatformInfo().catch(() => {});
  } catch (e) { /* noop */ }
}

function enterRequest() {
  inflightCount++;
  if (!keepAliveTimer) {
    keepAliveTick();
    keepAliveTimer = setInterval(keepAliveTick, 20000);
  }
}

function exitRequest() {
  inflightCount = Math.max(0, inflightCount - 1);
  if (inflightCount === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chat-stream') return;

  const controllers = new Set();
  port.onDisconnect.addListener(() => {
    for (const c of controllers) c.abort();
    controllers.clear();
  });

  port.onMessage.addListener((msg) => {
    if (msg.type !== 'CHAT_REQUEST') return;
    const { requestId, payload } = msg;
    const ctrl = new AbortController();
    controllers.add(ctrl);
    enterRequest();

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      exitRequest();
      controllers.delete(ctrl);
    };

    streamLLM(payload, ctrl.signal, {
      onDelta: (delta) => safeSend({ type: 'DELTA', requestId, delta }),
      onThink: (delta) => safeSend({ type: 'THINK', requestId, delta }),
      onDone: () => {
        finish();
        safeSend({ type: 'DONE', requestId });
      }
    }).catch((err) => {
      if (!ctrl.signal.aborted) {
        safeSend({ type: 'ERROR', requestId, error: String((err && err.message) || err) });
      }
      finish();
    });
  });

  function safeSend(m) {
    try { port.postMessage(m); } catch (e) { /* port 已断开 */ }
  }
});

/** 请求 OpenAI 兼容接口并按 SSE 解析流式增量 */
async function streamLLM(payload, signal, cb) {
  let res;
  try {
    res = await fetch(payload.baseUrl, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (payload.apiKey || '')
      },
      body: JSON.stringify({
        model: payload.model,
        messages: payload.messages,
        temperature: payload.temperature,
        stream: true
      })
    });
  } catch (e) {
    if (signal.aborted) return;
    throw new Error('网络请求失败:' + e.message);
  }
  if (signal.aborted) return;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let hint = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      hint = (j.error && (j.error.message || j.error.code)) || j.message || hint;
    } catch (e) { /* 保留原文 */ }
    throw new Error(`HTTP ${res.status}${hint ? ' · ' + hint : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { cb.onDone(); return; }
      try {
        const j = JSON.parse(data);
        const ch = j.choices && j.choices[0];
        const d = (ch && ch.delta) || (ch && ch.message) || {};
        // 思考模型的推理过程单独推送给前端折叠展示
        const think = d.reasoning_content || d.reasoning || '';
        if (think) cb.onThink(think);
        const delta = d.content || '';
        if (delta) cb.onDelta(delta);
      } catch (e) { /* 忽略无法解析的行 */ }
    }
  }
  cb.onDone();
}
