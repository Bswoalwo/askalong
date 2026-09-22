/**
 * 录制 README 演示动图 → docs/img/demo.gif
 * 流程:浏览文章 → 划选文字 → 工具条浮现 → 点「解释」→ 快答卡流式作答 → 完成
 * 运行:cd e2e && node shot-demo.mjs
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const OUT = path.resolve(__dirname, '..', 'docs', 'img');
const CHROME = path.join(__dirname, '.browsers', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 假 LLM:思考块 + 真实观感的 Markdown 回答 */
const THINK =
  '用户选中了"什么是闭包"这一段,想要更详细的解释。需要讲清楚:函数+词法作用域的组合、外层函数返回后变量仍可访问、以及一个直观类比。组织成短小精悍的解释。';
const ANSWER = `### 一句话解释

**闭包 = 函数 + 它"记住"的外部变量。** 函数在哪里出生,就能访问哪里的变量——哪怕那个"家"(外层函数)已经执行完毕。

### 拆开看这段划选

- **词法作用域**:变量能不能用,由代码**书写的位置**决定。内层函数写在外层函数里,天生能用它的变量
- **"已经返回还能访问"**:正常情况下函数跑完变量就该回收,但只要有内层函数还引用着,这些变量就会存活

### 一个直观类比

\`\`\`javascript
function makeWallet() {
  let money = 100;              // 钱包里的钱(私有变量)
  return function pay() {
    money -= 10;                // pay 记住了自己的钱包
    return money;
  };
}
const myWallet = makeWallet();
myWallet(); // 90
myWallet(); // 80 —— 钱一直被"记住"
\`\`\`

> 类比:\`makeWallet\` 返回后,别人看不到 \`money\`,但 \`pay\` 随身带着这个钱包。这就是"函数拥有记忆"。`;

const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>闭包详解:从入门到彻底搞懂</title></head>
<body>
<main class="post-content" style="max-width:860px;margin:0 auto;font-family:-apple-system,'PingFang SC',sans-serif;line-height:1.8;padding:28px 8px">
  <h1>闭包详解:从入门到彻底搞懂</h1>
  <p>很多初学者第一次接触 JavaScript 闭包时都会一头雾水,这篇文章用最直白的语言把闭包讲清楚。</p>
  <h2>什么是闭包</h2>
  <p id="sel-target">闭包是指函数与其词法作用域的组合:内层函数可以访问外层函数的变量,即使外层函数已经返回。这听起来抽象,但本质上闭包让函数拥有了"记忆"。</p>
  <p>理解闭包之前,你需要先弄清楚 JavaScript 的作用域链与变量提升机制,否则很容易陷入似懂非懂的状态。</p>
  <h2>一个经典例子</h2>
  <p>计数器是闭包最经典的用例,下面的代码中 count 变量只能通过闭包访问:</p>
  <pre style="background:#f4f5f7;padding:14px;border-radius:8px"><code class="language-javascript">function makeCounter() {
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/article') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(ARTICLE_HTML);
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const events = []
      .concat(THINK.match(/.{1,8}/gs).map((t) => ({ reasoning_content: t })))
      .concat(ANSWER.match(/.{1,8}/gs).map((c) => ({ content: c })));
    let i = 0;
    const timer = setInterval(() => {
      if (i >= events.length) { clearInterval(timer); res.write('data: [DONE]\n\n'); return res.end(); }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: events[i++] }] }) + '\n\n');
    }, 28);
    res.on('close', () => clearInterval(timer));
    return;
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
  defaultViewport: { width: 1180, height: 740 }
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

// 配置 mock 接口
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
await optPage.close();

const article = await browser.newPage();
await article.goto(`${BASE}/article`, { waitUntil: 'load' });
await sleep(700);

// 开始录屏
const screencast = await article.screencast({ path: '/tmp/askalong-demo.webm' });

// 1) 浏览片刻
await sleep(1200);
// 2) 划选 → 工具条
await article.evaluate(() => {
  const p = document.querySelector('#sel-target');
  const r = document.createRange();
  r.selectNodeContents(p);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await sleep(1400);
// 3) 点「解释」→ 快答卡流式作答
await article.evaluate(() => {
  document.getElementById('askalong-host').shadowRoot.querySelector('[data-act="explain"]').click();
});
// 等流式完成
for (let i = 0; i < 200; i++) {
  const done = await article.evaluate(() => {
    const h = document.getElementById('askalong-host');
    const stat = h && h.shadowRoot.querySelector('.aa-stat');
    return stat && stat.textContent === '完成';
  });
  if (done) break;
  await sleep(150);
}
await sleep(1600);
await screencast.stop();
await browser.close().catch(() => {});
server.close();
console.log('录屏完成: /tmp/askalong-demo.webm');
process.exit(0);
