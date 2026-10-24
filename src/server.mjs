import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import webpush from 'web-push';
import { applyPatch, validateState, validateAxesChange } from '../server.mjs';
import { Store, atomic, hash, equal, now, validId } from './store.mjs';
import { publicEndpoint, requestMount, shellHtml } from './public-paths.mjs';
import { customLimits, customPage, pageInfo, savedFeedback, validateFeedback, customCsp, customContent } from './custom-page.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const kinds = ['questionnaire', 'feedback', 'help'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (v, max = 4000) => typeof v === 'string' && v.length <= max;
// Receipt consumption is not an Agent reply; this independent phase survives ack.
const attentionVersion = (r) => Number.isSafeInteger(r.userAttentionVersion) && r.userAttentionVersion > 0 ? r.userAttentionVersion : 1;
const awaitingReply = (r) => typeof r.awaitingReply === 'boolean' ? r.awaitingReply : r.status === 'submitted';
const waitingFor = (r) => ['completed', 'cancelled'].includes(r.status) || r.state.finished ? null : awaitingReply(r) ? 'agent' : 'user';
const publicRequest = (r) => ({ id: r.id, kind: r.kind, topic: r.state.topic, source: r.source, ...(r.accessMode === 'username' ? { accessMode: r.accessMode, username: r.username } : {}), created: r.created, updated: r.updated, status: r.status, waitingFor: waitingFor(r), userAttentionVersion: attentionVersion(r), ...(r.cancellation ? {cancellation:r.cancellation} : {}), lastSeq: r.events.length, handled: r.state.agent.handled || 0, page: pageInfo(r) });

function actionsValid(actions, state) {
  if (!Array.isArray(actions) || !actions.length || actions.length > 100) fail(400, 'actions 应为 1–100 个操作');
  for (const a of actions) {
    if (!a || typeof a !== 'object' || !['answer', 'thread', 'defer', 'reopen', 'explore', 'visualize', 'visual-feedback', 'finish'].includes(a.type)) fail(400, '无效操作');
    const q = state.questions.find((q) => q.id === a.q);
    if (['answer', 'thread', 'defer', 'reopen', 'explore'].includes(a.type) && !q) fail(400, '操作指向未知问题');
    if (a.type === 'answer') {
      if (!['accept', 'option', 'text'].includes(a.kind)) fail(400, '无效答案类型');
      if (a.kind === 'text' && (!text(a.text, 20000) || !a.text.trim())) fail(400, '请输入真实回答');
      if (a.kind === 'option') {
        const selected = a.options || [a.option];
        if (!Array.isArray(selected) || !selected.length || selected.some((k) => !q.options?.some((o) => o.k === k)) || new Set(selected).size !== selected.length || (!q.multi && selected.length !== 1)) fail(400, '无效选项');
      }
      if (a.kind === 'accept' && !(q.rec?.text?.trim() || q.rec?.option || q.rec?.options?.length)) fail(400, '没有可采纳的推荐');
    }
    if (['thread', 'visual-feedback'].includes(a.type) && (!text(a.text, 20000) || !a.text.trim())) fail(400, '讨论内容不能为空');
  }
}

