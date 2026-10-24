'use strict';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const legacy = params.get('mode') === 'legacy';
const targetUsername = params.get('username');
const validUsername = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const storedUsername = () => { try { const value = sessionStorage.getItem('handover:username'); return validUsername(value) ? value : null; } catch { return null; } };
let username = legacy ? null : storedUsername();
const userQuery = legacy ? '' : username ? '?' + new URLSearchParams({username}) : '';
let requests = [], user = null, installPrompt = null, loading = false, generation = 0;
const mismatch = () => !legacy && username && targetUsername !== null && targetUsername !== username;
const current = (name, version) => version === generation && (legacy || storedUsername() === name);
const kinds = {questionnaire:'问卷',feedback:'反馈',help:'求助'};
const states = {waiting:'等待你回答',submitted:'答复已保存，等待 Agent 处理',completed:'已结束',cancelled:'已取消'};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const message = (s = '') => { $('message').textContent = s; };
async function api(path, data, method = 'POST') {
  if (!legacy && (!username || mismatch())) throw new Error('请先明确登录目标用户名');
  if (!legacy && !['/api/me','/api/requests'].includes(path)) throw new Error('用户名模式不提供登录或设备管理权限');
  const headers = legacy ? {} : {'X-Handover-Username':username};
  const response = await fetch(path, data === undefined ? {cache:'no-store',headers} : {method,headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '连接失败'); return result;
}
function render() {
  const kind = $('kind').value, status = $('status').value, search = $('search').value.trim().toLowerCase();
  const open = requests.filter((r) => !['completed','cancelled'].includes(r.status));
  $('count').textContent = open.length ? `${open.length} 个进行中的请求 · 可随时切换处理` : '当前没有待处理的请求';
  const list = requests.filter((r) => (kind === 'all' || r.kind === kind) && (status === 'all' || (status === 'open' ? !['completed','cancelled'].includes(r.status) : ['completed','cancelled'].includes(r.status))) && (!search || [r.topic,r.source.session,r.source.project].join(' ').toLowerCase().includes(search)));
  $('requests').innerHTML = list.length ? list.map((r) => {
    const project = (r.source.project || '').split(/[\\/]/).filter(Boolean).pop() || '未命名项目';
    return `<a class="request" href="/grill/${encodeURIComponent(r.id)}/${esc(userQuery)}"><div class="request-head"><span class="tag">${esc(kinds[r.kind])}</span><span class="state">${esc(states[r.status])}</span></div><h3>${esc(r.topic)}</h3><div class="meta"><span>${esc(project)}</span><span>来源 ${esc(r.source.session.slice(0,12))}</span><time datetime="${esc(r.created)}">${esc(new Date(r.created).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}))}</time></div></a>`;
  }).join('') : '<div class="empty">这里暂时没有请求。<br>Agent 发起问卷、反馈或求助后，会显示在这里。</div>';
  if ('setAppBadge' in navigator) { if(open.length) navigator.setAppBadge(open.length).catch(()=>{}); else navigator.clearAppBadge().catch(()=>{}); }
}
async function refresh() {
  if (!legacy && (!username || mismatch())) return;
  if (!legacy && storedUsername() !== username) { generation++; $('workspace').hidden = true; $('requests').innerHTML = ''; location.replace('/'); return; }
  if (loading) return; loading = true; const name = username, version = generation;
  try {
    const me = await api('/api/me'); if (!current(name,version)) return; user = me; $('version').textContent = user.version === 'development' ? '开发环境' : user.version.slice(0,12);
    const available = !legacy ? user.mode === 'username' && user.username === username : user.authenticated;
    $('login').hidden = !legacy || user.authenticated; $('workspace').hidden = !available;
    $('settings-toggle').hidden = !legacy; $('settings').hidden = !legacy || $('settings').hidden;
    $('username-status').textContent = username === null ? '' : `当前公开用户名：${username}（不是身份认证）`;
    if (available) {
      const list = await api('/api/requests'); if (!current(name,version)) return; requests = list.requests; render();
      const pending = new URLSearchParams(location.search).get('request');
      if (pending && /^[A-Za-z0-9_-]{8,100}$/.test(pending)) location.replace(`/grill/${pending}/${userQuery}`);
    }
    $('connection').textContent = '● 已连接'; message();
  } catch (error) { if (!current(name,version)) return; $('connection').textContent = '○ 连接中断'; message('当前无法连接服务器，已填写的内容会保留。' + (navigator.onLine ? '' : '请恢复网络后重试。')); }
  finally { loading = false; }
}
async function task(button, fn) {
  button.disabled = true; message(); try { await fn(); } catch(e) { message(e.message); } finally { button.disabled = false; }
}
$('username').value = '';
$('username-panel').hidden = legacy || !!username;
$('username-logout').hidden = legacy || !username;
$('login').hidden = !legacy;
$('workspace').hidden = true;
$('username-status').textContent = username ? `当前用户名：${username}（公开分类，不是身份认证）` : '';
if (mismatch()) message(`当前登录用户名为 ${username}，链接目标为 ${targetUsername}。请先退出再登录目标用户名；不会自动切换。`);
else if (!legacy && !username) { $('connection').textContent = '未登录用户名'; if (targetUsername !== null) message(`此链接属于 ${targetUsername}，请主动输入该用户名登录。`); }
$('username-form').onsubmit = async (event) => {
  event.preventDefault();
  if (legacy || storedUsername()) { message('请先退出当前用户名再切换'); return; }
  const value = $('username').value;
  if (!validUsername(value)) { message('用户名需为 1–64 个英文字母、数字、下划线或连字符'); return; }
  if (targetUsername !== null && targetUsername !== value) { message(`此链接属于 ${targetUsername}，请使用匹配的用户名；或返回首页登录其他用户名。`); return; }
  const attempt = ++generation; const button = event.submitter; if (button) button.disabled = true; message('正在连接目标用户名…');
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),10000);
  try {
    const response = await fetch('/api/me',{cache:'no-store',headers:{'X-Handover-Username':value},signal:controller.signal});
    const result = await response.json();
    if (attempt !== generation || storedUsername()) return;
    if (!response.ok || result.mode !== 'username' || result.username !== value) throw new Error('目标用户名连接失败，请重试');
    sessionStorage.setItem('handover:username',value);
    const next = new URLSearchParams({username:value});
    const request = params.get('request'); if (request && /^[A-Za-z0-9_-]{8,100}$/.test(request)) next.set('request',request);
    location.assign('/?' + next);
  } catch { if (attempt === generation) message('连接失败，尚未登录或保存用户名；请检查网络后重试。'); }
  finally { clearTimeout(timer); if (attempt === generation && button) button.disabled = false; }
};
$('username-cancel').onclick = () => { generation++; };
$('username-logout').onclick = () => {
  try { sessionStorage.removeItem('handover:username'); } catch { message('无法退出当前用户名，请重试'); return; }
  generation++; username = null; requests = []; user = null; $('requests').innerHTML = ''; $('workspace').hidden = true; $('username').value = ''; $('username-panel').hidden = false; $('username-logout').hidden = true; $('username-status').textContent = ''; location.replace('/');
};
$('login-form').onsubmit = (event) => { event.preventDefault(); task(event.submitter, async () => { await api('/api/login',{token:$('login-code').value.trim()}); $('login-code').value=''; await refresh(); }); };
$('refresh').onclick = () => refresh();
$('settings-toggle').onclick = () => { $('settings').hidden = !$('settings').hidden; $('settings-toggle').setAttribute('aria-expanded',String(!$('settings').hidden)); };
for(const id of ['kind','status','search']) $(id).addEventListener('input',render);
$('pair').onclick = () => task($('pair'),async () => { const r = await api('/api/login-code',{}); $('pairing').textContent = `固定登录码：${r.code}`; $('pairing').hidden = false; $('device-state').textContent='在手机打开同一网址，输入此码。长期有效，可重复使用，服务更新或重启后不变。'; });
$('logout').onclick = () => task($('logout'),async () => { await api('/api/logout',{}); $('pairing').hidden=true; requests=[]; await refresh(); });
window.addEventListener('beforeinstallprompt',(event) => { event.preventDefault(); installPrompt=event; });
$('install').onclick = () => task($('install'),async () => {
  if(installPrompt) { await installPrompt.prompt(); await installPrompt.userChoice; installPrompt=null; }
  else $('device-state').textContent='iPhone：Safari → 分享 → 添加到主屏幕。Android：浏览器菜单 → 安装应用 / 添加到主屏幕。';
});
const keyBytes = (key) => { const raw=atob(key.replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from(raw,(c)=>c.charCodeAt(0)); };
$('push').onclick = () => task($('push'),async () => {
  if(!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('此浏览器尚不支持通知。iPhone 请先添加到主屏幕，再从桌面图标打开。');
  const permission=await Notification.requestPermission();
  if(permission!=='granted') throw new Error('通知尚未获准。你可以在浏览器或系统设置中授权后重试。');
  const registration=await navigator.serviceWorker.ready;
  let subscription=await registration.pushManager.getSubscription();
  if(!subscription) subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(user.vapidPublicKey)});
  await api('/api/subscriptions',subscription.toJSON()); $('push').textContent='通知已开启'; $('device-state').textContent='已保存此设备的通知订阅。新请求会向此设备发送提醒。';
});
async function init() {
  if('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js').catch(()=>{});
  const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');
  if(ticket && legacy) {
    history.replaceState(null,'',location.pathname+location.search);
    try { const result=await api('/api/login/ticket',{ticket}); if(result.requestId) { location.replace(`/grill/${result.requestId}/`); return; } }
    catch(e) { message(e.message); $('login').hidden=false; return; }
  }
  await refresh();
}
window.addEventListener('pageshow',()=>{ if (!legacy && storedUsername() !== username) { generation++; $('workspace').hidden = true; $('requests').innerHTML = ''; location.replace('/'); } });
window.addEventListener('online',refresh);
window.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setInterval(()=>{if(!document.hidden && (user?.authenticated || user?.mode === 'username'))refresh();},10000);
init();
