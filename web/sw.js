'use strict';
const CACHE='handover-ui-__HANDOVER_BUILD__';
const FILES=['/','/app.js','/styles.css','/grill.css','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/icon.svg'];
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
  let url='/';try{const target=new URL(data.url||'/',self.location.origin);if(target.origin===self.location.origin)url=target.pathname+target.search;}catch{}
  event.waitUntil(self.registration.showNotification(String(data.title||'远程交接'),{body:String(data.body||'有新的请求待你处理'),icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:String(data.tag||'handover'),data:{url}}));
});
self.addEventListener('notificationclick',(event)=>{
  event.notification.close(); const url=new URL(event.notification.data?.url||'/',self.location.origin);
  if(url.origin!==self.location.origin)return;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async(clients)=>{
    const existing=clients.find((client)=>new URL(client.url).origin===self.location.origin);
    if(existing){await existing.navigate(url.href);return existing.focus();}return self.clients.openWindow(url.href);
  }));
});
