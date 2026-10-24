'use strict';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const targetUsername = params.get('username');
const validUsername = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const storedUsername = () => { try { let value = localStorage.getItem('handover:username'); if (value === null || value === undefined) { const old = sessionStorage.getItem('handover:username'); if (validUsername(old)) { value=old;localStorage.setItem('handover:username',old); } } sessionStorage.removeItem('handover:username');return validUsername(value) ? value : null; } catch { return null; } };
const identityEpoch = () => localStorage.getItem('handover:identity-epoch') || '0';
const initialIdentityEpoch = identityEpoch();
let username = storedUsername();
const userQuery = username ? '?' + new URLSearchParams({username}) : '';
let requests = [], user = null, installPrompt = null, loading = false, generation = 0, leavingUsername = false;
const mismatch = () => username && targetUsername !== null && targetUsername !== username;
const current = (name, version) => version === generation && (storedUsername() === name && identityEpoch() === initialIdentityEpoch);
const kinds = {questionnaire:'问卷',feedback:'反馈',help:'求助'};
const waitingFor = (r) => r.waitingFor || (r.status === 'submitted' ? 'agent' : 'user');
const states = {waiting:'待回答',submitted:'已发送，等待回复',completed:'已结束',cancelled:'已取消'};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const message = (s = '') => { $('message').textContent = s; };
async function api(path, data, method = 'POST') {
  if ((!username || mismatch())) throw new Error('请先明确登录目标用户名');
  if (!['/api/me','/api/requests','/api/subscriptions'].includes(path)) throw new Error('用户名模式不提供登录或设备管理权限');
  const headers = {'X-Handover-Username':username};
  const response = await fetch(path, data === undefined ? {cache:'no-store',headers} : {method,headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || '连接失败'),{status:response.status}); return result;
}
const unreadSnapshot = () => requests.map(r=>({id:r.id,version:r.userAttentionVersion||1,updated:r.updated||r.created,waiting:!['completed','cancelled'].includes(r.status)&&waitingFor(r)==='user'}));
function render() {
  const kind = $('kind').value, status = $('status').value, search = $('search').value.trim().toLowerCase();
  const open = requests.filter((r) => !['completed','cancelled'].includes(r.status));
  $('count').textContent = open.length ? `${open.length} 个进行中的请求 · 可随时切换处理` : '当前没有待处理的请求';
  const list = requests.filter((r) => (kind === 'all' || r.kind === kind) && (status === 'all' || (status === 'waiting' || status === 'sent' ? !['completed','cancelled'].includes(r.status) && waitingFor(r) === (status === 'sent' ? 'agent' : 'user') : status === 'open' ? !['completed','cancelled'].includes(r.status) : ['completed','cancelled'].includes(r.status))) && (!search || [r.topic,r.source.session,r.source.project].join(' ').toLowerCase().includes(search)));
  $('requests').innerHTML = list.length ? list.map((r) => {
    const project = (r.source.project || '').split(/[\\/]/).filter(Boolean).pop() || '未命名项目';
    return `<a class="request" href="/grill/${encodeURIComponent(r.id)}/${esc(userQuery)}"><div class="request-head"><span class="tag">${esc(kinds[r.kind])}</span><span class="state">${esc(['completed','cancelled'].includes(r.status) ? states[r.status] : waitingFor(r)==='agent'?'已发送，等待回复':'待回答')}</span></div><h3>${esc(r.topic)}</h3><div class="meta"><span>${esc(project)}</span><span>来源 ${esc(r.source.session.slice(0,12))}</span><time datetime="${esc(r.created)}">${esc(new Date(r.created).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}))}</time></div></a>`;
  }).join('') : '<div class="empty">这里暂时没有请求。<br>Agent 发起问卷、反馈或求助后，会显示在这里。</div>';
  if (username) void window.HandoverUnread.sync(username,unreadSnapshot()).catch(()=>{});
}
async function refresh() {
  if (leavingUsername) return;
  if ((!username || mismatch())) return;
  if ((storedUsername() !== username || identityEpoch() !== initialIdentityEpoch)) { generation++; $('workspace').hidden = true; $('requests').innerHTML = ''; location.replace('/'); return; }
  if (loading) return; loading = true; const name = username, version = generation;
  try {
    const me = await api('/api/me'); if (!current(name,version)) return; user = me; $('version').textContent = user.version === 'development' ? '开发环境' : user.version.slice(0,12);
    const available = user.mode === 'username' && user.username === username;
    $('workspace').hidden = !available;
    $('settings-toggle').hidden = !available;
    $('device-state').textContent = '通知绑定到当前用户名和此浏览器。只有点击开启通知才请求系统权限。';
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
$('username-panel').hidden = !!username;
$('username-logout').hidden = !username;
$('workspace').hidden = true;
$('username-status').textContent = username ? `当前用户名：${username}（公开分类，不是身份认证）` : '';
if (mismatch()) message(`当前登录用户名为 ${username}，链接目标为 ${targetUsername}。请先退出再登录目标用户名；不会自动切换。`);
else if (!username) { $('connection').textContent = '未登录用户名'; if (targetUsername !== null) message(`此链接属于 ${targetUsername}，请主动输入该用户名登录。`); }
$('username-form').onsubmit = async (event) => {
  event.preventDefault();
  if (storedUsername()) { message('请先退出当前用户名再切换'); return; }
  const value = $('username').value;
  if (!validUsername(value)) { message('用户名需为 1–64 个英文字母、数字、下划线或连字符'); return; }
  if (targetUsername !== null && targetUsername !== value) { message(`此链接属于 ${targetUsername}，请使用匹配的用户名；或返回首页登录其他用户名。`); return; }
  const attempt = ++generation; const button = event.submitter; if (button) button.disabled = true; message('正在连接目标用户名…');
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),10000);
  try {
    await window.HandoverPush.login(value,async()=>{
    const response = await fetch('/api/me',{cache:'no-store',headers:{'X-Handover-Username':value},signal:controller.signal});
    const result = await response.json();
    if (attempt !== generation || storedUsername()) return;
    if (!response.ok || result.mode !== 'username' || result.username !== value) throw new Error('目标用户名连接失败，请重试');
    const bound = window.HandoverPush.marker();
    if (bound?.username !== value && 'serviceWorker' in navigator) await window.HandoverPush.active(null);
    if (attempt !== generation || storedUsername()) return;
    localStorage.setItem('handover:identity-epoch',String(Number(identityEpoch())+1));
    localStorage.setItem('handover:username',value);sessionStorage.removeItem('handover:username');
    await window.HandoverUnread.identity(value).catch(()=>{});
    const next = new URLSearchParams({username:value});
    const request = params.get('request'); if (request && /^[A-Za-z0-9_-]{8,100}$/.test(request)) next.set('request',request);
    location.assign('/?' + next);
    });
  } catch { if (attempt === generation) message('连接失败，尚未登录或保存用户名；请检查网络后重试。'); }
  finally { clearTimeout(timer); if (attempt === generation && button) button.disabled = false; }
};
$('username-cancel').onclick = () => { generation++; };
$('username-logout').onclick = async () => {
  const name = username; generation++; leavingUsername = true; $('username-logout').disabled = true;
  try {
    await window.HandoverPush.clear(name,initialIdentityEpoch);
    if (storedUsername() !== name || identityEpoch() !== initialIdentityEpoch) { location.replace('/'); return; }
    localStorage.setItem('handover:identity-epoch',String(Number(identityEpoch())+1));localStorage.setItem('handover:username','');sessionStorage.removeItem('handover:username');
    await window.HandoverUnread.identity(null).catch(()=>{});
    username = null; requests = []; user = null; $('settings-toggle').hidden = true; $('settings').hidden = true; $('requests').innerHTML = ''; $('workspace').hidden = true; $('username').value = ''; $('username-panel').hidden = false; $('username-logout').hidden = true; $('username-status').textContent = ''; location.replace('/');
  } catch (error) { message(error.message || '无法解除设备绑定，尚未退出，请重试'); }
  finally { leavingUsername = false; $('username-logout').disabled = false; }
};
$('refresh').onclick = () => refresh();

