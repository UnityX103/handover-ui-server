import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const origin = 'https://handover.example';
const target = origin + '/grill/request-12345678/';
function client(id, url = origin + '/') {
  return { id, url, messages: [], navigations: [], focuses: 0,
    postMessage(data) { this.messages.push(data); },
    async navigate(url) { this.navigations.push(url); this.url = url; return this; },
    async focus() { this.focuses++; return this; },
  };
}
function worker(clients = [], opened = client('opened')) {
  const events = {}, notifications = [], openings = [];
  const self = { location: { origin }, addEventListener: (name, handler) => { events[name] = handler; },
    clients: { matchAll: async () => clients, openWindow: async (url) => { openings.push(url); return opened; } },
    registration: { showNotification: async (title, options) => notifications.push({ title, options }) },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8'), { self, URL });
  const click = async (data) => {
    let done;
    events.notificationclick({ notification: { data, close() {} }, waitUntil(promise) { done = promise; } });
    await done;
  };
  return { events, notifications, openings, click };
}

test('点击通知优先打开对应问题的已有窗口', async () => {
  const home = client('home'), question = client('question', target);
  const w = worker([home, question]);
  await w.click({ url: '/grill/request-12345678/' });
  assert.deepEqual(question.navigations, [target]); assert.equal(question.focuses, 1);
  assert.equal(home.navigations.length, 0); assert.equal(w.openings.length, 0);
  assert.equal(question.messages[0].url, target);
});

test('通知冷启动后重新握手，仍能把首页引导到目标问题', async () => {
  const opened = client('standalone-started-at-home');
  const w = worker([], opened);
  await w.click({ requestId: 'request-12345678' });
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
  w.events.push({ data: { json: () => ({ requestId: 'request-12345678', title: '隔离通知', body: '仅用于测试' }) }, waitUntil(promise) { done = promise; } });
  await done;
  assert.equal(w.notifications[0].options.data.url, '/grill/request-12345678/');
});

async function activeUser(w,username) { let done;w.events.message({data:{type:'handover:push-user',username},source:{},waitUntil:p=>{done=p;}});await done; }
test('username push retains scope, suppresses stale users and opens separate user tab', async () => {
 const other=client('other',origin+'/?username=Other'),w=worker([other]);
 await activeUser(w,'Xpy');let done;
 w.events.push({data:{json:()=>({requestId:'request-12345678',username:'Xpy',title:'synthetic'})},waitUntil:p=>{done=p;}});await done;
 assert.equal(w.notifications[0].options.data.url,'/grill/request-12345678/?username=Xpy');
 await w.click(w.notifications[0].options.data);assert.deepEqual(w.openings,[target+'?username=Xpy']);assert.equal(other.navigations.length,0);
 await activeUser(w,'Other');w.events.push({data:{json:()=>({requestId:'request-12345678',username:'Xpy'})},waitUntil:p=>{done=p;}});await done;assert.equal(w.notifications.length,1);
 await activeUser(w,null);await w.click({url:'/grill/request-12345678/?username=Xpy'});assert.equal(w.openings.length,1);
});

test('public device binding suppresses queued legacy pushes and clicks', async () => {
 const w=worker();await activeUser(w,'Xpy');let done;
 w.events.push({data:{json:()=>({requestId:'request-12345678',title:'old legacy'})},waitUntil:p=>{done=p;}});await done;
 await w.click({url:'/grill/request-12345678/'});assert.equal(w.notifications.length,0);assert.equal(w.openings.length,0);
});

test('explicit logout suppresses legacy queue until explicit legacy opt-in', async () => {
 const w=worker();await activeUser(w,null);let done;
 w.events.push({data:{json:()=>({requestId:'request-12345678'})},waitUntil:p=>{done=p;}});await done;assert.equal(w.notifications.length,0);
 await activeUser(w,'@legacy');w.events.push({data:{json:()=>({requestId:'request-12345678'})},waitUntil:p=>{done=p;}});await done;assert.equal(w.notifications.length,1);
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
