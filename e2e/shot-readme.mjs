/**
 * 生成 README 用效果截图 → docs/img/
 * 使用一个返回真实风格回答(思考块 + Markdown)的本地 mock。
 * 运行:cd e2e && node shot-readme.mjs
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const OUT = path.resolve(__dirname, '..', 'docs', 'img');
fs.mkdirSync(OUT, { recursive: true });

const CHROME = path.join(__dirname, '.browsers', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* —— 假 LLM:返回真实观感的思考与回答 —— */
const THINK =
  '用户想要这篇文章的总结。先定位文章结构:什么是闭包、经典例子、应用场景、常见误区四节。' +
  '核心概念是"函数与词法作用域的组合",代码示例是计数器。按「一句话定义 → 要点 → 适用场景 → 注意事项」组织回答,要点输出。';
const ANSWER = `## 一句话总结

这篇文章用"计数器"例子讲透了 **闭包(Closure)**:内层函数可以访问外层函数的变量,即使外层函数已经返回——本质上闭包让函数拥有了"记忆"。

### 核心观点

- **数据私有化**:\`count\` 变量藏在闭包里,外部无法直接修改,只能通过暴露的函数访问
- **函数工厂**:同一段逻辑可以批量生成行为相似的新函数
- **经典陷阱**:循环里创建函数时,忘记用块级作用域会共享同一个变量

### 代码骨架

\`\`\`javascript
function makeCounter() {
  let count = 0;          // 被闭包"记住"的变量
  return function () {
    return ++count;       // 每次调用 +1
  };
}
const c = makeCounter();
c(); // 1
c(); // 2
\`\`\`

### 适用场景与注意

| 场景 | 典型用法 |
| --- | --- |
| 状态隐藏 | 模块模式、单例 |
| 回调传参 | 防抖、节流 |
| 函数式编程 | 柯里化、偏函数 |

> 注意:闭包会延长变量生命周期,滥用会增加内存占用,但不等于内存泄漏。`;

const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>闭包详解:从入门到彻底搞懂</title></head>
<body>
<main class="post-content">
  <h1>闭包详解:从入门到彻底搞懂</h1>
  <p>很多初学者第一次接触 JavaScript 闭包时都会一头雾水,这篇文章用最直白的语言把闭包讲清楚。</p>
  <h2>什么是闭包</h2>
  <p id="sel-target">闭包是指函数与其词法作用域的组合:内层函数可以访问外层函数的变量,即使外层函数已经返回。这听起来抽象,但本质上闭包让函数拥有了"记忆"。</p>
  <h2>一个经典例子</h2>
  <p>计数器是闭包最经典的用例,下面的代码中 count 变量只能通过闭包访问:</p>
  <pre><code class="language-javascript">function makeCounter() {
  let count = 0;
  return function () {
    count += 1;
    return count;
  };
}
const c = makeCounter();
c(); // 1
c(); // 2</code></pre>
  <h2>闭包的应用场景</h2>
  <ul><li>数据私有化:隐藏内部状态,只暴露访问器</li><li>函数工厂:批量生成行为相似的新函数</li><li>防抖与节流:定时器状态的持久化依赖闭包</li></ul>
  <p>总结:闭包是 JavaScript 中函数作为一等公民的自然结果,掌握它就掌握了函数式编程的大门钥匙。</p>
