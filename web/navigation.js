'use strict';
window.handoverStoredUsername = () => { try { let name=localStorage.getItem('handover:username'); if(name===null||name===undefined){const old=sessionStorage.getItem('handover:username');if(/^[A-Za-z0-9_-]{1,64}$/.test(old||'')){name=old;localStorage.setItem('handover:username',old);}}sessionStorage.removeItem('handover:username');return name;}catch{return null;} };

// Subscription ownership is browser-wide; remembered username is shared persistently across visits.
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
  const remember = async (username, endpoint, pending = false, previous = null) => { localStorage.setItem(key,JSON.stringify({username,endpoint,...(pending?{pending,previous}: {})})); };
  const restore = () => { const bound=marker(); if (!bound?.pending) return; if(bound.previous)localStorage.setItem(key,JSON.stringify(bound.previous));else localStorage.removeItem(key); };
  const clear = async (name,expectedIdentity) => {
    await pending; if (!navigator.locks?.request && marker()?.username !== name) return; return locked(async()=>{ if(expectedIdentity!==undefined && (localStorage.getItem('handover:identity-epoch')||'0')!==expectedIdentity)return; localStorage.setItem('handover:push-epoch',String(Number(epoch())+1)); const bound = marker(); if (!bound || bound.username !== name) { if(bound && localStorage.getItem('handover:username')===name && 'serviceWorker' in navigator)await active(null);return; }
    const registration = await navigator.serviceWorker.ready, subscription = await registration.pushManager.getSubscription();
    if (!subscription || subscription.endpoint !== bound.endpoint) throw new Error('设备订阅状态不一致，未退出；请刷新后重试');
    const response = await fetch(window.HandoverPaths.url('/api/subscriptions'),{method:'DELETE',headers:{'Content-Type':'application/json','X-Handover-Username':name},body:JSON.stringify(subscription.toJSON())});
    if (!response.ok) throw new Error('无法解除此设备通知绑定，尚未退出；请联网后重试');
    const latest = marker(); if (latest?.username === name && latest.endpoint === bound.endpoint) { await active(null); localStorage.removeItem(key); }
    });
  };
  const login = (name,work) => navigator.locks?.request ? navigator.locks.request('handover:push-binding',work) : work();
  const transaction = (work) => navigator.locks?.request ? navigator.locks.request('handover:push-binding',work) : work();
  return {bind,remember,clear,marker,active,login,transaction,epoch,restore};
})();

