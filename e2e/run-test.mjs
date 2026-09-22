/**
 * 随问 AskAlong · 端到端测试
 * 用系统 Chrome 加载扩展,验证完整链路:
 *   设置页保存 → 打开文章页 → 划词 → 工具条出现 → 点「解释」
 *   → 快答卡流式渲染 → 断言发给模型的请求携带了全文/代码块/表格/划选
 *   → 侧边栏发消息 → 流式回答渲染。
 * 运行:cd e2e && npm i && node run-test.mjs
 */
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { start } = require('./mock-llm.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(__dirname, 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  // Chrome for Testing(137+ 正式版 Chrome 禁用 --load-extension,须用 CfT)
  path.join(__dirname, '.browsers', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
].filter(Boolean);

const results = [];
let hardFail = false;
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome,可用 CHROME_PATH 环境变量指定');
}

async function launchWithExtension(chromePath, headless) {
  return puppeteer.launch({
    executablePath: chromePath,
    headless,
    protocolTimeout: 120000,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--window-size=1360,920',
      '--no-first-run',
      '--no-default-browser-check',
      // 多标签页测试:禁止 Chrome 对后台 tab 做渲染进程挂起/节流,
      // 否则切到前台页后,后台的扩展面板页无法响应 CDP 调用
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling'
    ],
    defaultViewport: { width: 1360, height: 920 }
  });
}

async function getExtensionId(browser, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = browser.targets().find((x) => x.type() === 'service_worker' && x.url().startsWith('chrome-extension://'));
    if (t) return new URL(t.url()).host;
    await sleep(250);
  }
  throw new Error('扩展 Service Worker 未启动(可能该 Chrome 不支持无头加载扩展)');
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = String(e); }
    await sleep(200);
  }
  throw new Error('等待超时: ' + label + (lastErr ? ' · ' + lastErr : ''));
}

