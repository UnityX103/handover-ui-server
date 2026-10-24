'use strict';
const CACHE='handover-ui-__HANDOVER_BUILD__';
const FILES=['/','/app.js','/navigation.js','/styles.css','/grill.css','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/icon.svg'];
const pendingNavigation=new Map();
let notificationQueue=Promise.resolve();
const serializeNotifications=(work)=>{const result=notificationQueue.then(work);notificationQueue=result.catch(()=>{});return result;};
const validUsername = (name) => typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name);
const volatileState = new Map();
async function stored(key,value,write=false) {
  if(typeof indexedDB==='undefined'){if(write)volatileState.set(key,value);return volatileState.get(key);}
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('handover-push-state',1);r.onupgradeneeded=()=>r.result.createObjectStore('binding');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction('binding',write?'readwrite':'readonly'),store=tx.objectStore('binding'),r=write?store.put(value,key):store.get(key);let result;r.onsuccess=()=>{result=r.result;};tx.oncomplete=()=>resolve(write?value:result);tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}
const pushUsername=(value,write=false)=>stored('username',value,write);
const unreadState=async name=>await stored('unread:'+name)||{seen:{},pending:{},items:{},next:1};
const attention=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):1;
const badge=async count=>{try{if(count)await self.navigator?.setAppBadge?.(count);else await self.navigator?.clearAppBadge?.();}catch{}};
function unreadCount(state){const ids=new Set();for(const [id,item]of Object.entries(state.items))if(item.waiting&&item.version>(state.seen[id]||0))ids.add(id);for(const[id,item]of Object.entries(state.pending))if(item.version>(state.seen[id]||0))ids.add(id);return ids.size;}
async function ownBadge(name,epoch){const owner=await stored('badge-owner');if(owner&&Number(owner.epoch)>Number(epoch))return false;if(owner&&Number(owner.epoch)===Number(epoch)&&owner.username!==name)return false;await stored('badge-owner',{username:name,epoch:Number(epoch)||0},true);return true;}
async function renderBadge(name,state){const owner=await stored('badge-owner');if(owner?.username===name)await badge(unreadCount(state));}
function snapshotItems(value){return Array.isArray(value)?value.filter(x=>x&&/^[A-Za-z0-9_-]{8,100}$/.test(x.id)).slice(0,10000).map(x=>({id:x.id,version:attention(x.version),waiting:x.waiting===true,updated:String(x.updated||'')})):[];}
async function unreadMessage(data){
 const name=data.username;if(!validUsername(name)&&!(data.action==='identity'&&name===null))throw new Error('invalid username');
 if(!await ownBadge(name,data.epoch))return {ok:false,stale:true};
 if(data.action==='identity'&&name===null){await badge(0);return{ok:true};}
 const state=await unreadState(name);
 for(const[id,version]of Object.entries(data.localSeen||{}))if(/^[A-Za-z0-9_-]{8,100}$/.test(id))state.seen[id]=Math.max(state.seen[id]||0,attention(version));
 for(const[id,p]of Object.entries(state.pending))if(p.version<=(state.seen[id]||0))delete state.pending[id];
 if(data.action==='sync'){const items=snapshotItems(data.items),present=new Set(items.map(x=>x.id));for(const id of Object.keys(state.items))if(!present.has(id))delete state.items[id];for(const item of items){const old=state.items[item.id];if(!old||item.version>old.version||item.version===old.version&&item.updated>=old.updated){state.items[item.id]=item;if(!item.waiting&&state.pending[item.id]?.version<=item.version)delete state.pending[item.id];}}}
 if(data.action==='snapshot'){
   const known=Object.entries(state.pending).map(([id,p])=>({id,...p}));for(const[id,item]of Object.entries(state.items))if(item.waiting&&item.version>(state.seen[id]||0))known.push({id,version:item.version});
   for(const n of await self.registration.getNotifications?.()||[]){const url=requestUrl(n.data);if(url?.searchParams.get('username')===name)known.push({id:url.pathname.split('/')[2],version:attention(n.data.userAttentionVersion),token:n.data.unreadToken});}
   await stored('unread:'+name,state,true);return{ok:true,known};
 }
 if(data.action==='clear'){
   for(const item of [...snapshotItems(data.items).filter(x=>x.waiting),...snapshotItems(data.known)])state.seen[item.id]=Math.max(state.seen[item.id]||0,item.version);
   for(const[id,p]of Object.entries(state.pending))if(p.version<=(state.seen[id]||0))delete state.pending[id];
   for(const n of await self.registration.getNotifications?.()||[]){const url=requestUrl(n.data);if(url?.searchParams.get('username')===name&&attention(n.data.userAttentionVersion)<=(state.seen[url.pathname.split('/')[2]]||0))n.close();}
 }
 for(const n of await self.registration.getNotifications?.()||[]){const url=requestUrl(n.data);if(url?.searchParams.get('username')===name&&attention(n.data.userAttentionVersion)<=(state.seen[url.pathname.split('/')[2]]||0))n.close();}
 await stored('unread:'+name,state,true);await renderBadge(name,state);return{ok:true,count:unreadCount(state)};
}
function requestUrl(data) {
  let url;
  try {
    url = /^[A-Za-z0-9_-]{8,100}$/.test(data?.requestId || '') ? new URL(`/grill/${data.requestId}/`,self.location.origin) : new URL(data?.url||'/',self.location.origin);
    if(url.origin!==self.location.origin || !/^\/grill\/[A-Za-z0-9_-]{8,100}\/$/.test(url.pathname)) return null;
    const name = data?.username ?? url.searchParams.get('username');
    if (!validUsername(name)) return null;
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
    const active=await pushUsername();if(!name||active!==name)return;
    const state=await unreadState(name),id=target.pathname.split('/')[2],version=attention(data.userAttentionVersion);
    if(version<=(state.seen[id]||0)||state.pending[id]?.version>=version||state.items[id]?.version>=version&&!state.items[id].waiting)return;
    const token=state.next++;state.pending[id]={version,token};await stored('unread:'+name,state,true);
    await self.registration.showNotification(String(data.title||'远程交接'),{body:String(data.body||'有新的请求待你处理'),icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:String(data.tag||'handover'),data:{url:target.pathname+target.search,userAttentionVersion:version,unreadToken:token}});
    const owner=await stored('badge-owner');if(!owner||owner.username===name)await badge(unreadCount(state));
  }));
});
self.addEventListener('notificationclick',(event)=>{
  event.notification.close(); const url=requestUrl(event.notification.data);if(!url)return;
  event.waitUntil(serializeNotifications(()=>self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async(clients)=>{
    const name=url.searchParams.get('username');
    const active=await pushUsername();if(!name||active!==name)return;
    const own=clients.filter((client)=>{const current=new URL(client.url);return current.origin===self.location.origin && (name ? current.searchParams.get('username')===name : !current.searchParams.has('username'));});
    const existing=own.find((client)=>new URL(client.url).pathname===url.pathname)||own.find((client)=>client.focused)||own[0];
    if(existing){
      try { const navigated=await existing.navigate(url.href);if(navigated){rememberNavigation(navigated,url);return await navigated.focus();} } catch {}
    }
    const opened=await self.clients.openWindow(url.href);rememberNavigation(opened,url);return opened?.focus();
  })));
});
self.addEventListener('message',(event)=>{
  if(event.data?.type==='handover:unread'&&event.source){event.waitUntil(serializeNotifications(()=>unreadMessage(event.data)).then(result=>event.ports?.[0]?.postMessage(result),()=>event.ports?.[0]?.postMessage({ok:false})));return;}
  if(event.data?.type==='handover:push-user' && event.source) { const name=event.data.username;if(name===null||validUsername(name))event.waitUntil(serializeNotifications(async()=>{
      await pushUsername(name,true);if(name===null)await badge(0);
      const notifications=await self.registration.getNotifications?.() || [];
      for(const notification of notifications) { const target=requestUrl(notification.data),owner=target?.searchParams.get('username'); if(name===null || owner!==name)notification.close(); }
    }).then(()=>event.ports?.[0]?.postMessage({ok:true}),()=>event.ports?.[0]?.postMessage({ok:false})));return; }
  if(event.data?.type!=='handover:ready'||!event.source)return;
  const entry=pendingNavigation.get(event.source.id);
  if(entry && entry.expires>=Date.now())event.source.postMessage({type:'handover:navigate',url:entry.url});
  pendingNavigation.delete(event.source.id);
});
