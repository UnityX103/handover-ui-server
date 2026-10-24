import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import webpush from 'web-push';
import { createHandoverServer } from '../src/server.mjs';
import { customLimits } from '../src/custom-page.mjs';

const agentToken = 'isolated-custom-agent-'.repeat(4), adminToken = 'isolated-custom-admin-'.repeat(4);
async function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-page-test-'));
  const config = { dataDir: dir, agentToken, adminToken, publicUrl: 'http://127.0.0.1:0', port: 0, disablePush: true, ...extra };
  const app = createHandoverServer(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); fs.rmSync(dir, { force: true, recursive: true }); });
  async function call(route, data, { key, cookie, source, method = data ? 'POST' : 'GET' } = {}) {
    const response = await fetch(base + route, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(source ? { 'X-Handover-Source': source } : {}) }, body: data ? JSON.stringify(data) : undefined, redirect: 'manual' });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, headers: response.headers, body };
  }
  const login = await call('/api/login', { token: adminToken });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const payload = () => ({ id: crypto.randomUUID(), requestToken: crypto.randomBytes(32).toString('hex'), source: { session: crypto.randomUUID(), project: '/isolated/custom' }, kind: 'feedback', topic: '隔离自定义页面', page: { version: 1, html: '<!doctype html><html><head></head><body>专用页</body></html>', feedbackType: 'example-decisions', documentId: 'review-fixed-1' } });
  const create = async (r = payload()) => { const result = await call('/api/requests', r, { key: agentToken }); assert.equal(result.status, 201); return { r, info: result.body }; };
  const scoped = (r, suffix, data, extra = {}) => call(`/api/requests/${r.id}${suffix}`, data, { key: r.requestToken, source: r.source.session, ...extra });
  return { ...app, dir, base, call, cookie, payload, create, scoped };
}