export function createHandoverServer(options = {}) {
  const config = {
    host: process.env.HANDOVER_HOST || '127.0.0.1', port: Number(process.env.HANDOVER_PORT || 8025),
    publicUrl: process.env.HANDOVER_PUBLIC_URL || 'http://127.0.0.1:8025',
    publicAliases: process.env.HANDOVER_PUBLIC_ALIASES || '',
    dataDir: process.env.HANDOVER_DATA_DIR || path.join(os.homedir(), '.local/share/handover-ui'),
    adminToken: process.env.HANDOVER_ADMIN_TOKEN,
    vapidPublicKey: process.env.HANDOVER_VAPID_PUBLIC_KEY, vapidPrivateKey: process.env.HANDOVER_VAPID_PRIVATE_KEY,
    vapidSubject: process.env.HANDOVER_VAPID_SUBJECT, ...options,
  };
  if (!text(config.adminToken) || config.adminToken.length < 32) throw new Error('管理密钥至少 32 字符；旧登录入口已停用');
  const publicUrl = publicEndpoint(config.publicUrl);
  const endpoints = [publicUrl, ...config.publicAliases.split(',').filter(Boolean).map((value) => publicEndpoint(value.trim()))];
  const store = new Store(config.dataDir);
  // Archived login codes, sessions, tickets and credentials are retained untouched.
  let vapid = store.all('vapid');
  if (config.vapidPublicKey !== undefined || config.vapidPrivateKey !== undefined) {
    if (!config.vapidPublicKey || !config.vapidPrivateKey) throw new Error('VAPID 环境变量必须同时设置公钥和私钥');
    webpush.setVapidDetails(config.vapidSubject || publicUrl.origin, config.vapidPublicKey, config.vapidPrivateKey);
    vapid = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
  } else if (!vapid.publicKey || !vapid.privateKey) { vapid = webpush.generateVAPIDKeys(); store.save('vapid', vapid); }
  const changes = new EventEmitter(); changes.setMaxListeners(1000);
  const waiters = new Map(); const listenerTimes = new Map();
  const emit = (r) => changes.emit(r.id);
  const username = (req) => {
    const url = new URL(req.url, publicUrl), values = url.searchParams.getAll('username');
    const header = req.headers['x-handover-username'];
    if (values.length > 1) fail(400, '用户名不能重复');
    const value = header !== undefined ? header : values[0];
    if (value === undefined) return null;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail(400, '用户名应为 1–64 个英文字母、数字、下划线或连字符');
    if (header !== undefined && values.length && header !== values[0]) fail(400, '用户名不一致');
    return value;
  };
  const usernameRecord = (r) => r?.accessMode === 'username' && typeof r.username === 'string';
  const requireUsername = (req) => { const name = username(req); if (!name) fail(403, '请指定目标用户名；旧模式已停用'); return name; };
  const requireRequestUser = (req, r) => {
    const name = requireUsername(req);
    if (!r || !usernameRecord(r) || r.username !== name) fail(404, '请求不存在');
    return name;
  };
  const scoped = (req, r) => {
    requireRequestUser(req, r);
    if (req.headers['x-handover-source'] !== r.source.session) fail(403, '来源会话不匹配');
  };
  const notify = async (request) => {
    if (!usernameRecord(request)) return 0;
    const subscriptions = store.all('subscriptions');
    const scopedSubscriptions = Object.entries(subscriptions).filter(([, sub]) => sub.accessMode === 'username' && sub.username === request.username);
    const notice = { ...(usernameRecord(request) ? {username:request.username} : {}), title: `远程交接 · ${{questionnaire:'问卷',feedback:'反馈',help:'求助'}[request.kind]}`, body: request.state.topic.slice(0, 100), tag: request.id, requestId: request.id, updated: request.updated, userAttentionVersion: attentionVersion(request) };
    const results = await Promise.allSettled(scopedSubscriptions.map(async ([key, sub]) => {
      try {
        const send = config.sendNotification || webpush.sendNotification.bind(webpush);
        const message = JSON.stringify({ ...notice, url: `${sub.basePath || '/'}grill/${request.id}/?username=${encodeURIComponent(request.username)}` });
        await send(sub.subscription, message, { TTL: 86400, urgency: 'high', timeout: 10000, vapidDetails: { subject: config.vapidSubject || publicUrl.origin, publicKey: vapid.publicKey, privateKey: vapid.privateKey } });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { const current = store.all('subscriptions'); if (JSON.stringify(current[key]) === JSON.stringify(sub)) { delete current[key]; store.save('subscriptions', current); } }
        else console.error(JSON.stringify({ event: 'push_failed', requestId: request.id, status: Number(e.statusCode) || 'network' }));
      }
    }));
    return results.length;
  };
  const notifyLater = (r) => { if (waitingFor(r) === 'user' && !config.disablePush) void notify(r).catch(() => console.error('push_dispatch_failed')); };
  const bytes = (res, status, content, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN', ...extra }); res.end(content);
  };
  const json = (res, status, value) => bytes(res, status, JSON.stringify(value));
  const body = async (req, max = 1048576) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, '需要 application/json');
    let n = 0; const chunks = [];
    for await (const chunk of req) { n += chunk.length; if (n > max) fail(413, '请求体过大'); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '需要 JSON 对象'); return value; }
    catch (e) { if (e.status) throw e; fail(400, 'JSON 格式错误'); }
  };
  const version = config.version || process.env.HANDOVER_VERSION || (() => { try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { return 'development'; } })();
  let server;
  const actualOrigin = () => `http://${config.host === '::1' ? '[::1]' : config.host}:${server.address()?.port || config.port}`;
  const page = (r, basePath) => {
    let html = fs.readFileSync(path.join(ROOT, 'page.html'), 'utf8').replace('__GRILL_THEME__', 'system');
    html = html.replace('<html lang="en"', '<html lang="zh-CN"');
    html = html.replace('const withToken = (p) =>', `const withToken = (input) => { const p = ${JSON.stringify(`${basePath}grill/${r.id}`)} + input; const name = new URLSearchParams(location.search).get('username'); if(name && !handoverSessionActive()) throw new Error('请先登录对应用户名'); if(name) return p + (p.includes('?') ? '&' : '?') + 'username=' + encodeURIComponent(name); return`)
      .replace('encodeURIComponent(LAN_TOKEN) : p;', 'encodeURIComponent(LAN_TOKEN) : p; };');
    html = html.replace('JSON.stringify({ actions })', 'JSON.stringify({ actions, submissionId: handoverSubmissionId(actions) })');
    html = html.replace('j = await r.json().catch(() => ({}));', 'j = await r.json().catch(() => ({})); if (!j || typeof j !== \"object\" || Array.isArray(j)) j = {}; j.ok = !!(r.ok && j.ok && j.saved === true && Number.isSafeInteger(j.seq) && j.seq > 0 && handoverSessionActive()); handoverSubmissionReceived(j, actions, r.ok);');
    html = html.replace('const handled = Number((S.agent || {}).handled) || 0;', 'const handled = Number((S.agent || {}).handled) || 0;\n  if (Array.isArray(S.submissions)) local.pending = S.submissions;\n  handoverReturnWhenAcknowledged(S);');
    html = html.replace('if (S && S.finished) { b.className', 'if (S && S.cancellation) { b.className = "show done"; b.textContent = "本次回答已取消；保留已有内容，不代表同意继续或已写入设计文档。"; return; }\n  if (S && S.finished) { b.className');
    html = html.replace('const key = "grill:" + (S.project || "") + ":" + (S.created || "");', 'const key = "handover:draft:" + handoverScope;');
    html = html.replace('"use strict";', '"use strict";\n' + fs.readFileSync(path.join(ROOT, 'web/grill-bridge.js'), 'utf8'));
    if (usernameRecord(r)) {
      const gate = `(() => { const target = ${JSON.stringify(r.username)}; let handoverSelectedUser = null; try { handoverSelectedUser = localStorage.getItem('handover:username'); if (handoverSelectedUser === null) { handoverSelectedUser = sessionStorage.getItem('handover:username'); if (handoverSelectedUser) localStorage.setItem('handover:username', handoverSelectedUser); sessionStorage.removeItem('handover:username'); } } catch {} if (handoverSelectedUser !== target) { location.replace(${JSON.stringify(basePath + '?request=' + r.id + '&username=' + encodeURIComponent(r.username))}); return; }\n`;
      html = html.replace('"use strict";', '"use strict";\n' + gate).replace('</script>', '\n})();\n</script>');
    }
    html = html.replace('</head>', '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/icon-192.png"><link rel="stylesheet" href="/grill.css"><script src="/navigation.js" defer></script><meta name="theme-color" content="#264e45"></head>');
    html = html.replace('<header>', '<header><a class="home-link" href="' + ('/?username=' + encodeURIComponent(r.username)) + '">← 全部请求</a><span class="request-kind">' + {questionnaire:'问卷',feedback:'反馈',help:'求助'}[r.kind] + '</span>');
    html = html.replace('<button class="primary" id="send" type="button" disabled>Send to Agent</button>', '<button class="primary" id="send" type="button" disabled>发送给 Agent</button>');
    html = html.replace('<input type="checkbox" id="use-subagent" checked>', '<input type="checkbox" id="use-subagent">').replace('subagent: true', 'subagent: false');
    const labels = [
      ['>Terms</button>', '>术语</button>'], ['>Visualize</button>', '>图解</button>'],
      ['>Stage text</button>', '>暂存文字</button>'], ['>Add to discussion</button>', '>加入讨论</button>'],
      ['>Discussion</h3>', '>讨论</h3>'], ['>Finish grill</button>', '>结束请求</button>'],
      ['>Cancel</button>', '>取消</button>'], ['"Send to Agent"', '"发送给 Agent"'],
      ['`Send ${n} to Agent`', '`发送 ${n} 项给 Agent`'], ['"Send failed: "', '"发送失败："'],
      ['"Your answer…"', '"请输入你的回答…"'], ['"Change your answer, or add nuance…"', '"修改回答或补充说明…"'],
      ['"Free-text answer, if none of the options fit…"', '"选项不合适时，可以填写文字回答…"'],
      ['>Defer this question</a>', '>暂缓此题</a>'], ['>Reopen this question</a>', '>重新打开此题</a>'],
      ['>Pick one or more</p>', '>可选择一项或多项</p>'],
      ['Nothing yet. Ask anything about this question; the agent answers here on the next send.', '在这里补充问题或意见，发送后由来源 Agent 继续处理。'],
      ['No agent is listening · sends will queue until it resumes', '来源 Agent 当前未等待，答复会保存，恢复后继续处理'],
      ['Finish this grill? Everything staged goes with it; the agent writes the design doc and stops.', '结束此请求？暂存内容会一并提交，Agent 收到后按本次任务继续。'],
      ['Every question is settled. Finish writes the design doc.', '结束问答并提交所有暂存内容。'],
      ['>Recommended</div>', '>推荐</div>'], ['"Recommended"', '"推荐"'],
    ];
    for (const [from, to] of labels) html = html.replaceAll(from, to);
    return shellHtml(html, basePath);
  };
  const wait = async (req, res, r, after, timeout) => {
    if (waiters.has(r.id)) fail(409, '此请求已有前台等待者，请使用原 handle 继续');
    const refresh = () => listenerTimes.set(r.id, Date.now()); refresh();
    const reply = () => {
      const current = store.get(r.id);
      return { ok: true, requestId: r.id, source: r.source, ...(usernameRecord(r) ? {username:r.username,accessMode:'username'} : {}), status: current.status, waitingFor: waitingFor(current), ...(current.cancellation ? {cancellation:current.cancellation} : {}), events: current.events.filter((e) => e.seq > after), cursor: after, handled: current.state.agent.handled || 0 };
    };
    let result = reply();
    if (result.events.length || ['completed', 'cancelled'].includes(result.status) || !timeout) return json(res, 200, result);
    await new Promise((resolve) => {
      let timer; let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); changes.off(r.id, change); res.off('close', finish); waiters.delete(r.id); resolve(); };
      const change = () => { result = reply(); if (result.events.length || ['completed', 'cancelled'].includes(result.status)) finish(); };
      waiters.set(r.id, finish); changes.on(r.id, change); res.on('close', finish); timer = setTimeout(finish, timeout * 1000);
    });
    refresh(); if (!res.destroyed) json(res, 200, reply());
  };

  const cancelRequest = (r, by) => {
    if (r.status === 'cancelled') return r;
    if (r.state.finished || r.status === 'completed') fail(409, '请求已结束');
    r.status = 'cancelled'; r.awaitingReply = false; r.updated = now(); r.cancellation = {by, at:r.updated};
    r.state.finished = {at:r.updated, doc:''}; store.put(r); emit(r); return r;
  };
  server = http.createServer(async (req, res) => {
    try {
      const { url: u, path: p, basePath, origin, redirect } = requestMount(req, endpoints, actualOrigin());
      if (redirect && ['GET', 'HEAD'].includes(req.method)) { res.writeHead(308, { Location: basePath + u.search, 'Cache-Control': 'no-store' }); return res.end(); }
      username(req);
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) fail(405, '不支持的方法');
      if (req.headers.origin && req.headers.origin !== origin) fail(403, '拒绝跨站请求');
      if (req.headers['sec-fetch-site'] === 'cross-site' && !['GET', 'HEAD'].includes(req.method)) fail(403, '拒绝跨站写入');
      if (req.method === 'GET' && p === '/healthz') return json(res, 200, { ok: true, service: 'handover-ui', version });
      if (req.method === 'GET' && p === '/api/capabilities') { requireUsername(req); return json(res, 200, { ok: true, service: 'handover-ui', customPage: customLimits }); }
      if (['/api/login','/api/login/ticket','/api/browser-tickets','/api/login-code','/api/pairing-tickets','/api/logout'].includes(p)) fail(410, '旧私有模式已停用；旧记录已封存，不删除或公开');
      if (req.method === 'GET' && p === '/api/me') return json(res, 200, { mode: 'username', username: requireUsername(req), authenticated: false, vapidPublicKey:vapid.publicKey, version });
      if (p === '/api/subscriptions' && req.method === 'POST') {
        const name = requireUsername(req), subscription = await body(req, 16384); let url;
        try { url = new URL(subscription.endpoint); } catch { fail(400, '无效推送地址'); }
        const host = url.hostname;
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !(host === 'fcm.googleapis.com' || host === 'fcmregistrations.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.apple.com'))) fail(400, '不支持的推送服务');
        if (!text(subscription.endpoint, 4096) || !/^[A-Za-z0-9_-]{86,88}={0,2}$/.test(subscription.keys?.p256dh || '') || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(subscription.keys?.auth || '')) fail(400, '无效推送密钥');
        const all = store.all('subscriptions'), key = hash(subscription.endpoint), previous = all[key];
        if (previous && (!equal(previous.subscription?.keys?.p256dh, subscription.keys.p256dh) || !equal(previous.subscription?.keys?.auth, subscription.keys.auth))) fail(409, '此设备订阅证明不匹配，不能替换现有绑定；请在本设备重新授权通知');
        // Persist only validated Web Push fields; never echo device endpoints or keys.
        const device = {endpoint:subscription.endpoint,keys:{p256dh:subscription.keys.p256dh,auth:subscription.keys.auth}};
        all[key] = { subscription:device, basePath, revision:crypto.randomUUID(), accessMode:'username',username:name, at: now() };
        store.save('subscriptions', all); return json(res, 200, { ok: true });
      }
      if (p === '/api/subscriptions' && req.method === 'DELETE') {
        const name = requireUsername(req), data = await body(req, 16384); const all = store.all('subscriptions'), key = hash(data.endpoint), existing = all[key];
        if (name && (!text(data.endpoint,4096) || !text(data.keys?.p256dh,128) || !text(data.keys?.auth,128))) fail(400, '解绑需要此设备完整推送订阅');
        const allowed = existing?.accessMode === 'username' && existing.username === name && equal(existing.subscription?.keys?.p256dh,data.keys.p256dh) && equal(existing.subscription?.keys?.auth,data.keys.auth);
        if (allowed) { delete all[key]; store.save('subscriptions', all); } return json(res, 200, { ok: true });
      }
      if (p === '/api/requests' && req.method === 'GET') { const name = requireUsername(req); return json(res, 200, { requests: store.list().filter(r => usernameRecord(r) && r.username === name).map(publicRequest) }); }
      if (p === '/api/requests' && req.method === 'POST') {
        const name = requireUsername(req);
        const data = await body(req, 6 * 1024 * 1024);
        if (data.username !== name || (data.accessMode !== undefined && data.accessMode !== 'username')) fail(400, '请求用户名或模式不一致');
        if (!validId(data.id) || !kinds.includes(data.kind) || !text(data.topic, 200) || !data.topic.trim() || !text(data.source?.session, 200) || !data.source.session.trim() || !text(data.source?.project || '', 2000) || !text(data.source?.machine || '', 200)) fail(400, '请求 ID、类型、标题、来源或凭据无效');
        const existing = store.get(data.id), creationHash = hash(JSON.stringify(data));
        if (existing) { if (!usernameRecord(existing) || existing.username !== name) fail(404, '请求不存在'); if (existing.creationHash !== creationHash) fail(409, '请求 ID 已存在且内容不同'); return json(res, 200, { ok: true, ...publicRequest(existing), url: `${origin}${basePath}grill/${data.id}/${name ? '?username=' + encodeURIComponent(name) : ''}` }); }
        const created = now();
        let state = { topic: data.topic, intent: data.context || '', project: data.source.project || '', created, doc: '', agent: { status: 'waiting', handled: 0, since: created }, questions: [], terms: [] };
        const questions = data.questions?.length ? data.questions : [{ id: 'q1', round: 1, title: data.topic, body: data.context || '', options: data.options || [], rec: {} }];
        if (!Array.isArray(questions) || questions.length > 100) fail(400, '问题数量应为 1–100');
        state = applyPatch(state, { questions }, created); validateState(state);
        const page = customPage(data.page);
        const r = { id: data.id, kind: data.kind, source: data.source, accessMode:'username', username:name, creationHash, created, updated: created, status: 'waiting', awaitingReply: false, userAttentionVersion: 1, state, events: [], ...(page ? { page } : {}) };
        store.put(r); notifyLater(r); return json(res, 201, { ok: true, ...publicRequest(r), url: `${origin}${basePath}grill/${r.id}/${name ? '?username=' + encodeURIComponent(name) : ''}` });
      }
      const api = p.match(/^\/api\/requests\/([A-Za-z0-9_-]{8,100})(?:\/(wait|ack|visual|cancel))?$/);
      if (api) {
        let r = store.get(api[1]); scoped(req, r); const operation = api[2];
        if (req.method === 'GET' && !operation) return json(res, 200, { ...publicRequest(r), state: r.state });
        if (req.method === 'GET' && operation === 'wait') {
          const after = u.searchParams.has('after') ? Number(u.searchParams.get('after')) : (r.state.agent.handled || 0), timeout = Number(u.searchParams.get('timeout') || 0);
          if (!Number.isInteger(after) || after < 0 || after > r.events.length || !Number.isFinite(timeout) || timeout < 0 || timeout > 30) fail(400, '无效游标或等待时长；每次最长 30 秒');
          return await wait(req, res, r, after, timeout);
        }
        if (req.method === 'PATCH' && !operation) {
          const patch = await body(req);
          r = store.get(api[1]); scoped(req, r);
          if (r.status === 'cancelled') fail(409, '请求已取消');
          if (Object.keys(patch).some((k) => !['topic', 'intent', 'doc', 'questions', 'terms', 'visual', 'agent', 'finished', 'axes', 'note'].includes(k))) fail(400, '不允许修改请求身份字段');
          if (Object.hasOwn(patch, 'agent') && (!patch.agent || typeof patch.agent !== 'object' || Array.isArray(patch.agent))) fail(400, '不能删除 Agent 状态');
          if (patch.agent && Object.hasOwn(patch.agent, 'handled')) fail(400, '请用 ack 确认已处理事件');
          const next = applyPatch(r.state, patch, now()); validateState(next); validateAxesChange(r.state, next);
          if (r.state.finished && !next.finished) fail(409, '已完成请求不能重新激活，请创建新请求');
          const added = next.questions.some((q) => !r.state.questions.some((old) => old.id === q.id));
          const reopened = Array.isArray(patch.questions) && patch.questions.some((q) => ['open', 'reopened'].includes(q.status) && r.state.questions.some((old) => old.id === q.id));
          if (added || reopened) r.userAttentionVersion = attentionVersion(r) + 1;
          r.awaitingReply = next.finished || added || reopened ? false : awaitingReply(r);
          r.state = next; r.updated = now(); r.status = next.finished ? 'completed' : (r.events.length > (next.agent.handled || 0) ? 'submitted' : 'waiting');
          store.put(r); emit(r); if (added || reopened) notifyLater(r); return json(res, 200, { ok: true, ...publicRequest(r) });
        }
        if (req.method === 'POST' && operation === 'ack') {
          const data = await body(req); r = store.get(api[1]); scoped(req, r);
          const handled = r.state.agent.handled || 0;
          if (!Number.isInteger(data.seq) || data.seq < handled || data.seq > r.events.length) fail(400, '确认序号超出范围');
          r.awaitingReply = awaitingReply(r);
          r.state.agent.handled = data.seq; r.updated = now(); r.status = r.status === 'cancelled' ? 'cancelled' : (r.state.finished ? 'completed' : (r.events.length > data.seq ? 'submitted' : 'waiting')); store.put(r); return json(res, 200, { ok: true, handled: data.seq });
        }
        if (req.method === 'POST' && operation === 'cancel') return json(res, 200, {ok:true, ...publicRequest(cancelRequest(r, 'agent'))});
        if (req.method === 'PUT' && operation === 'visual') {
          const data = await body(req); if (!text(data.html, 800000)) fail(400, '图解 HTML 过大');
          atomic(store.dir('visuals', `${r.id}.json`), { html: data.html }); return json(res, 200, { ok: true });
        }
      }
      const grill = p.match(/^\/grill\/([A-Za-z0-9_-]{8,100})\/(state|listener|send|theme|visual|content|bridge|feedback|cancel)?$/);
      if (grill) {
        let r = store.get(grill[1]); requireRequestUser(req, r);
        if (req.method === 'GET' && !grill[2]) return bytes(res, 200, r.page ? shellHtml(fs.readFileSync(path.join(ROOT, 'web/custom.html'), 'utf8').replace('__REQUEST_ID__', r.id), basePath) : page(r, basePath), 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" });
        if (req.method === 'GET' && grill[2] === 'bridge') { if (!r.page) fail(404, '此请求没有自定义页面'); return json(res, 200, { ...publicRequest(r), maxFeedbackBytes: customLimits.maxFeedbackBytes }); }
        if (req.method === 'GET' && grill[2] === 'feedback') { if (!r.page) fail(404, '此请求没有自定义页面'); return json(res, 200, {requestId:r.id, lastFeedback:savedFeedback(r), handled:r.state.agent.handled || 0}); }
        if (req.method === 'GET' && grill[2] === 'content') {
          if (!r.page) fail(404, '此请求没有自定义页面');
          return bytes(res, 200, customContent(r.page.html, fs.readFileSync(path.join(ROOT, 'web/custom-sdk.js'), 'utf8'), origin), 'text/html; charset=utf-8', { 'Content-Security-Policy': customCsp });
        }
        if (req.method === 'POST' && grill[2] === 'feedback') {
          const data = await body(req); if (!validId(data.submissionId)) fail(400, '缺少提交身份');
          r = store.get(grill[1]); requireRequestUser(req, r); validateFeedback(data, r);
          const digest = hash(JSON.stringify({ feedbackType: data.feedbackType, pageHash: data.pageHash, payload: data.payload }));
          const existing = r.events.find((e) => e.submissionId === data.submissionId);
          if (existing) { if (existing.digest !== digest) fail(409, '相同提交身份的内容不一致'); return json(res, 200, { ok: true, seq: existing.seq, saved: true, handled: (r.state.agent.handled || 0) >= existing.seq }); }
          if (r.state.finished || r.status === 'cancelled') fail(409, '请求已结束');
          const event = { type: 'feedback', requestId: r.id, sourceSession: r.source.session, ...(usernameRecord(r) ? {username:r.username} : {}), seq: r.events.length + 1, at: now(), submissionId: data.submissionId, digest, feedbackType: data.feedbackType, documentId: r.page.documentId, pageHash: r.page.pageHash, payload: data.payload };
          r.events.push(event); r.awaitingReply = true; r.updated = now(); r.status = 'submitted'; store.put(r); emit(r);
          return json(res, 200, { ok: true, seq: event.seq, saved: true, handled: false });
        }
        if (req.method === 'POST' && grill[2] === 'cancel') {
          await body(req); r = store.get(grill[1]); requireRequestUser(req, r);
          return json(res, 200, {ok:true, ...publicRequest(cancelRequest(r, 'user'))});
        }
        if (req.method === 'GET' && grill[2] === 'state') return json(res, 200, {...r.state, submissions:r.events.filter((e) => e.type === 'send' && e.seq > (r.state.agent.handled || 0)).map(({seq,at,actions}) => ({seq,at,actions})), ...(r.cancellation ? {cancellation:r.cancellation} : {})});
        if (req.method === 'GET' && grill[2] === 'listener') return json(res, 200, { listening: Date.now() - (listenerTimes.get(r.id) || 0) <= 45000, pending: r.events.length - (r.state.agent.handled || 0), handled: r.state.agent.handled || 0 });
        if (req.method === 'GET' && grill[2] === 'visual') {
          const data = store.all(`visuals/${r.id}`); if (!data.html) fail(404, '暂无图解');
          return bytes(res, 200, data.html, 'text/html; charset=utf-8', { 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'" });
        }
        if (req.method === 'POST' && grill[2] === 'theme') { const data = await body(req); if (!['system', 'light', 'dark'].includes(data.theme)) fail(400, '无效主题'); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && grill[2] === 'send') {
          const data = await body(req); if (!validId(data.submissionId)) fail(400, '缺少提交身份');
          r = store.get(grill[1]); requireRequestUser(req, r);
          const digest = hash(JSON.stringify(data.actions)), existing = r.events.find((e) => e.submissionId === data.submissionId);
          if (existing) { if (existing.digest !== digest) fail(409, '相同提交身份的内容不一致'); return json(res, 200, { ok: true, seq: existing.seq, saved: true, handled: (r.state.agent.handled || 0) >= existing.seq }); }
          if (r.state.finished || r.status === 'cancelled') fail(409, '请求已结束');
          actionsValid(data.actions, r.state);
          const event = { type: 'send', requestId: r.id, sourceSession: r.source.session, ...(usernameRecord(r) ? {username:r.username} : {}), seq: r.events.length + 1, at: now(), submissionId: data.submissionId, digest, actions: data.actions };
          r.events.push(event); if (data.actions.every((action) => action.type === 'reopen')) r.userAttentionVersion = attentionVersion(r) + 1; r.awaitingReply = !data.actions.every((action) => action.type === 'reopen'); r.updated = now(); r.status = 'submitted'; store.put(r); emit(r);
          return json(res, 200, { ok: true, seq: event.seq, saved: true, handled: false });
        }
      }
      const staticFiles = { '/custom.js': ['custom.js', 'text/javascript; charset=utf-8'], '/custom.css': ['custom.css', 'text/css'], '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/navigation.js': ['navigation.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css'], '/grill.css': ['grill.css', 'text/css'], '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'], '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'], '/icons/icon.svg': ['icons/icon.svg', 'image/svg+xml'] };
      staticFiles['/paths.js'] = ['paths.js', 'text/javascript; charset=utf-8'];
      if (['GET', 'HEAD'].includes(req.method) && Object.hasOwn(staticFiles, p)) {
        const [file, type] = staticFiles[p]; let content = req.method === 'HEAD' ? '' : fs.readFileSync(path.join(ROOT, 'web', file));
        if (req.method !== 'HEAD' && p === '/') content = shellHtml(content.toString(), basePath);
        if (req.method !== 'HEAD' && p === '/manifest.webmanifest') {
          const manifest = JSON.parse(content); for (const key of ['id', 'scope', 'start_url']) manifest[key] = basePath;
          for (const icon of manifest.icons) icon.src = basePath + icon.src.slice(1);
          content = JSON.stringify(manifest);
        }
        if (p === '/sw.js') content = content.toString().replace('__HANDOVER_BUILD__', hash(version).slice(0, 16)).replace("const BASE = '/';", `const BASE = ${JSON.stringify(basePath)};`);
        return bytes(res, 200, content, type, { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'", ...(p === '/sw.js' ? { 'Service-Worker-Allowed': basePath } : {}) });
      }
      fail(404, '未找到');
    } catch (e) {
      if (!res.headersSent && !res.destroyed) json(res, e.status || 400, { ok: false, error: e.status ? e.message : '请求格式或状态不合法' });
      if (!e.status) console.error(JSON.stringify({ event: 'request_error', code: e.code || e.name }));
    }
  });
  server.requestTimeout = 40000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.on('close', () => { for (const stop of waiters.values()) stop(); changes.removeAllListeners(); });
  return { server, store, config, notify };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, config } = createHandoverServer();
  server.listen(config.port, config.host, () => console.log(JSON.stringify({ event: 'ready', service: 'handover-ui', host: config.host, port: server.address().port })));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); setTimeout(() => process.exit(0), 5000).unref(); });
}