</main>
</body></html>`;

const sse = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const events = []
    .concat(THINK.match(/.{1,10}/gs).map((t) => ({ reasoning_content: t })))
    .concat(ANSWER.match(/.{1,10}/gs).map((c) => ({ content: c })));
  let i = 0;
  const timer = setInterval(() => {
    if (i >= events.length) { clearInterval(timer); res.write('data: [DONE]\n\n'); res.end(); return; }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: events[i++] }] }) + '\n\n');
  }, 15);
  res.on('close', () => clearInterval(timer));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/article') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(ARTICLE_HTML);
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let b = ''; req.on('data', (d) => (b += d));
    return req.on('end', () => sse(res));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 120000,
  args: [
    `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`,
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'
  ],
  defaultViewport: { width: 1360, height: 860 }
});

const swT = await (async () => {
  const dl = Date.now() + 20000;
  while (Date.now() < dl) {
    const t = browser.targets().find((x) => x.type() === 'service_worker');
    if (t) return t;
    await sleep(250);
  }
  throw new Error('no sw');
})();
const extId = new URL(swT.url()).host;

// 配置
const optPage = await browser.newPage();
await optPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load' });
await optPage.waitForSelector('#preset');
await optPage.evaluate((base) => {
  document.getElementById('preset').value = '__custom__';
  document.getElementById('preset').dispatchEvent(new Event('change'));
  document.getElementById('baseUrl').value = base + '/v1/chat/completions';
  document.getElementById('apiKey').value = 'key';
  document.getElementById('model').value = 'glm-5.3-flash';
}, BASE);
await optPage.click('#btn-save');
await sleep(300);

const article = await browser.newPage();
await article.setViewport({ width: 1360, height: 860 });
await article.goto(`${BASE}/article`, { waitUntil: 'load' });
await sleep(600);

// 面板
const panel = await browser.newPage();
await panel.setViewport({ width: 560, height: 860 });
await panel.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`, { waitUntil: 'load' });
await sleep(500);
// 面板绑定到文章页(切到文章页触发 onActivated,等上下文条出现文章标题)
await article.bringToFront();
await sleep(300);
for (let i = 0; i < 30; i++) {
  const t = await panel.evaluate(() => document.getElementById('ctx-title').textContent);
  if (t.includes('闭包详解')) break;
  await sleep(300);
}

const setInput = (v) => panel.evaluate((val) => {
  const el = document.getElementById('input');
  el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, v);
const clickSend = () => panel.evaluate(() => document.getElementById('btn-send').click());

// ① 侧边栏完整对话
await setInput('总结一下这篇文章,我是初学者');
await clickSend();
await waitForDone();
await sleep(600);
await panel.screenshot({ path: path.join(OUT, 'sidepanel.png') });
console.log('✓ sidepanel.png');

// ② 划词工具条(文章页)
await article.evaluate(() => {
  const p = document.querySelector('#sel-target');
  const r = document.createRange();
  r.selectNodeContents(p);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await sleep(500);
await article.screenshot({ path: path.join(OUT, 'toolbar.png') });
console.log('✓ toolbar.png');

// ③ 行内快答卡
await article.evaluate(() => {
  document.getElementById('askalong-host').shadowRoot.querySelector('[data-act="explain"]').click();
});
await waitCard();
await sleep(600);
await article.screenshot({ path: path.join(OUT, 'quickcard.png') });
console.log('✓ quickcard.png');

// ④ 编辑重发
await panel.evaluate(() => document.querySelector('.msg.user .copy-btn').click());
await sleep(300);
await panel.evaluate(() => {
  const ta = document.querySelector('.edit-area');
  ta.value = '用初中生能听懂的话,再解释一遍什么是闭包?';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
await panel.screenshot({ path: path.join(OUT, 'edit.png') });
console.log('✓ edit.png');

async function waitForDone() {
  for (let i = 0; i < 100; i++) {
    const ok = await panel.evaluate(() =>
      !document.querySelector('.msg.streaming') && document.querySelectorAll('.msg.assistant').length > 0);
    if (ok) return;
    await sleep(150);
  }
}
async function waitCard() {
  for (let i = 0; i < 100; i++) {
    const ok = await article.evaluate(() => {
      const h = document.getElementById('askalong-host');
      const stat = h && h.shadowRoot.querySelector('.aa-stat');
      return stat && stat.textContent === '完成';
    });
    if (ok) return;
    await sleep(150);
  }
}

await browser.close().catch(() => {});
server.close();
console.log('全部截图完成 →', OUT);
process.exit(0);
