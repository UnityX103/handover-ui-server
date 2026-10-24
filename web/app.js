'use strict';
const $ = (id) => document.getElementById(id);
let requests = [], user = null, installPrompt = null, loading = false;
const kinds = {questionnaire:'问卷',feedback:'反馈',help:'求助'};
const states = {waiting:'等待你回答',submitted:'答复已保存，等待 Agent 处理',completed:'已结束',cancelled:'已取消'};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const message = (s = '') => { $('message').textContent = s; };
async function api(path, data, method = 'POST') {
  const response = await fetch(path, data === undefined ? {cache:'no-store'} : {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '连接失败'); return result;
}
function render() {
  const kind = $('kind').value, status = $('status').value, search = $('search').value.trim().toLowerCase();
  const open = requests.filter((r) => !['completed','cancelled'].includes(r.status));
  $('count').textContent = open.length ? `${open.length} 个进行中的请求 · 可随时切换处理` : '当前没有待处理的请求';
  const list = requests.filter((r) => (kind === 'all' || r.kind === kind) && (status === 'all' || (status === 'open' ? !['completed','cancelled'].includes(r.status) : ['completed','cancelled'].includes(r.status))) && (!search || [r.topic,r.source.session,r.source.project].join(' ').toLowerCase().includes(search)));
  $('requests').innerHTML = list.length ? list.map((r) => {
    const project = (r.source.project || '').split(/[\\/]/).filter(Boolean).pop() || '未命名项目';
    return `<a class="request" href="/grill/${encodeURIComponent(r.id)}/"><div class="request-head"><span class="tag">${esc(kinds[r.kind])}</span><span class="state">${esc(states[r.status])}</span></div><h3>${esc(r.topic)}</h3><div class="meta"><span>${esc(project)}</span><span>来源 ${esc(r.source.session.slice(0,12))}</span><time datetime="${esc(r.created)}">${esc(new Date(r.created).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}))}</time></div></a>`;
  }).join('') : '<div class="empty">这里暂时没有请求。<br>Agent 发起问卷、反馈或求助后，会显示在这里。</div>';
  if ('setAppBadge' in navigator) { if(open.length) navigator.setAppBadge(open.length).catch(()=>{}); else navigator.clearAppBadge().catch(()=>{}); }
}
async function refresh() {
  if (loading) return; loading = true;
  try {
    user = await api('/api/me'); $('version').textContent = user.version === 'development' ? '开发环境' : user.version.slice(0,12);
    $('login').hidden = user.authenticated; $('workspace').hidden = !user.authenticated;
    if (user.authenticated) {
      requests = (await api('/api/requests')).requests; render();
      const pending = new URLSearchParams(location.search).get('request');
      if (pending && /^[A-Za-z0-9_-]{8,100}$/.test(pending)) location.replace(`/grill/${pending}/`);
    }
    $('connection').textContent = '● 已连接'; message();
  } catch (error) { $('connection').textContent = '○ 连接中断'; message('当前无法连接服务器，已填写的内容会保留。' + (navigator.onLine ? '' : '请恢复网络后重试。')); }
  finally { loading = false; }
}
async function task(button, fn) {
  button.disabled = true; message(); try { await fn(); } catch(e) { message(e.message); } finally { button.disabled = false; }
}
$('login-form').onsubmit = (event) => { event.preventDefault(); task(event.submitter, async () => { await api('/api/login',{token:$('login-code').value.trim()}); $('login-code').value=''; await refresh(); }); };
$('refresh').onclick = () => refresh();
$('settings-toggle').onclick = () => { $('settings').hidden = !$('settings').hidden; $('settings-toggle').setAttribute('aria-expanded',String(!$('settings').hidden)); };
for(const id of ['kind','status','search']) $(id).addEventListener('input',render);
$('pair').onclick = () => task($('pair'),async () => { const r = await api('/api/pairing-tickets',{}); $('pairing').textContent = `手机登录码：${r.code}`; $('pairing').hidden = false; $('device-state').textContent='在手机打开同一网址，输入此码。10 分钟有效，只能使用一次。'; });
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
  if(ticket) {
    history.replaceState(null,'',location.pathname+location.search);
    try { const result=await api('/api/login/ticket',{ticket}); if(result.requestId) { location.replace(`/grill/${result.requestId}/`); return; } }
    catch(e) { message(e.message); $('login').hidden=false; return; }
  }
  await refresh();
}
window.addEventListener('online',refresh);
window.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setInterval(()=>{if(!document.hidden && user?.authenticated)refresh();},10000);
init();
