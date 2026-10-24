'use strict';
const CACHE='handover-ui-__HANDOVER_BUILD__';
const FILES=['/','/app.js','/navigation.js','/styles.css','/grill.css','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/icon.svg'];
const pendingNavigation=new Map();
let notificationQueue=Promise.resolve();
const serializeNotifications=(work)=>{const result=notificationQueue.then(work);notificationQueue=result.catch(()=>{});return result;};
const validUsername = (name) => typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name);
let volatileUsername;
async function pushUsername(value, write = false) {
  if (typeof indexedDB === 'undefined') { if(write) volatileUsername=value; return volatileUsername; }
  const db = await new Promise((resolve,reject)=>{const r=indexedDB.open('handover-push-state',1);r.onupgradeneeded=()=>r.result.createObjectStore('binding');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try { return await new Promise((resolve,reject)=>{const tx=db.transaction('binding',write?'readwrite':'readonly'),store=tx.objectStore('binding');const request=write?store.put(value,'username'):store.get('username');let result;request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(write?value:result);tx.onerror=()=>reject(tx.error);}); } finally {db.close();}
}
function requestUrl(data) {
  let url;
  try {
    url = /^[A-Za-z0-9_-]{8,100}$/.test(data?.requestId || '') ? new URL(`/grill/${data.requestId}/`,self.location.origin) : new URL(data?.url||'/',self.location.origin);
    if(url.origin!==self.location.origin || !/^\/grill\/[A-Za-z0-9_-]{8,100}\/$/.test(url.pathname)) return null;
    const name = data?.username ?? url.searchParams.get('username');
    if (name !== null && name !== undefined && !validUsername(name)) return null;
    const target=new URL(url.pathname,self.location.origin);if(name)target.searchParams.set('username',name);return target;
  } catch { return null; }
}
function rememberNavigation(client,url) {
  if(!client)return;
  for(const [id,entry] of pendingNavigation)if(entry.expires<Date.now())pendingNavigation.delete(id);
  pendingNavigation.set(client.id,{url:url.href,expires:Date.now()+60000});
  client.postMessage({type:'handover:navigate',url:url.href});
}
self.addEventListener('install',(event)=>event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',(event)=>event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key.startsWith('handover-ui-')&&key!==CACHE).map((key)=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',(event)=>{
  const url=new URL(event.request.url); if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
  // Private responses, question state and answers are never put in Cache Storage.
  if(FILES.includes(url.pathname)) event.respondWith(fetch(event.request).catch(()=>caches.match(url.pathname)));
  else if(event.request.mode==='navigate') event.respondWith(fetch(event.request).catch(()=>caches.match('/')));
});
self.addEventListener('push',(event)=>{
  let data={};try{data=event.data.json();}catch{}
  const target=requestUrl(data); if(!target)return;
  event.waitUntil(serializeNotifications(async()=>{
    const name=target.searchParams.get('username');
    const active=await pushUsername();if(name ? active!==name : active!==undefined && active!=='@legacy')return;
    await self.registration.showNotification(String(data.title||'远程交接'),{body:String(data.body||'有新的请求待你处理'),icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:String(data.tag||'handover'),data:{url:target.pathname+target.search}});
  }));
});
self.addEventListener('notificationclick',(event)=>{
  event.notification.close(); const url=requestUrl(event.notification.data);if(!url)return;
  event.waitUntil(serializeNotifications(()=>self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async(clients)=>{
    const name=url.searchParams.get('username');
    const active=await pushUsername();if(name ? active!==name : active!==undefined && active!=='@legacy')return;
    const own=clients.filter((client)=>{const current=new URL(client.url);return current.origin===self.location.origin && (name ? current.searchParams.get('username')===name : !current.searchParams.has('username'));});
    const existing=own.find((client)=>new URL(client.url).pathname===url.pathname)||own.find((client)=>client.focused)||own[0];
    if(existing){
      try { const navigated=await existing.navigate(url.href);if(navigated){rememberNavigation(navigated,url);return await navigated.focus();} } catch {}
    }
    const opened=await self.clients.openWindow(url.href);rememberNavigation(opened,url);return opened?.focus();
  })));
});
self.addEventListener('message',(event)=>{
  if(event.data?.type==='handover:push-user' && event.source) { const name=event.data.username;if(name===null||name==='@legacy'||validUsername(name))event.waitUntil(serializeNotifications(async()=>{
      await pushUsername(name,true);
      const notifications=await self.registration.getNotifications?.() || [];
      for(const notification of notifications) { const target=requestUrl(notification.data),owner=target?.searchParams.get('username'); if(name===null || (owner ? owner!==name : name!=='@legacy'))notification.close(); }
    }).then(()=>event.ports?.[0]?.postMessage({ok:true}),()=>event.ports?.[0]?.postMessage({ok:false})));return; }
  if(event.data?.type!=='handover:ready'||!event.source)return;
  const entry=pendingNavigation.get(event.source.id);
  if(entry && entry.expires>=Date.now())event.source.postMessage({type:'handover:navigate',url:entry.url});
  pendingNavigation.delete(event.source.id);
});