test('自定义页能力探测、认证及沙箱，列表不泄露 HTML 与请求凭据', async (t) => {
  const f = await fixture(t), { r, info } = await f.create();
  assert.equal((await f.call('/api/capabilities')).status, 403);
  assert.deepEqual((await f.call('/api/capabilities', undefined, { key: agentToken })).body.customPage, customLimits);
  assert.equal((await f.call(`/grill/${r.id}/`)).status, 302);
  assert.equal((await f.call(`/grill/${r.id}/content`)).status, 401);
  const content = await f.call(`/grill/${r.id}/content`, undefined, { cookie: f.cookie });
  assert.equal(content.status, 200);
  assert.match(content.headers.get('content-security-policy'), /sandbox allow-scripts allow-downloads/);
  assert.doesNotMatch(content.headers.get('content-security-policy'), /allow-same-origin/);
  assert.match(content.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(content.body, /HandoverBridge/);
  assert.equal(content.headers.get('cache-control'), 'no-store');
  const list = await f.call('/api/requests', undefined, { cookie: f.cookie });
  assert.equal(list.body.requests[0].page.pageHash, info.page.pageHash);
  assert.ok(!JSON.stringify(list.body).includes('<!doctype'));
  assert.ok(!JSON.stringify(list.body).includes(r.requestToken));
  assert.equal((await f.scoped(r, '', { page: r.page }, { method: 'PATCH' })).status, 400);
});

test('原样 JSON 按来源回传、重试幂等，记录后才确认且重启保留', async (t) => {
  const f = await fixture(t), { r, info } = await f.create(), other = (await f.create()).r;
  const payload = { schema: 'skill-defined', choices: [{ guid: 'a'.repeat(32), optionId: 'defer' }], nested: { value: 3 }, executionAuthorized: false };
  const data = { submissionId: crypto.randomUUID(), feedbackType: r.page.feedbackType, pageHash: info.page.pageHash, payload };
  const send = (body) => f.call(`/grill/${r.id}/feedback`, body, { cookie: f.cookie });
  assert.equal((await send({ ...data, pageHash: 'old' })).status, 400);
  assert.equal((await send({ ...data, feedbackType: 'wrong-type' })).status, 400);
  assert.equal((await f.call(`/grill/${r.id}/feedback`, data)).status, 401);
  const waiting = f.scoped(r, '/wait?timeout=1');
  assert.equal((await send(data)).body.seq, 1);
  assert.equal((await send(data)).body.seq, 1);
  assert.equal((await send({ ...data, payload: { different: true } })).status, 409);
  const events = (await waiting).body.events;
  assert.equal(events[0].type, 'feedback'); assert.deepEqual(events[0].payload, payload);
  assert.equal(events[0].documentId, r.page.documentId);
  assert.equal((await f.scoped(other, '/wait?timeout=0')).body.events.length, 0);
  assert.equal((await f.scoped(r, '', undefined, { source: other.source.session })).status, 403);
  assert.equal((await f.scoped(r, '/wait?timeout=0')).body.events.length, 1);
  await f.scoped(r, '/ack', { seq: 1 });
  assert.equal((await f.scoped(r, '/wait?timeout=0')).body.events.length, 0);
  const restored = createHandoverServer({ dataDir: f.dir, agentToken, adminToken, publicUrl: 'http://127.0.0.1:0', disablePush: true });
  assert.deepEqual(restored.store.get(r.id).events[0].payload, payload);
  await f.scoped(r, '', { finished: { doc: '' } }, { method: 'PATCH' });
  assert.equal((await send(data)).body.handled, true);
  assert.equal((await send({ ...data, submissionId: crypto.randomUUID() })).status, 409);
});

test('自定义页面和反馈执行大小限制，不把 JSON 当代码执行', async (t) => {
  const f = await fixture(t), malformed = f.payload();
  malformed.page.html = 'x'.repeat(customLimits.maxHtmlBytes + 1);
  assert.equal((await f.call('/api/requests', malformed, { key: agentToken })).status, 400);
  assert.equal(f.store.list().length, 0);
  const { r, info } = await f.create();
  const data = { submissionId: crypto.randomUUID(), feedbackType: r.page.feedbackType, pageHash: info.page.pageHash, payload: { value: 'x'.repeat(customLimits.maxFeedbackBytes) } };
  assert.equal((await f.call(`/grill/${r.id}/feedback`, data, { cookie: f.cookie })).status, 400);
  assert.equal(f.store.get(r.id).events.length, 0);
});

test('固定登录与推送身份支持环境配置，保留旧数据与已登录会话', async (t) => {
  const keys = webpush.generateVAPIDKeys(), f = await fixture(t, { loginCode: 'FixtureCode9', vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:fixture@example.invalid' });
  assert.equal((await f.call('/api/login', { token: 'FixtureCode9' })).status, 200);
  assert.equal((await f.call('/api/login', { token: 'fixturecode9' })).status, 401);
  assert.equal((await f.call('/api/me', undefined, { cookie: f.cookie })).body.vapidPublicKey, keys.publicKey);
  assert.ok(!fs.existsSync(path.join(f.dir, 'login-code.json')));
  assert.ok(!fs.existsSync(path.join(f.dir, 'vapid.json')));
  assert.throws(() => createHandoverServer({ dataDir: f.dir, agentToken, adminToken, loginCode: 'short' }), /HANDOVER_LOGIN_CODE/);
  assert.throws(() => createHandoverServer({ dataDir: f.dir, agentToken, adminToken, vapidPublicKey: keys.publicKey }), /同时/);
});

test('CLI probe 只探测能力，不创建 handle 或业务请求', async (t) => {
  const f = await fixture(t), state = path.join(f.dir, 'isolated-client');
  const result = await promisify(execFile)(process.execPath, ['cli.mjs', 'probe'], { env: { ...process.env, HANDOVER_CONFIG: path.join(f.dir, 'absent.json'), HANDOVER_SERVER_URL: f.base, HANDOVER_AGENT_TOKEN: agentToken, HANDOVER_STATE_DIR: state, HANDOVER_SKIP_UPDATE: '1' } });
  assert.equal(JSON.parse(result.stdout).available, true);
  assert.equal(f.store.list().length, 0); assert.equal(fs.existsSync(state), false);
});