async function main() {
  const chromePath = await findChrome();
  const { server, port, state } = await start();
  const BASE = `http://127.0.0.1:${port}`;
  console.log(`mock 服务: ${BASE} · Chrome: ${chromePath}`);

  let browser;
  let headless = true;
  try {
    browser = await launchWithExtension(chromePath, true);
  } catch (e) {
    console.log('无头启动失败,回退有头模式:', e.message);
    browser = await launchWithExtension(chromePath, false);
    headless = false;
  }

  try {
    const extId = await getExtensionId(browser);
    console.log(`扩展 ID: ${extId} (${headless ? 'headless' : 'headful'})`);

    /* ---------- 1. 设置页:配置 mock 接口并保存 ---------- */
    const optPage = await browser.newPage();
    await optPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load' });
    await optPage.waitForSelector('#preset');

    await optPage.evaluate((base) => {
      document.getElementById('preset').value = '__custom__';
      document.getElementById('preset').dispatchEvent(new Event('change'));
      document.getElementById('baseUrl').value = base + '/v1/chat/completions';
      document.getElementById('apiKey').value = 'test-key-123';
      document.getElementById('model').value = 'mock-model';
      document.getElementById('maxContextChars').value = '16000';
    }, BASE);
    await optPage.click('#btn-save');
    await sleep(300);

    const saved = await optPage.evaluate(() => chrome.storage.sync.get(null));
    record('设置页保存配置', saved.baseUrl === `${BASE}/v1/chat/completions` && saved.apiKey === 'test-key-123',
      `baseUrl=${saved.baseUrl}`);

    /* ---------- 2. 文章页:划词 → 工具条 ---------- */
    const artPage = await browser.newPage();
    await artPage.goto(`${BASE}/article`, { waitUntil: 'load' });
    await sleep(600); // content script document_idle

    await artPage.evaluate(() => {
      const p = document.querySelector('#sel-target');
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const toolbarVisible = await waitFor(async () =>
      artPage.evaluate(() => {
        const h = document.getElementById('askalong-host');
        const tb = h && h.shadowRoot.querySelector('.aa-toolbar');
        return tb && tb.style.display === 'flex';
      }), 6000, '划词工具条出现');
    record('划词后工具条出现', !!toolbarVisible);
    await artPage.screenshot({ path: path.join(SHOT_DIR, '1-toolbar.png') });

    /* ---------- 3. 点「解释」→ 快答卡流式渲染 ---------- */
    await artPage.evaluate(() => {
      document.getElementById('askalong-host').shadowRoot.querySelector('[data-act="explain"]').click();
    });

    const cardText = await waitFor(async () => {
      const t = await artPage.evaluate(() => {
        const h = document.getElementById('askalong-host');
        if (!h) return '';
        const body = h.shadowRoot.querySelector('.aa-card-body');
        const stat = h.shadowRoot.querySelector('.aa-stat');
        // 正文含 MOCK_OK 且状态条显示「完成」(流式结束) 才算通过
        return body && stat && body.textContent.includes('MOCK_OK') && stat.textContent === '完成'
          ? body.textContent : '';
      });
      return t;
    }, 25000, '快答卡流式输出完成').catch((e) => {
      // 失败时转储快答卡实际内容,便于定位
      return artPage.evaluate(() => {
        const h = document.getElementById('askalong-host');
        const card = h && h.shadowRoot.querySelector('.aa-card');
        return card ? card.textContent : '(无快答卡)';
      }).then((dump) => { throw new Error(e.message + ' · 快答卡内容: ' + dump); });
    });
    record('快答卡流式渲染完成', cardText.includes('MOCK_OK'));
    await sleep(300);
    await artPage.screenshot({ path: path.join(SHOT_DIR, '2-quickcard.png') });

    /* ---------- 4. 断言发给模型的请求携带了完整上下文 ---------- */
    const last = state.last;
    const sys = last && last.messages.find((m) => m.role === 'system');
    const checks = {
      '请求为流式(stream=true)': last && last.stream === true,
      'system 含文章标题': sys && sys.content.includes('闭包详解:从入门到彻底搞懂'),
      'system 含正文段落': sys && sys.content.includes('函数与其词法作用域的组合'),
      'system 含代码块内容': sys && sys.content.includes('const answer = 42'),
      'system 含表格内容': sys && sys.content.includes('写法'),
      'system 含列表内容': sys && sys.content.includes('数据私有化'),
      '噪声被过滤(广告/页脚)': sys && !sys.content.includes('广告位招租') && !sys.content.includes('关于我们'),
      'system 含用户划选': sys && sys.content.includes('闭包是指函数与其词法作用域的组合'),
      '携带解释类提问模板': last && last.messages.at(-1).content.startsWith('请解释下面这段内容')
    };
    for (const [name, ok] of Object.entries(checks)) record(name, !!ok);

    const cardChecks = {
      '快答卡显示文章标题': cardText.includes('闭包详解'),
      '快答卡确认代码块上下文': cardText.includes('代码块已包含'),
      '快答卡显示划选内容': cardText.includes('你的划选'),
      '快答卡渲染思考过程块': cardText.includes('已深度思考')
    };
    for (const [name, ok] of Object.entries(cardChecks)) record(name, !!ok);

    /* ---------- 5. 侧边栏:发消息 → 流式回答 ---------- */
    const panel = await browser.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`, { waitUntil: 'load' });
    await panel.waitForSelector('#input');
    await sleep(500);

    await panel.type('#input', '什么是闭包?一句话解释');
    await panel.click('#btn-send');

    const panelText = await waitFor(async () => {
      const t = await panel.evaluate(() => document.getElementById('msgs').textContent);
      return t.includes('MOCK_OK') ? t : '';
    }, 20000, '侧边栏流式回答');
    record('侧边栏流式回答渲染', panelText.includes('MOCK_OK'));
    await sleep(300);
    await panel.screenshot({ path: path.join(SHOT_DIR, '3-sidepanel.png') });

    const last2 = state.last;
    const userMsg = last2 && last2.messages.filter((m) => m.role === 'user').at(-1);
    record('侧边栏请求携带提问', !!userMsg && userMsg.content.includes('什么是闭包'));
    record('侧边栏渲染思考过程块', panelText.includes('已深度思考'));

    /* ---------- 6. 会话持久化(storage.session) ---------- */
    // storage.session 仅受信上下文可读,改由侧边栏自身重载验证
    await panel.reload({ waitUntil: 'load' });
    await panel.waitForSelector('#input');
    await sleep(600);
    const restored = await panel.evaluate(() => document.getElementById('msgs').textContent);
    record('刷新侧边栏后会话恢复', restored.includes('MOCK_OK') && restored.includes('什么是闭包'));

    /* ---------- 7. 停止生成:发送按钮必须复位 ---------- */
    await panel.type('#input', '随便聊两句');
    await panel.click('#btn-send');
    await sleep(250); // 此刻正在流式输出中
    await panel.click('#btn-send'); // streaming 中再点 = 停止
    await sleep(400);
    const stopReset = await panel.evaluate(() => ({
      btn: document.getElementById('btn-send').textContent,
      streaming: document.querySelectorAll('.msg.streaming').length
    }));
    record('停止后发送按钮复位', stopReset.btn === '➤' && stopReset.streaming === 0,
      `btn=${stopReset.btn}`);

    /* ---------- 8. 编辑已发送提问并重新生成 ---------- */
    await panel.evaluate(() => {
      document.querySelector('.msg.user .copy-btn').click();
      const ta = document.querySelector('.edit-area');
      ta.value = '编辑后的问题:闭包有什么用?';
      document.querySelector('.edit-row .btn-resend').click();
    });
    await waitFor(async () => {
      // 同时等待:mock 收到新请求(防竞态) + DOM 重建完成且不再流式
      const reqOk = state.last && state.last.messages.length === 2 &&
        state.last.messages.at(-1).content.includes('编辑后的问题');
      const domOk = await panel.evaluate(() => {
        const users = [...document.querySelectorAll('.msg.user .bubble')];
        const lastUser = users.at(-1);
        return lastUser && lastUser.textContent.includes('编辑后的问题') &&
          document.querySelectorAll('.msg.streaming').length === 0;
      });
      return reqOk && domOk;
    }, 15000, '编辑重发完成');
    const editReq = state.last;
    record('编辑重发改写并截断旧对话',
      !!editReq && editReq.messages.length === 2 && editReq.messages.at(-1).content.includes('编辑后的问题'),
      `消息数=${editReq && editReq.messages.length}`);

    /* ---------- 9. 多标签页并行 & 切换不丢失 ---------- */
    const tabA = await browser.newPage();
    await tabA.goto(`${BASE}/article?label=甲`, { waitUntil: 'load' });
    await sleep(400);
    const tabB = await browser.newPage();
    await tabB.goto(`${BASE}/article?label=乙`, { waitUntil: 'load' });
    await sleep(400);

    // 面板切绑到标签 A(通过标签激活事件)
    await tabA.bringToFront();
    await waitFor(async () =>
      panel.evaluate(() => document.getElementById('ctx-title').textContent.includes('甲')),
      8000, '面板绑定标签A');

    // 注意:panel 此时是后台 tab,puppeteer 的合成鼠标点击(page.click)会挂死,
    // 改用 JS 层赋值与 click(与用户操作语义一致)
    const setInput = (v) => panel.evaluate((val) => {
      const el = document.getElementById('input');
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
    const clickSend = () => panel.evaluate(() => document.getElementById('btn-send').click());

    const reqCountBefore = state.all.length;
    await setInput('标记甲:这篇文章讲什么?');
    await clickSend();
    await sleep(150); // 此刻 A 的回答正在生成

    // 生成中途立刻切到标签 B —— A 的流不应中断
    await tabB.bringToFront();
    await waitFor(async () =>
      panel.evaluate(() => document.getElementById('ctx-title').textContent.includes('乙')),
      8000, '面板绑定标签B');
    await setInput('标记乙:并行提问');
    await clickSend();

    await waitFor(async () => state.all.length >= reqCountBefore + 2, 15000, '两个并行请求');
    await sleep(1800); // 等两边流式收尾(单流约 0.6s)

    const sessDom = () => panel.evaluate(() => ({
      html: document.getElementById('msgs').textContent,
      streaming: document.querySelectorAll('.msg.streaming').length,
      btn: document.getElementById('btn-send').textContent
    }));

    const domB = await sessDom();
    record('并行:标签B会话完整生成',
      domB.html.includes('标记乙') && domB.html.includes('(本次无划选)') && domB.streaming === 0 && domB.btn === '➤');

    await tabA.bringToFront();
    await waitFor(async () => (await sessDom()).html.includes('标记甲'), 8000, '切回标签A');
    const domA = await sessDom();
    record('切换后A的问答未丢失且后台完整生成',
      domA.html.includes('标记甲') && domA.html.includes('(本次无划选)') && domA.streaming === 0 && domA.btn === '➤');

    const markReqs = state.all.slice(reqCountBefore).map((r) => r.messages.at(-1).content);
    record('并行:两个请求各自独立处理',
      markReqs.some((c) => c.includes('标记甲')) && markReqs.some((c) => c.includes('标记乙')));

    /* ---------- 10. 面板已打开时,新划选实时送达 ---------- */
    // (模拟点「问AI」时后台落盘 pendSel;面板应即时显示提示条)
    const tid = await optPage.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find((t) => {
        try { return t.url && decodeURIComponent(t.url).includes('article?label=甲'); }
        catch (e) { return false; }
      });
      return hit ? hit.id : null;
    });
    await optPage.evaluate((tabId, sel) => chrome.storage.session.set({ ['pendSel:' + tabId]: sel }),
      tid, '闭包的应用场景有哪些?');
    await sleep(500);
    const chip = await panel.evaluate(() => ({
      visible: document.getElementById('sel-chip').style.display !== 'none',
      text: document.getElementById('sel-text').textContent
    }));
    record('面板打开时新划选实时显示',
      !!tid && chip.visible && chip.text.includes('闭包的应用场景'), chip.text || '(未显示)');

    await server.close();
  } catch (e) {
    hardFail = true;
    console.error('E2E 运行失败:', e);
  } finally {
    // 无头 Chrome 偶发不响应 Browser.close,收尾延迟 500ms 强制退出
    // (留出时间让管道化的 stdout 刷写完成)
    if (browser) await browser.close().catch(() => {});
    try { server.close(); } catch (e) { /* noop */ }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n===== 结果: ${results.length - failed.length}/${results.length} 通过 =====`);
    process.exitCode = hardFail || failed.length ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 500).unref();
  }
}

main();
