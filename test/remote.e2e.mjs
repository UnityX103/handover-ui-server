// Runs only against isolated local fixtures, never submits answers to real chats.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHandoverServer } from '../src/server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_PKG || 'playwright');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-browser-'));
const agentToken = crypto.randomBytes(32).toString('hex'), adminToken = crypto.randomBytes(32).toString('hex');
const app = createHandoverServer({ dataDir: dir, agentToken, adminToken, port: 0, publicUrl: 'http://127.0.0.1:0', disablePush: true });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage(), errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const request = (kind, source) => ({ id: crypto.randomUUID(), kind, topic: '隔离浏览器测试 · ' + kind, source: { session: source, project: '/isolated/browser-test', machine: 'test' }, requestToken: crypto.randomBytes(32).toString('base64url') });
async function api(route, data, key = agentToken, method = 'POST', source) {
  const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...(source ? { 'X-Handover-Source': source } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
const scoped = (r, suffix, data, method = 'POST') => api(`/api/requests/${r.id}${suffix}`, data, r.requestToken, method, r.source.session);
const fit = async (label) => {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, label + ': ' + JSON.stringify(dimensions));
};
const evidence = process.env.HANDOVER_EVIDENCE_DIR;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
try {
  const a = request('questionnaire', 'isolated-browser-source-a');
  a.questions = [{ id: 'q1', round: 1, title: '多选问题：请选择测试选项', body: '仅为测试数据，不表示人的真实决定。', multi: true, options: [{ k: 'A', text: '测试甲' }, { k: 'B', text: '测试乙' }, { k: 'C', text: '测试丙' }], rec: { options: ['A'], why: '只用于检查推荐不会自动提交' } }];
  const b = request('feedback', 'isolated-browser-source-b');
  await api('/api/requests', a); await api('/api/requests', b);
  await page.goto(url);
  await page.locator('#login-code').fill(adminToken);
  await page.locator('#login-form button').click();
  await page.locator(`a.request[href="/grill/${a.id}/"]`).waitFor();
  await fit('手机收件箱');
  await page.locator(`a.request[href="/grill/${a.id}/"]`).click();
  await page.locator('.opt[data-opt="B"]').waitFor();
  assert.equal(await page.locator('.opt.staged').count(), 0);
  await page.locator('.opt[data-opt="B"]').click();
  await page.locator('.opt[data-opt="C"]').click();
  assert.equal(await page.locator('.opt.staged').count(), 2);
  await page.locator('#free').fill('隔离草稿，刷新后保留');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#free')?.value === '隔离草稿，刷新后保留');
  assert.equal(await page.locator('.opt.staged').count(), 2);
  await fit('手机问卷');
  await page.getByRole('button', { name: '字号 +' }).click();
  const font = await page.locator('main').evaluate((el) => getComputedStyle(el).fontSize);
  assert.equal(font, '22px');
  await fit('手机放大字号');
  if (evidence) await page.screenshot({ path: path.join(evidence, 'phone-questionnaire.png'), fullPage: true });
  // Clear only the unsent text; preserve the staged multi-selection.
  await page.locator('#free').fill('');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelectorAll('.opt.pending').length === 2);
  const first = await scoped(a, '/wait?timeout=0', null, 'GET');
  assert.equal(first.events.length, 1);
  assert.deepEqual(first.events[0].actions.find((x) => x.type === 'answer').options, ['B', 'C']);
  // Saving alone does not redirect. Reloading retains the pending receipt.
  assert.equal(new URL(page.url()).pathname, `/grill/${a.id}/`);
  await page.reload();
  await page.locator('.opt.pending').first().waitFor();
  await scoped(a, '', { questions: [{ id: 'q1', status: 'answered', answer: { kind: 'option', options: ['B', 'C'] } }], agent: { status: 'waiting' } }, 'PATCH');
  await scoped(a, '/ack', { seq: 1 });
  await page.waitForURL(url + '/');
  await page.goto(`${url}/grill/${a.id}/`);
  await page.waitForFunction(() => document.querySelectorAll('.opt.chosen').length === 2);
  // Independent feedback receives no draft or pending answer from request a.
  await page.goto(`${url}/grill/${b.id}/`);
  await page.locator('#free').waitFor();
  assert.equal(await page.locator('#free').inputValue(), '');
  await page.locator('#free').fill('隔离反馈内容');
  await page.locator('#stage-text').click();
  await page.locator('#send').click();
  const second = await scoped(b, '/wait?timeout=0', null, 'GET');
  assert.equal(second.events[0].sourceSession, b.source.session);
  assert.equal(second.events[0].actions[0].text, '隔离反馈内容');
  assert.deepEqual((await scoped(a, '/wait?timeout=0', null, 'GET')).events, []);
  await page.setViewportSize({ width: 820, height: 1180 });
  await fit('平板反馈');
  const geometry = await page.evaluate(() => Object.fromEntries(['header','#main','#aside','footer'].map((selector) => { const r=document.querySelector(selector).getBoundingClientRect();return [selector,{top:r.top,bottom:r.bottom}]; })));
  assert.ok(geometry['#aside'].top >= geometry['#main'].bottom - 1, JSON.stringify(geometry));
  assert.equal(await page.locator('header').count(), 1);
  if (evidence) await page.screenshot({ path: path.join(evidence, 'tablet-feedback.png'), fullPage: true });
  // Same content can be submitted again after the first event was actually handled.
  await scoped(b, '', { questions: [{ id: 'q1', status: 'answered', answer: { kind: 'text', text: '隔离反馈内容' } }], agent: { status: 'waiting' } }, 'PATCH');
  await scoped(b, '/ack', { seq: 1 });
  await page.waitForURL(url + '/');
  await page.goto(`${url}/grill/${b.id}/`); await page.locator('#free').waitFor();
  await page.locator('#free').fill('隔离反馈内容'); await page.locator('#stage-text').click(); await page.locator('#send').click();
  const repeated = await scoped(b, '/wait?timeout=0', null, 'GET');
  assert.equal(repeated.events[0].seq, 2);
  assert.notEqual(second.events[0].submissionId, repeated.events[0].submissionId);
  // A receipt for an earlier submission must not discard new unsent text.
  await page.locator('#free').fill('尚未发送的新补充');
  await scoped(b, '/ack', { seq: 2 });
  await page.waitForFunction(() => !sessionStorage.getItem('handover:return:' + location.pathname));
  assert.equal(new URL(page.url()).pathname, `/grill/${b.id}/`);
  assert.equal(await page.locator('#free').inputValue(), '尚未发送的新补充');
  const c = request('help', 'isolated-browser-source-c');
  await api('/api/requests', c); await page.goto(`${url}/grill/${c.id}/`);
  await page.locator('#free').fill('隔离失败提交'); await page.locator('#stage-text').click();
  await page.route(`**/grill/${c.id}/send`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '隔离提交失败' }) }));
  await page.locator('#send').click(); await page.getByText('发送失败：隔离提交失败').waitFor();
  assert.equal(new URL(page.url()).pathname, `/grill/${c.id}/`);
  assert.equal((await scoped(c, '/wait?timeout=0', null, 'GET')).events.length, 0);
  await page.unroute(`**/grill/${c.id}/send`);
  await page.goto(url); await page.locator('#settings-toggle').click(); await page.locator('#pair').click();
  await page.locator('#pairing').waitFor(); assert.match(await page.locator('#pairing').textContent(), /[0-9A-F]{16}/);
  const loginCode=(await page.locator('#pairing').textContent()).match(/[0-9A-F]{16}/)[0];
  await page.locator('#pair').click();assert.ok((await page.locator('#pairing').textContent()).includes(loginCode));
  await page.locator('#logout').click();
  await page.goto(`${url}/grill/${a.id}/`);
  await page.waitForURL(url + '/?request=' + a.id);
  await page.locator('#login-code').fill(loginCode); await page.locator('#login-form button').click();
  await page.waitForURL(`${url}/grill/${a.id}/`); await page.locator('.opt.chosen').first().waitFor();
  await page.goto(url);
  await page.evaluate((id) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'handover:navigate', url: '/grill/' + id + '/' } })), b.id);
  await page.waitForURL(`${url}/grill/${b.id}/`); await page.locator('#free').waitFor();
  await page.goto(url); await page.locator('#workspace').waitFor();
  const worker = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  assert.equal(worker, url + '/sw.js');
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (key) => (await (await caches.open(key)).keys()).map((req) => new URL(req.url).pathname)))).flat());
  assert.equal(cached.some((route) => route.startsWith('/api/') || route.startsWith('/grill/')), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['手机及平板布局', '字号调整', '多选和本地草稿恢复', '反馈单独处理', '重复内容的独立提交', '来源隔离', '确认收到后自动返回首页', '失败或有新草稿时留在原题', '登录后直达通知目标题', '通知消息在已有窗口直达目标题', '固定登录码重复登录', 'Service Worker 不缓存私有答复', '无脚本错误'] }));
} finally {
  await browser.close(); app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
}