// Touch-only pull refresh: never capture ordinary scrolling or form gestures.
let pull = null;
const pullAllowed = () => !loading && !leavingUsername && (!!username && storedUsername() === username && !mismatch() && user?.mode === 'username');
const atTop = () => (window.scrollY ?? document.documentElement?.scrollTop ?? 0) <= 0;
const resetPull = () => { if (pull) $('connection').textContent = pull.status; pull = null; };
window.addEventListener('touchstart',(event)=>{
  resetPull();
  if (!pullAllowed() || !atTop() || event.touches.length !== 1 || event.target?.closest?.('input,textarea,select,button,a,[contenteditable="true"]')) return;
  const touch=event.touches[0];pull={x:touch.clientX,y:touch.clientY,distance:0,status:$('connection').textContent};
},{passive:true});
window.addEventListener('touchmove',(event)=>{
  if (!pull) return;
  if (!pullAllowed() || !atTop() || event.touches.length !== 1) {resetPull();return;}
  const touch=event.touches[0],dx=touch.clientX-pull.x,dy=touch.clientY-pull.y;
  if (dy<0 || Math.abs(dx)>Math.abs(dy)) {resetPull();return;}
  pull.distance=dy;
  $('connection').textContent=dy>=72?'松开刷新':dy>=12?'下拉刷新':pull.status;
},{passive:true});
window.addEventListener('touchend',()=>{
  const ready=pull && pull.distance>=72 && pullAllowed() && atTop();resetPull();if(ready)void refresh();
},{passive:true});
window.addEventListener('touchcancel',resetPull,{passive:true});

