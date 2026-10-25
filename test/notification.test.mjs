import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const origin = 'https://handover.example';
const target = origin + '/grill/request-12345678/?username=Xpy';
function client(id, url = origin + '/?username=Xpy') {
  return { id, url, messages: [], navigations: [], focuses: 0,
    postMessage(data) { this.messages.push(data); },
    async navigate(url) { this.navigations.push(url); this.url = url; return this; },
    async focus() { this.focuses++; return this; },
  };
}
function worker(clients = [], opened = client('opened'), basePath = '/') {
  const events = {}, notifications = [], openings = [];
  const self = { location: { origin }, addEventListener: (name, handler) => { events[name] = handler; },
    clients: { matchAll: async () => clients, openWindow: async (url) => { openings.push(url); return opened; } },
    registration: { showNotification: async (title, options) => notifications.push({ title, options }) },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8').replace("const BASE = '/';", `const BASE = ${JSON.stringify(basePath)};`), { self, URL });
  events.message({data:{type:'handover:push-user',username:'Xpy'},source:{},waitUntil(){}});
  const click = async (data) => {
    let done;
    events.notificationclick({ notification: { data, close() {} }, waitUntil(promise) { done = promise; } });
    await done;
  };
  return { events, notifications, openings, click };
}

test('子路径通知保留问题和用户名，不导航其他服务窗口或拦截其他路径', async () => {
  const unrelated=client('other-service',origin+'/?username=Xpy'), home=client('home',origin+'/handover/?username=Xpy');
  const w=worker([unrelated,home],client('opened'),'/handover/');
  await w.click({requestId:'request-12345678',username:'Xpy'});
  assert.deepEqual(home.navigations,[origin+'/handover/grill/request-12345678/?username=Xpy']);assert.equal(unrelated.navigations.length,0);
  await w.click({url:'/grill/request-12345678/?username=Xpy'});assert.equal(home.navigations.length,1);
  let intercepted=false;
  w.events.fetch({request:{url:origin+'/another-app/',method:'GET',mode:'navigate'},respondWith(){intercepted=true;}});assert.equal(intercepted,false);
  let done;
  w.events.push({data:{json:()=>({requestId:'request-87654321',username:'Xpy'})},waitUntil:p=>{done=p;}});await done;
  assert.equal(w.notifications[0].options.data.url,'/handover/grill/request-87654321/?username=Xpy');assert.equal(w.notifications[0].options.icon,'/handover/icons/icon-192.png');
});

test('子路径 Service Worker 更新只清理自己的公开缓存', async () => {
  const events={},deleted=[];
  const self={location:{origin},addEventListener:(name,fn)=>{events[name]=fn;},clients:{claim:async()=>{}}};
  const caches={keys:async()=>['another-service-cache','handover-ui-%2F-old','handover-ui-%2Fhandover%2F-old'],delete:async key=>deleted.push(key)};
  vm.runInNewContext(fs.readFileSync(new URL('../web/sw.js',import.meta.url),'utf8').replace("const BASE = '/';", 'const BASE = "/handover/";'),{self,caches,URL});
  let done;events.activate({waitUntil:p=>{done=p;}});await done;assert.deepEqual(deleted,['handover-ui-%2Fhandover%2F-old']);
});

test('点击通知优先打开对应问题的已有窗口', async () => {
  const home = client('home'), question = client('question', target);
  const w = worker([home, question]);
  await w.click({ url: '/grill/request-12345678/?username=Xpy' });
  assert.deepEqual(question.navigations, [target]); assert.equal(question.focuses, 1);
  assert.equal(home.navigations.length, 0); assert.equal(w.openings.length, 0);
  assert.equal(question.messages[0].url, target);
});

test('通知冷启动后重新握手，仍能把首页引导到目标问题', async () => {
  const opened = client('standalone-started-at-home');
  const w = worker([], opened);
  await w.click({ requestId: 'request-12345678', username: 'Xpy' });
  assert.deepEqual(w.openings, [target]);
  assert.equal(opened.messages[0].url, target);
  opened.messages = [];
  w.events.message({ data: { type: 'handover:ready' }, source: opened });
  assert.equal(opened.messages[0].url, target);
  w.events.message({ data: { type: 'handover:ready' }, source: opened });
  assert.equal(opened.messages.length, 1);
});

test('已有窗口导航失败时，通知仍直接新开目标问题', async () => {
  const existing = client('closed'); existing.navigate = async () => null;
  const w = worker([existing]);
  await w.click({ url: target });
  assert.deepEqual(w.openings, [target]);
});

test('通知拒绝跨站与非问题地址，推送保存明确的目标问题路径', async () => {
  const w = worker();
  await w.click({ url: 'https://other.example/grill/request-12345678/' });
  await w.click({ url: '/api/login-code' });
  assert.equal(w.openings.length, 0);
  let done;
  w.events.push({ data: { json: () => ({ requestId: 'request-12345678', username: 'Xpy', title: '隔离通知', body: '仅用于测试' }) }, waitUntil(promise) { done = promise; } });
  await done;
  assert.equal(w.notifications[0].options.data.url, '/grill/request-12345678/?username=Xpy');
});

async function activeUser(w,username) { let done;w.events.message({data:{type:'handover:push-user',username},source:{},waitUntil:p=>{done=p;}});await done; }
test('username push retains scope, suppresses stale users and opens separate user tab', async () => {
 const other=client('other',origin+'/?username=Other'),w=worker([other]);
 await activeUser(w,'Xpy');let done;
 w.events.push({data:{json:()=>({requestId:'request-12345678',username:'Xpy',title:'synthetic'})},waitUntil:p=>{done=p;}});await done;
 assert.equal(w.notifications[0].options.data.url,'/grill/request-12345678/?username=Xpy');
 await w.click(w.notifications[0].options.data);assert.deepEqual(w.openings,[target]);assert.equal(other.navigations.length,0);
 await activeUser(w,'Other');w.events.push({data:{json:()=>({requestId:'request-12345678',username:'Xpy'})},waitUntil:p=>{done=p;}});await done;assert.equal(w.notifications.length,1);
 await activeUser(w,null);await w.click({url:'/grill/request-12345678/?username=Xpy'});assert.equal(w.openings.length,1);
});

test('public device binding suppresses queued legacy pushes and clicks', async () => {
 const w=worker();await activeUser(w,'Xpy');let done;
 w.events.push({data:{json:()=>({requestId:'request-12345678',title:'old legacy'})},waitUntil:p=>{done=p;}});await done;
 await w.click({url:'/grill/request-12345678/'});assert.equal(w.notifications.length,0);assert.equal(w.openings.length,0);
});

test('removed legacy marker never enables no-username pushes', async () => {
 const w=worker();await activeUser(w,null);let done;
 w.events.push({data:{json:()=>({requestId:'request-12345678'})},waitUntil:p=>{done=p;}});await done;assert.equal(w.notifications.length,0);
 await activeUser(w,'@legacy');w.events.push({data:{json:()=>({requestId:'request-12345678'})},waitUntil:p=>{done=p;}});await done;assert.equal(w.notifications.length,0);
});

test('binding changes close already displayed notifications from old usernames', async () => {
 const events={},closed=[];
 const self={location:{origin},addEventListener:(type,fn)=>{events[type]=fn;},registration:{getNotifications:async()=>[{data:{url:'/grill/request-12345678/?username=Xpy'},close:()=>closed.push('Xpy')},{data:{url:'/grill/request-12345678/?username=Other'},close:()=>closed.push('Other')}]}};
 vm.runInNewContext(fs.readFileSync(new URL('../web/sw.js',import.meta.url),'utf8'),{self,URL});
 let done;events.message({data:{type:'handover:push-user',username:'Xpy'},source:{},waitUntil:p=>{done=p;}});await done;assert.deepEqual(closed,['Other']);
 closed.length=0;events.message({data:{type:'handover:push-user',username:null},source:{},waitUntil:p=>{done=p;}});await done;assert.deepEqual(closed,['Xpy','Other']);
});

test('logout acknowledgement waits for delayed display then closes that old notification', async () => {
 const events={},shown=[],closed=[];let display,ack=false;
 const self={location:{origin},addEventListener:(type,fn)=>{events[type]=fn;},registration:{showNotification:async(title,options)=>{await new Promise(resolve=>{display=resolve;});shown.push({data:options.data,close:()=>closed.push(title)});},getNotifications:async()=>shown}};
 vm.runInNewContext(fs.readFileSync(new URL('../web/sw.js',import.meta.url),'utf8'),{self,URL});
 let setup;events.message({data:{type:'handover:push-user',username:'Xpy'},source:{},waitUntil:p=>{setup=p;}});await setup;
 let pushed;events.push({data:{json:()=>({requestId:'request-12345678',username:'Xpy',title:'old topic'})},waitUntil:p=>{pushed=p;}});await new Promise(setImmediate);
 let logout;events.message({data:{type:'handover:push-user',username:null},source:{},ports:[{postMessage:()=>{ack=true;}}],waitUntil:p=>{logout=p;}});await new Promise(setImmediate);assert.equal(ack,false);
 display();await pushed;await logout;assert.equal(ack,true);assert.deepEqual(closed,['old topic']);
});

function unreadWorker() {
 const events={},shown=[],badges=[],network=[];
 const self={location:{origin},navigator:{setAppBadge:async n=>badges.push(n),clearAppBadge:async()=>badges.push(0)},addEventListener:(name,fn)=>{events[name]=fn;},registration:{showNotification:async(title,options)=>shown.push({title,data:options.data,closed:false,close(){this.closed=true;}}),getNotifications:async()=>shown.filter(n=>!n.closed)}};
 vm.runInNewContext(fs.readFileSync(new URL('../web/sw.js',import.meta.url),'utf8'),{self,URL,fetch:()=>{network.push('unexpected');throw new Error('No business mutations');}});
 const message=async data=>{let pending,result;events.message({source:{},data,ports:[{postMessage:value=>{result=value;}}],waitUntil:p=>{pending=p;}});await pending;return result;};
 const unread=(action,username='Xpy',extra={})=>message({type:'handover:unread',action,username,epoch:1,...extra});
 const push=async(id,version=1,username='Xpy')=>{let pending;events.push({data:{json:()=>({requestId:id,username,userAttentionVersion:version,title:'synthetic'})},waitUntil:p=>{pending=p;}});await pending;};
 return{shown,badges,network,message,unread,push};
}

test('clear unread is current-user local metadata and repeated refresh cannot recreate old badge', async () => {
 const w=unreadWorker();await w.message({type:'handover:push-user',username:'Xpy'});
 await w.unread('sync','Xpy',{items:[{id:'request-12345678',version:1,waiting:true},{id:'request-sent123',version:1,waiting:false}]});assert.equal(w.badges.at(-1),1);
 await w.push('request-12345678');w.shown.push({data:{url:'/grill/other-12345678/?username=Other',userAttentionVersion:1},closed:false,close(){this.closed=true;}});
 const snapshot=await w.unread('snapshot');await w.unread('clear','Xpy',{items:[{id:'request-12345678',version:1,waiting:true}],known:snapshot.known});assert.equal(w.badges.at(-1),0);assert.equal(w.shown[0].closed,true);assert.equal(w.shown[1].closed,false);
 await w.unread('sync','Xpy',{items:[{id:'request-12345678',version:1,waiting:true}]});assert.equal(w.badges.at(-1),0);assert.deepEqual(w.network,[]);
});

test('newer future push racing clear survives and old delayed version cannot resurrect badge', async () => {
 const w=unreadWorker();await w.message({type:'handover:push-user',username:'Xpy'});await w.unread('identity');await w.push('request-12345678',1);
 const snapshot=await w.unread('snapshot');await w.push('request-12345678',2);await w.unread('clear','Xpy',{items:[{id:'request-12345678',version:1,waiting:true}],known:snapshot.known});assert.equal(w.badges.at(-1),1);assert.equal(w.shown.at(-1).closed,false);
 const next=await w.unread('snapshot');await w.unread('clear','Xpy',{items:[],known:next.known});assert.equal(w.badges.at(-1),0);const before=w.shown.length;await w.push('request-12345678',1);assert.equal(w.shown.length,before);await w.push('request-12345678',3);assert.equal(w.badges.at(-1),1);
});

test('sent/closed and empty pending list clear badge; fallback watermarks merge on worker return', async () => {
 const w=unreadWorker();await w.message({type:'handover:push-user',username:'Xpy'});await w.unread('identity');await w.push('request-12345678',1);
 await w.unread('sync','Xpy',{items:[{id:'request-12345678',version:1,waiting:false}]});assert.equal(w.badges.at(-1),0);
 await w.unread('sync','Xpy',{items:[{id:'request-second123',version:1,waiting:true}]});assert.equal(w.badges.at(-1),1);await w.unread('sync','Xpy',{items:[]});assert.equal(w.badges.at(-1),0);
 await w.unread('sync','Xpy',{items:[{id:'request-second123',version:1,waiting:true}],localSeen:{'request-second123':1}});assert.equal(w.badges.at(-1),0);
});

test('已同步结束状态会过滤同版本迟到推送，新版本待答通知仍可显示', async () => {
 const w=unreadWorker();await w.message({type:'handover:push-user',username:'Xpy'});
 await w.unread('sync','Xpy',{items:[{id:'request-finished123',version:1,waiting:false}]});
 await w.push('request-finished123',1);assert.equal(w.shown.length,0);
 await w.push('request-finished123',2);assert.equal(w.shown.length,1);
});

test('clear includes worker-known unread items even when current page snapshot is empty', async () => {
 const w=unreadWorker();await w.unread('sync','Xpy',{items:[{id:'request-12345678',version:4,waiting:true}]});assert.equal(w.badges.at(-1),1);
 const snapshot=await w.unread('snapshot');await w.unread('clear','Xpy',{items:[],known:snapshot.known});assert.equal(w.badges.at(-1),0);
 await w.unread('sync','Xpy',{items:[{id:'request-12345678',version:4,waiting:true}]});assert.equal(w.badges.at(-1),0);assert.deepEqual(w.network,[]);
});

test('identity-only worker restore merges offline clear watermark before displaying badge', async () => {
 const w=unreadWorker();await w.unread('sync','Xpy',{items:[{id:'request-12345678',version:2,waiting:true}]});assert.equal(w.badges.at(-1),1);
 await w.unread('identity','Xpy',{localSeen:{'request-12345678':2}});assert.equal(w.badges.at(-1),0);
 await w.unread('identity');assert.equal(w.badges.at(-1),0);
});
