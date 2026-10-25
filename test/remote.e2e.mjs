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
// Use full Chromium new headless: headless-shell lacks the service-worker BadgeService binder.
const browser = await chromium.launch({ channel: 'chromium', executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage(), errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('crash', () => console.error('remote e2e: native renderer crash'));
browser.on('disconnected', () => console.log('remote e2e: browser disconnected'));
const request = (kind, source) => ({ username:'Xpy', id: crypto.randomUUID(), kind, topic: '隔离浏览器测试 · ' + kind, source: { session: source, project: '/isolated/browser-test', machine: 'test' }, requestToken: crypto.randomBytes(32).toString('base64url') });
async function api(route, data, key = agentToken, method = 'POST', source) {
  const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Handover-Username':'Xpy', Authorization: 'Bearer ' + key, ...(source ? { 'X-Handover-Source': source } : {}) }, body: data ? JSON.stringify(data) : undefined });
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
  console.log('remote e2e: opening username login');
  await page.goto(url + '/?username=Xpy');
  await page.locator('#username').fill('Xpy');
  console.log('remote e2e: submitting username login (service worker identity/badge path)');
  await page.locator('#username-form button').click();
  console.log('remote e2e: waiting for initial request list');
  await page.locator(`a.request[href="/grill/${a.id}/?username=Xpy"]`).waitFor();
  await fit('手机收件箱');
  await page.locator(`a.request[href="/grill/${a.id}/?username=Xpy"]`).click();
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
  // Phone tools are intentionally collapsed: exercise the same disclosure a person uses.
  const more = page.locator('.handover-more');
  assert.equal(await more.getAttribute('open'), null);
  assert.equal(await page.getByRole('button', { name: '字号 +' }).isVisible(), false);
  assert.equal(await page.locator('main').evaluate((el) => getComputedStyle(el).fontSize), '18px');
  await more.locator('summary').click();
  await page.getByRole('button', { name: '字号 +' }).click();
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--handover-font').trim()), '22px');
  // Approved compact phone text scales to 90%; the stored font preference remains 22px.
  assert.equal(await page.locator('main').evaluate((el) => getComputedStyle(el).fontSize), '19.8px');
  assert.equal(await page.locator('.opt').first().evaluate((el) => getComputedStyle(el).fontSize), '19.8px');
  await more.locator('summary').click();
  assert.equal(await page.getByRole('button', { name: '字号 +' }).isVisible(), false);
  await fit('手机放大字号');
  if (evidence) await page.screenshot({ path: path.join(evidence, 'phone-questionnaire.png'), fullPage: true });
  // Clear only the unsent text; preserve the staged multi-selection.
  await page.locator('#free').fill('');
  await page.locator('#send').click();
  await page.waitForURL(url + '/?username=Xpy');
  const first = await scoped(a, '/wait?timeout=0', null, 'GET');
  assert.equal(first.events.length, 1);
  assert.deepEqual(first.events[0].actions.find((x) => x.type === 'answer').options, ['B', 'C']);
  // A durable send returns to the list without consuming the Agent's event.
  assert.equal(first.handled, 0); assert.equal(first.waitingFor, 'agent');
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal((await scoped(a, '/wait?timeout=0', null, 'GET')).events.length, 1);
  await scoped(a, '', { questions: [{ id: 'q1', status: 'answered', answer: { kind: 'option', options: ['B', 'C'] } }], agent: { status: 'waiting' } }, 'PATCH');
  await scoped(a, '/ack', { seq: 1 });
  await page.waitForURL(url + '/?username=Xpy');
  await page.goto(`${url}/grill/${a.id}/?username=Xpy`);
  await page.waitForFunction(() => document.querySelectorAll('.opt.chosen').length === 2);
  // Independent feedback receives no draft or pending answer from request a.
  await page.goto(`${url}/grill/${b.id}/?username=Xpy`);
  await page.locator('#free').waitFor();
  assert.equal(await page.locator('#free').inputValue(), '');
  await page.locator('#free').fill('隔离反馈内容');
  await page.locator('#stage-text').click();
  await page.locator('#send').click();
  await page.waitForURL(url + '/?username=Xpy');
  const second = await scoped(b, '/wait?timeout=0', null, 'GET');
  assert.equal(second.events[0].sourceSession, b.source.session);
  assert.equal(second.events[0].actions[0].text, '隔离反馈内容');
  assert.deepEqual((await scoped(a, '/wait?timeout=0', null, 'GET')).events, []);
  assert.equal(second.handled, 0); assert.equal(second.waitingFor, 'agent');
  await page.goto(`${url}/grill/${b.id}/?username=Xpy`); await page.locator('#free').waitFor();
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.waitForFunction(() => document.querySelector('.handover-more')?.hidden === true);
  await fit('平板反馈');
  assert.equal(await page.locator('.handover-more').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '字号 +' }).isVisible(), true);
  assert.equal(await page.locator('main').evaluate((el) => getComputedStyle(el).fontSize), '22px');
  const geometry = await page.evaluate(() => Object.fromEntries(['header','#main','#aside','footer'].map((selector) => { const r=document.querySelector(selector).getBoundingClientRect();return [selector,{top:r.top,bottom:r.bottom}]; })));
  assert.ok(geometry['#aside'].top >= geometry['#main'].bottom - 1, JSON.stringify(geometry));
  assert.equal(await page.locator('header').count(), 1);
  if (evidence) await page.screenshot({ path: path.join(evidence, 'tablet-feedback.png'), fullPage: true });
  // Same content can be submitted again after the first event was actually handled.
  await scoped(b, '', { questions: [{ id: 'q1', status: 'answered', answer: { kind: 'text', text: '隔离反馈内容' } }], agent: { status: 'waiting' } }, 'PATCH');
  await scoped(b, '/ack', { seq: 1 });
  assert.equal((await scoped(b, '/wait?timeout=0', null, 'GET')).waitingFor, 'agent');
  await page.goto(`${url}/grill/${b.id}/?username=Xpy`); await page.locator('#free').waitFor();
  await page.locator('#free').fill('隔离反馈内容'); await page.locator('#stage-text').click(); await page.locator('#send').click();
  await page.waitForURL(url + '/?username=Xpy');
  const repeated = await scoped(b, '/wait?timeout=0', null, 'GET');
  assert.equal(repeated.events[0].seq, 2);
  assert.notEqual(second.events[0].submissionId, repeated.events[0].submissionId);
  assert.equal(repeated.handled, 1); assert.equal(repeated.waitingFor, 'agent');
  // Revisiting to write a new draft must not let a later ACK discard it.
  await page.goto(`${url}/grill/${b.id}/?username=Xpy`); await page.locator('#free').waitFor();
  await page.locator('#free').fill('尚未发送的新补充');
  const observedAck = page.waitForResponse(async (response) => new URL(response.url()).pathname === `/grill/${b.id}/state` && response.ok() && (await response.json()).agent?.handled === 2);
  await scoped(b, '/ack', { seq: 2 }); await observedAck;
  // Wait through the listener fetch so the browser has applied the returned state.
  await page.waitForResponse((response) => new URL(response.url()).pathname === `/grill/${b.id}/listener` && response.ok());
  assert.equal(new URL(page.url()).pathname, `/grill/${b.id}/`);
  assert.equal(await page.locator('#free').inputValue(), '尚未发送的新补充');
  const c = request('help', 'isolated-browser-source-c');
  await api('/api/requests', c); await page.goto(`${url}/grill/${c.id}/?username=Xpy`);
  await page.locator('#free').fill('隔离失败提交'); await page.locator('#stage-text').click();
  await page.route(`**/grill/${c.id}/send*`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '隔离提交失败' }) }));
  await page.locator('#send').click(); await page.getByText('发送失败：隔离提交失败').waitFor();
  assert.equal(new URL(page.url()).pathname, `/grill/${c.id}/`);
  assert.equal((await scoped(c, '/wait?timeout=0', null, 'GET')).events.length, 0);
  await page.unroute(`**/grill/${c.id}/send*`);
  // Retired credentials cannot create cookies or revive private login.
  for (const route of ['/api/login','/api/login/ticket','/api/browser-tickets','/api/login-code','/api/pairing-tickets','/api/logout']) {
    const retired = await fetch(url + route, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:adminToken})});
    assert.equal(retired.status,410);assert.equal(retired.headers.get('set-cookie'),null);
  }
  // Remembered username opens matching deep links without another login form.
  await page.goto(url + '/?username=Xpy'); await page.reload(); await page.locator('#workspace').waitFor();
  await page.goto(`${url}/grill/${a.id}/?username=Xpy`); await page.locator('.opt.chosen').first().waitFor();
  await page.goto(url + '/?username=Xpy');
  await page.locator('#username-logout').click();
  await page.locator('#username-panel').waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>localStorage.getItem('handover:username') || null),null);
  await page.goto(`${url}/grill/${a.id}/?username=Xpy`);
  await page.waitForURL((target)=>target.pathname==='/' && target.searchParams.get('request')===a.id && target.searchParams.get('username')==='Xpy');
  assert.equal(await page.locator('#username').inputValue(),'');
  await page.locator('#username').fill('Xpy'); await page.locator('#username-form button').click();
  await page.waitForURL(`${url}/grill/${a.id}/?username=Xpy`); await page.locator('.opt.chosen').first().waitFor();
  await page.goto(url + '/?username=Xpy');
  await page.evaluate((id) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'handover:navigate', username:'Xpy', url: '/grill/' + id + '/?username=Xpy' } })), b.id);
  await page.waitForURL(`${url}/grill/${b.id}/?username=Xpy`); await page.locator('#free').waitFor();
  await page.goto(url + '/?username=Xpy'); await page.locator('#workspace').waitFor();
  const worker = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  assert.equal(worker, url + '/sw.js');
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (key) => (await (await caches.open(key)).keys()).map((req) => new URL(req.url).pathname)))).flat());
  assert.equal(cached.some((route) => route.startsWith('/api/') || route.startsWith('/grill/')), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ['手机及平板布局', '字号调整', '多选和本地草稿恢复', '反馈单独处理', '重复内容的独立提交', '来源隔离', '提交保存后立即返回且不消费事件', '失败或有新草稿时留在原题', '登录后直达通知目标题', '通知消息在已有窗口直达目标题', '旧凭据入口退休', '用户名持久登录及显式退出', 'Service Worker 不缓存私有答复', '无脚本错误'] }));
} finally {
  await browser.close(); app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
}
