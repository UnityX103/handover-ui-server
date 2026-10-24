'use strict';
// Subscription ownership is browser-wide; username sessions remain per-tab.
window.HandoverPush = (() => {
  const key = 'handover:push-binding'; let pending = Promise.resolve();
  const epoch = () => localStorage.getItem('handover:push-epoch') || '0';
  const marker = () => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const active = async (username) => {
    const registration = await navigator.serviceWorker.ready; if (!registration.active) throw new Error('通知服务尚未就绪，请重试');
    await new Promise((resolve,reject)=>{ const channel=new MessageChannel(); const timer=setTimeout(()=>done(new Error('通知状态保存超时，请重试')),5000);
      const done=(error)=>{clearTimeout(timer);channel.port1.close();channel.port2.close();error?reject(error):resolve();};
      channel.port1.onmessage=(event)=>done(event.data?.ok?null:new Error('通知状态保存失败，请重试'));
      registration.active.postMessage({type:'handover:push-user',username},[channel.port2]);
    });
  };
  const locked = (work) => { if (!navigator.locks?.request) throw new Error('此浏览器缺少设备绑定协调能力，请更新浏览器后重试'); return navigator.locks.request('handover:push-binding',work); };
  const bind = (name, work) => {
    const operation = pending.then(()=>locked(work)); pending = operation.catch(()=>{}); return operation;
  };
  const remember = async (username, endpoint) => { localStorage.setItem(key,JSON.stringify({username,endpoint})); };
  const clear = async (name) => {
    await pending; if (!navigator.locks?.request && marker()?.username !== name) return; return locked(async()=>{ localStorage.setItem('handover:push-epoch',String(Number(epoch())+1)); const bound = marker(); if (!bound || bound.username !== name) return;
    const registration = await navigator.serviceWorker.ready, subscription = await registration.pushManager.getSubscription();
    if (!subscription || subscription.endpoint !== bound.endpoint) throw new Error('设备订阅状态不一致，未退出；请刷新后重试');
    const response = await fetch('/api/subscriptions',{method:'DELETE',headers:{'Content-Type':'application/json','X-Handover-Username':name},body:JSON.stringify(subscription.toJSON())});
    if (!response.ok) throw new Error('无法解除此设备通知绑定，尚未退出；请联网后重试');
    const latest = marker(); if (latest?.username === name && latest.endpoint === bound.endpoint) { await active(null); localStorage.removeItem(key); }
    });
  };
  const login = (name,work) => { const check=()=>{ if (marker()?.username && marker().username !== name) throw new Error('此浏览器通知仍绑定其他用户名，请先在原用户名退出设备绑定'); return work(); }; return navigator.locks?.request ? navigator.locks.request('handover:push-binding',check) : check(); };
  const transaction = (work) => navigator.locks?.request ? navigator.locks.request('handover:push-binding',work) : work();
  return {bind,remember,clear,marker,active,login,transaction,epoch};
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'handover:navigate') return;
    try {
      const target = new URL(event.data.url, location.origin);
      if (target.origin !== location.origin || !/^\/grill\/[A-Za-z0-9_-]{8,100}\/$/.test(target.pathname)) return;
      const username = target.searchParams.get('username');
      if (username !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(username)) return;
      const destination = target.pathname + (username === null ? '' : '?' + new URLSearchParams({username}));
      if (location.pathname + location.search !== destination) location.replace(destination);
    } catch {}
  });
  const ready = () => navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage({ type: 'handover:ready' })).catch(() => {});
  ready();
  navigator.serviceWorker.addEventListener('controllerchange', ready);
}
// This per-tab username session is a deliberate UI choice, not authentication.
if (/^\/grill\/[A-Za-z0-9_-]{8,100}\/$/.test(location.pathname)) {
  const target = new URLSearchParams(location.search).get('username');
  if (target !== null) {
    const check = () => {
      let name; try { name = sessionStorage.getItem('handover:username'); } catch {}
      if (name === target) { document.documentElement.hidden = false; return true; }
      document.documentElement.hidden = true;
      location.replace('/?' + new URLSearchParams({username:target,request:location.pathname.split('/')[2]})); return false;
    };
    window.addEventListener('pageshow',check);
    if (check()) {
      const button = document.createElement('button'); button.id = 'username-logout'; button.type = 'button'; button.textContent = '退出用户名';
      button.onclick = async () => { if (!window.confirm('退出当前用户名？未提交的编辑可能丢失；已保存的草稿会保留。')) return; button.disabled = true; try { await window.HandoverPush.clear(target); sessionStorage.removeItem('handover:username'); document.documentElement.hidden = true; location.replace('/'); } catch (error) { button.textContent = error.message; } finally { button.disabled = false; } };
      document.querySelector('header')?.append(button);
    }
  }
}
