'use strict';
const CACHE='handover-ui-__HANDOVER_BUILD__';
const FILES=['/','/app.js','/navigation.js','/styles.css','/grill.css','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/icon.svg'];
const pendingNavigation=new Map();
function requestUrl(data) {
  if (/^[A-Za-z0-9_-]{8,100}$/.test(data?.requestId || '')) return new URL(`/grill/${data.requestId}/`,self.location.origin);
  try { const url=new URL(data?.url||'/',self.location.origin); if(url.origin===self.location.origin && /^\/grill\/[A-Za-z0-9_-]{8,100}\/$/.test(url.pathname)) return new URL(url.pathname,self.location.origin); } catch {}
  return null;
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
  const target=requestUrl(data);
  event.waitUntil(self.registration.showNotification(String(data.title||'远程交接'),{body:String(data.body||'有新的请求待你处理'),icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:String(data.tag||'handover'),data:{url:target?.pathname||'/'}}));
});
self.addEventListener('notificationclick',(event)=>{
  event.notification.close(); const url=requestUrl(event.notification.data);if(!url)return;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async(clients)=>{
    const own=clients.filter((client)=>new URL(client.url).origin===self.location.origin);
    const existing=own.find((client)=>new URL(client.url).pathname===url.pathname)||own.find((client)=>client.focused)||own[0];
    if(existing){
      try { const navigated=await existing.navigate(url.href);if(navigated){rememberNavigation(navigated,url);return await navigated.focus();} } catch {}
    }
    const opened=await self.clients.openWindow(url.href);rememberNavigation(opened,url);return opened?.focus();
  }));
});
self.addEventListener('message',(event)=>{
  if(event.data?.type!=='handover:ready'||!event.source)return;
  const entry=pendingNavigation.get(event.source.id);
  if(entry && entry.expires>=Date.now())event.source.postMessage({type:'handover:navigate',url:entry.url});
  pendingNavigation.delete(event.source.id);
});