$('clear-unread').onclick = () => task($('clear-unread'),async()=>{ const name=username,version=generation; await window.HandoverUnread.clear(name,unreadSnapshot()); if(current(name,version))$('device-state').textContent='已清理当前用户名的本站未读提示；系统角标在设备支持时同步清除。请求和答复未修改。'; });
$('settings-toggle').onclick = () => { $('settings').hidden = !$('settings').hidden; $('settings-toggle').setAttribute('aria-expanded',String(!$('settings').hidden)); };
for(const id of ['kind','status','search']) $(id).addEventListener('input',render);
window.addEventListener('beforeinstallprompt',(event) => { event.preventDefault(); installPrompt=event; });
$('install').onclick = () => task($('install'),async () => {
  if(installPrompt) { await installPrompt.prompt(); await installPrompt.userChoice; installPrompt=null; }
  else $('device-state').textContent='iPhone：Safari → 分享 → 添加到主屏幕。Android：浏览器菜单 → 安装应用 / 添加到主屏幕。';
});
const keyBytes = (key) => { const raw=atob(key.replace(/-/g,'+').replace(/_/g,'/')); return Uint8Array.from(raw,(c)=>c.charCodeAt(0)); };
$('push').onclick = () => task($('push'),async () => {
  const name = username, version = generation, pushEpoch = window.HandoverPush.epoch();
  const valid = () => window.HandoverPush.epoch() === pushEpoch && (current(name,version) && username === name);
  if(!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('此浏览器尚不支持通知。iPhone 请先添加到主屏幕，再从桌面图标打开。');
  const permission=await Notification.requestPermission(); if (!valid()) return;
  if(permission!=='granted') throw new Error('通知尚未获准。你可以在浏览器或系统设置中授权后重试。');
  const operation = async () => {
    if (!valid()) return;
    const registration=await navigator.serviceWorker.ready; if (!valid()) return;
    let subscription=await registration.pushManager.getSubscription(); if (!valid()) return;
    if(!subscription) subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(user.vapidPublicKey)});
    if (!valid()) return;
    {
      const previous = window.HandoverPush.marker();
      await window.HandoverPush.remember(name,subscription.endpoint,true,previous);
    }
    try { await api('/api/subscriptions',subscription.toJSON()); } catch(error) { if (error.status) window.HandoverPush.restore(); throw error; }
    await window.HandoverPush.remember(name,subscription.endpoint);
    await window.HandoverPush.active(name);
    if (!valid()) return;
    $('push').textContent='通知已开启'; $('device-state').textContent=`此设备接收 ${name} 的新请求通知；退出时解除此设备绑定。`;
  };
  await window.HandoverPush.bind(name,operation);
});
async function init() {
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.register('/sw.js').catch(()=>null) : null;
  if (username && registration?.active && window.HandoverPush.marker()?.username !== username) {
    try { await window.HandoverPush.transaction(async()=>{if(storedUsername()===username && identityEpoch()===initialIdentityEpoch && window.HandoverPush.marker()?.username!==username)await window.HandoverPush.active(null);}); } catch {}
  }
  if (location.hash) history.replaceState(null,'',location.pathname+location.search);
  await refresh();
}
window.addEventListener('storage',(event)=>{if (['handover:username','handover:identity-epoch'].includes(event.key)) {generation++;$('workspace').hidden=true;$('requests').innerHTML='';location.replace('/');}});
window.addEventListener('pageshow',()=>{ if ((storedUsername() !== username || identityEpoch() !== initialIdentityEpoch)) { generation++; $('workspace').hidden = true; $('requests').innerHTML = ''; location.replace('/'); } });
window.addEventListener('online',refresh);
window.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
setInterval(()=>{if(!document.hidden && user?.mode === 'username')refresh();},10000);
init();
