import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { start } = require('./mock-llm.cjs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const CHROME = path.join(__dirname, '.browsers', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { server, port } = await start();
const BASE = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run'],
  defaultViewport: { width: 1100, height: 900 }
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

const optPage = await browser.newPage();
await optPage.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load' });
await optPage.waitForSelector('#preset');
await optPage.evaluate((base) => {
  document.getElementById('preset').value = '__custom__';
  document.getElementById('preset').dispatchEvent(new Event('change'));
  document.getElementById('baseUrl').value = base + '/v1/chat/completions';
  document.getElementById('apiKey').value = 'k';
  document.getElementById('model').value = 'm';
}, BASE);
await optPage.click('#btn-save');
await sleep(300);

const panel = await browser.newPage();
await panel.setViewport({ width: 620, height: 900 });
await panel.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`, { waitUntil: 'load' });
await panel.waitForSelector('#input');
await sleep(600);
await panel.type('#input', '请总结这篇文章:核心观点、关键概念、适用场景与局限,用要点输出。');
await panel.click('#btn-send');
await sleep(2500);
await panel.evaluate(() => document.querySelector('.msg.user .copy-btn').click());
await sleep(300);
await panel.screenshot({ path: path.join(__dirname, 'shots', '4-edit-mode.png') });
console.log('截图完成: e2e/shots/4-edit-mode.png');

await browser.close().catch(() => {});
server.close();
process.exit(0);
