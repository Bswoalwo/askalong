/**
 * 随问 AskAlong · E2E mock LLM 服务
 *  - GET  /article              测试文章页(走通用 Readability 提取路径)
 *  - POST /v1/chat/completions  OpenAI 兼容 SSE 流式接口,
 *                               回复内容内嵌从请求中解析出的上下文信息作为标记
 *  - GET  /last                 返回最近一次对话请求的完整 body(JSON)
 *  - GET  /healthz              健康检查
 */
'use strict';
const http = require('http');

const state = { last: null, all: [] };

const ARTICLE_HTML = (label) => {
  const suffix = label ? `(${label})` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta property="og:title" content="闭包详解:从入门到彻底搞懂${suffix}">
<title>闭包详解:从入门到彻底搞懂${suffix}</title></head>
<body>
<nav class="main-nav"><a>首页</a><a>课程</a><a>下载App</a></nav>
<aside class="advert-box">广告位招租</aside>
<main class="post-content">
  <h1>闭包详解:从入门到彻底搞懂${suffix}</h1>
  <p>很多初学者第一次接触 JavaScript 闭包时都会一头雾水,这篇文章用最直白的语言把闭包讲清楚。</p>
  <h2>什么是闭包</h2>
  <p id="sel-target">闭包是指函数与其词法作用域的组合:内层函数可以访问外层函数的变量,即使外层函数已经返回。这听起来抽象,但本质上闭包让函数拥有了"记忆"。</p>
  <p>理解闭包之前,你需要先弄清楚 JavaScript 的作用域链与变量提升机制,否则很容易陷入似懂非懂的状态。</p>
  <h2>一个经典例子</h2>
  <p>计数器是闭包最经典的用例,下面的代码中 count 变量只能通过闭包访问:</p>
  <pre><code class="language-javascript">function makeCounter() {
  let count = 0;
  return function () {
    count += 1;
    return count;
  };
}
const answer = 42;
const c = makeCounter();
c(); // 1
c(); // 2</code></pre>
  <h2>闭包的应用场景</h2>
  <ul>
    <li>数据私有化:隐藏内部状态,只暴露访问器</li>
    <li>函数工厂:批量生成行为相似的新函数</li>
    <li>防抖与节流:定时器状态的持久化依赖闭包</li>
  </ul>
  <h2>常见误区</h2>
  <p>闭包并不等于内存泄漏,但滥用闭包确实会增加内存占用。下表对比了不同写法的差异:</p>
  <table>
    <tr><th>写法</th><th>闭包数量</th><th>内存占用</th></tr>
    <tr><td>模块模式</td><td>1 个</td><td>低</td></tr>
    <tr><td>循环内创建函数</td><td>N 个</td><td>高</td></tr>
  </table>
  <p>总结:闭包是 JavaScript 中函数作为一等公民的自然结果,掌握它就掌握了函数式编程的大门钥匙。</p>
</main>
<footer class="site-footer">© 2026 示例站点 · 关于我们 · 联系方式</footer>
</body></html>`;
};

function analyze(body) {
  const sys = (body.messages || []).find((m) => m.role === 'system');
  const content = sys ? sys.content : '';
  const title = (content.match(/title="([^"]*)"/) || [])[1] || '无';
  const sel = (content.match(/<用户划选>\n([\s\S]*?)<\/用户划选>/) || [])[1] || '';
  const art = (content.match(/<文章上下文[^>]*>\n([\s\S]*?)<\/文章上下文>/) || [])[1] || '';
  return {
    content,
    title,
    sel,
    art,
    hasCode: art.includes('const answer = 42'),
    hasTable: art.includes('| 写法 |'),
    hasList: art.includes('数据私有化')
  };
}

function sseReply(res, body) {
  const a = analyze(body);
  const reply =
    `MOCK_OK 已读到《${a.title}》全文约 ${a.art.length} 字。` +
    `校验:代码块${a.hasCode ? '已包含' : '缺失'},表格${a.hasTable ? '已包含' : '缺失'},列表${a.hasList ? '已包含' : '缺失'}。` +
    (a.sel ? `你的划选:「${a.sel.slice(0, 50)}」` : '(本次无划选)');

  // 模拟思考模型:先流式输出 reasoning_content,再输出正式内容
  const think =
    '(思考过程)定位文章结构与用户问题相关的章节,核对提取到的代码块、表格与划选片段是否完整,然后组织分点回答。';
  const events = []
    .concat((think.match(/.{1,10}/gs) || []).map((t) => ({ reasoning_content: t })))
    .concat((reply.match(/.{1,8}/gs) || []).map((c) => ({ content: c })));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  let i = 0;
  const timer = setInterval(() => {
    if (i >= events.length) {
      clearInterval(timer);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const payload = { choices: [{ delta: events[i++] }] };
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  }, 25);

  res.on('close', () => clearInterval(timer));
}

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
      });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/article') {
      const raw = url.searchParams.get('label') || '';
      const label = raw.replace(/[<>"'`]/g, '').slice(0, 12);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(ARTICLE_HTML(label));
    }
    if (req.method === 'GET' && url.pathname === '/last') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state.last || null));
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200);
      return res.end('ok');
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let buf = '';
      req.on('data', (d) => { buf += d; });
      req.on('end', () => {
        try { state.last = JSON.parse(buf); } catch (e) { state.last = { parseError: String(e) }; }
        state.all.push(state.last);
        sseReply(res, state.last);
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

module.exports = { start, ARTICLE_HTML };