// Unread state is local UI metadata only; never mutates server requests or replies.
window.HandoverUnread = (() => {
  const epoch=()=>localStorage.getItem('handover:identity-epoch')||'0';
  const choice=()=>localStorage.getItem('handover:username')||null;
  const valid=(name,version)=>choice()===name&&epoch()===version;
  const setBadge=async count=>{try{if(count)await navigator.setAppBadge?.(count);else await navigator.clearAppBadge?.();}catch{}};
  const fallback=async data=>{
    const key='handover:unread-seen:'+data.username;let seen;try{seen=JSON.parse(localStorage.getItem(key))||{};}catch{seen={};}
    if(data.action==='identity'){if(data.username===null)await setBadge(0);return{ok:true};}
    const itemsKey='handover:unread-items:'+data.username;let items;try{items=JSON.parse(localStorage.getItem(itemsKey))||[];}catch{items=[];}
    if(data.action==='sync'){items=data.items||[];localStorage.setItem(itemsKey,JSON.stringify(items));}
    if(data.action==='snapshot')return{ok:true,known:items.filter(item=>item.waiting&&(Number(item.version)||1)>(seen[item.id]||0))};
    if(data.action==='clear'){for(const item of [...(data.items||[]).filter(x=>x.waiting),...(data.known||[])])seen[item.id]=Math.max(seen[item.id]||0,Number(item.version)||1);localStorage.setItem(key,JSON.stringify(seen));}
    const count=items.filter(item=>item.waiting&&(Number(item.version)||1)>(seen[item.id]||0)).length;
    await setBadge(count);return{ok:true,count};
  };
  const send=async data=>{
    if(!valid(data.username,String(data.epoch)))throw new Error('用户名已变更，未操作其他用户的未读提示');
    let registration=null;
    if('serviceWorker'in navigator){let timer;try{registration=await Promise.race([navigator.serviceWorker.ready,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000);})]);}finally{clearTimeout(timer);}}
    if(!valid(data.username,String(data.epoch)))throw new Error('用户名已变更');
    if(!registration?.active)return fallback(data);
    try{data.localSeen=JSON.parse(localStorage.getItem('handover:unread-seen:'+data.username))||{};}catch{data.localSeen={};}
    return new Promise((resolve,reject)=>{const channel=new MessageChannel(),timer=setTimeout(()=>done(new Error('未读状态保存超时，请重试')),5000);const done=(error,result)=>{clearTimeout(timer);channel.port1.close();channel.port2.close();error?reject(error):resolve(result);};channel.port1.onmessage=event=>done(event.data?.ok?null:new Error('未读状态未保存，请重试'),event.data);registration.active.postMessage({type:'handover:unread',...data},[channel.port2]);});
  };
  const sync=(name,items)=>send({action:'sync',username:name,epoch:epoch(),items});
  const clear=async(name,items)=>{const version=epoch();const snapshot=await send({action:'snapshot',username:name,epoch:version});const result=await send({action:'clear',username:name,epoch:version,items,known:snapshot.known});if(valid(name,version)){const key='handover:unread-seen:'+name;let seen;try{seen=JSON.parse(localStorage.getItem(key))||{};}catch{seen={};}for(const item of [...items.filter(x=>x.waiting),...(snapshot.known||[])])seen[item.id]=Math.max(seen[item.id]||0,Number(item.version)||1);localStorage.setItem(key,JSON.stringify(seen));}return result;};
  const identity=(name)=>send({action:'identity',username:name,epoch:epoch()});
  return{sync,clear,identity};
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'handover:navigate') return;
    try {
      const target = new URL(event.data.url, location.origin);
      if (target.origin !== location.origin || !/^\/grill\/[A-Za-z0-9_-]{8,100}\/$/.test(window.HandoverPaths.pathname(target.pathname))) return;
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
if (/^\/grill\/[A-Za-z0-9_-]{8,100}\/$/.test(window.HandoverPaths.pathname())) {
  const target = new URLSearchParams(location.search).get('username');
  if (target !== null) {
    const pageEpoch=localStorage.getItem('handover:identity-epoch')||'0';
    const check = () => {
      let name; try { name = window.handoverStoredUsername(); } catch {}
      if (name === target && (localStorage.getItem('handover:identity-epoch')||'0')===pageEpoch) { document.documentElement.hidden = false; return true; }
      document.documentElement.hidden = true;
      location.replace(window.HandoverPaths.url('/?') + new URLSearchParams({username:target,request:window.HandoverPaths.requestId()})); return false;
    };
    window.addEventListener('pageshow',check);window.addEventListener('storage',(event)=>{if(['handover:username','handover:identity-epoch'].includes(event.key))check();});
    if (check()) {
      const button = document.createElement('button'); button.id = 'username-logout'; button.type = 'button'; button.textContent = '退出用户名';
      button.onclick = async () => { if((localStorage.getItem('handover:identity-epoch')||'0')!==pageEpoch){location.replace(window.HandoverPaths.url('/'));return;} if (!window.confirm('退出当前用户名？未提交的编辑可能丢失；已保存的草稿会保留。')) return; button.disabled = true; try { await window.HandoverPush.clear(target,pageEpoch); if((localStorage.getItem('handover:identity-epoch')||'0')!==pageEpoch){location.replace(window.HandoverPaths.url('/'));return;} if(localStorage.getItem('handover:username')===target){localStorage.setItem('handover:identity-epoch',String(Number(localStorage.getItem('handover:identity-epoch')||0)+1));localStorage.setItem('handover:username','');}sessionStorage.removeItem('handover:username'); await window.HandoverUnread.identity(null).catch(()=>{}); document.documentElement.hidden = true; location.replace(window.HandoverPaths.url('/')); } catch (error) { button.textContent = error.message; } finally { button.disabled = false; } };
      document.querySelector('header')?.append(button);
    }
  }
}
