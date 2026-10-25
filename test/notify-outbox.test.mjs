import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHandoverServer} from '../src/server.mjs';
import {notificationId,notificationSettings} from '../src/notify-outbox.mjs';
import {socketRequest} from '../src/notify-socket.mjs';

const source='11111111-1111-4111-8111-111111111111';
const fields=['schema','event_id','request_id','source_session','username','title','url','kind'];
async function fixture(t, extra={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hnd-notify-')),socket=path.join(dir,'notify.sock'),calls=[],ledger=new Map();
 let handler,app,appPort=0,clock=Date.now();
 const bot=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const event=req.method==='POST'?JSON.parse(Buffer.concat(chunks).toString()):undefined;
  calls.push({method:req.method,path:req.url,event});
  if(handler){await handler(req,res,event);return;}
  const id=event?.event_id||decodeURIComponent(req.url.split('/').pop());
  if(event)ledger.set(id,event);
  const saved=ledger.get(id);res.writeHead(saved?(event?202:200):404,{'Content-Type':'application/json'});
  res.end(JSON.stringify(saved?{event_id:id,request_id:saved.request_id,state:'awaiting_approval',error:null}:{error:'not_found'}));
 });
 await new Promise(resolve=>bot.listen(socket,resolve));
 const options={dataDir:path.join(dir,'data'),publicUrl:'http://127.0.0.1:0/handover/',port:0,adminToken:'isolated-admin-setting-'.repeat(3),disablePush:true,
  notifyEnabled:true,notifySocket:socket,notifySocketUid:process.getuid(),notifySources:source,notifyUsernames:'Xpy',notifyIntervalMs:50,notificationClock:()=>clock,...extra};
 const close=async()=>{if(!app)return;await app.notifications.stop();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));};
 const start=async()=>{app=createHandoverServer(options);await new Promise(resolve=>app.server.listen(appPort,'127.0.0.1',resolve));appPort=app.server.address().port;await app.notifications.stop();};
 await start();
 t.after(async()=>{await close();bot.closeAllConnections();await new Promise(resolve=>bot.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
 const call=async(route,data,method=data?'POST':'GET',name='Xpy',session=source)=>{
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/handover/`+route,{method,headers:{Connection:'close','X-Handover-Username':name,'X-Handover-Source':session,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
  return{status:response.status,body:await response.json()};
 };
 const payload=(extra={})=>({id:crypto.randomUUID(),username:'Xpy',kind:'help',topic:'Isolated\n question',context:'PRIVATE_BODY_MUST_NOT_BE_FORWARDED',source:{session:source,project:'PRIVATE_PROJECT_MUST_NOT_BE_FORWARDED'},...extra});
 const create=async(extra={})=>{const data=payload(extra),response=await call('api/requests',data,'POST',data.username,data.source.session);assert.equal(response.status,201,JSON.stringify(response.body));return {data,...response.body};};
 const step=async()=>{clock+=100000;app.notifications.active=true;await app.notifications.drain();await app.notifications.stop();};
 return{dir,socket,bot,calls,ledger,options,get app(){return app;},call,payload,create,step,setHandler:fn=>{handler=fn;},restart:async()=>{await close();await start();}};
}

test('默认关闭；显式启用必须配置 socket UID 和精确来源/用户白名单',async t=>{
 assert.deepEqual(notificationSettings({}),{enabled:false});
 assert.throws(()=>notificationSettings({notifyEnabled:'yes'}));
 assert.throws(()=>notificationSettings({notifyEnabled:true,notifySocket:'/tmp/isolated.sock'}));
 const f=await fixture(t,{notifyEnabled:false}),r=await f.create();await f.step();
 assert.equal(f.app.store.get(r.id).notificationOutbox,undefined);assert.deepEqual(f.calls,[]);
 assert.equal(r.notification.source_session,source);assert.equal(Object.keys(r.notification).length,8);
 await f.call(`api/requests/${r.id}`,{topic:'Later metadata edit'},'PATCH');
 assert.deepEqual((await f.call(`api/requests/${r.id}`)).body.notification,r.notification);
});

test('原子持久意图与精确 descriptor：不转发正文/项目路径；回执不代表微信送达',async t=>{
 const f=await fixture(t),r=await f.create();
 const event=f.app.store.get(r.id).notificationOutbox.entries[0].event;
 assert.deepEqual(Object.keys(event),fields);assert.deepEqual(event,r.notification);
 assert.equal(event.title,'Isolated question');assert.equal(event.event_id,notificationId(r.id,1));assert.equal(event.url,r.url);
 assert.ok(!JSON.stringify(event).includes('PRIVATE_'));
 await f.step();const saved=f.app.store.get(r.id).notificationOutbox.entries[0];assert.equal(saved.state,'accepted');assert.equal(saved.receiptState,'awaiting_approval');
 await f.restart();await f.step();assert.equal(f.calls.length,1);
});

test('写入失败不投递；业务已落盘但进程未登记发送时重启恢复原意图',async t=>{
 const f=await fixture(t),data=f.payload(),put=f.app.store.put.bind(f.app.store);
 f.app.store.put=()=>{throw new Error('synthetic storage failure');};
 assert.equal((await f.call('api/requests',data)).status,400);await f.step();
 assert.equal(f.app.store.get(data.id),null);assert.equal(f.calls.length,0);
 f.app.store.put=put;
 f.app.notifications.committed=()=>{throw new Error('synthetic interruption after durable write');};
 assert.equal((await f.call('api/requests',data)).status,400);
 const before=f.app.store.get(data.id).notificationOutbox.entries[0].event;
 assert.equal(f.app.notifications.pending.size,0);
 await f.restart();await f.step();
 assert.deepEqual(f.calls[0].event,before);assert.equal((await f.call('api/requests',data)).status,200);
 await f.step();assert.equal(f.calls.length,1);
});

test('重放创建、读取/等待、同状态 patch 不重复；真正新增/重开待答题才产生新 ID',async t=>{
 const f=await fixture(t),r=await f.create();
 assert.equal((await f.call('api/requests',r.data)).status,200);
 await f.call('api/requests');await f.call(`api/requests/${r.id}/wait?timeout=0`);await f.call(`api/requests/${r.id}`);
 await f.call(`api/requests/${r.id}`,{topic:'Changed title'},'PATCH');
 const original=(await f.call(`api/requests/${r.id}`)).body.notification;assert.deepEqual(original,r.notification);
 await f.call(`api/requests/${r.id}`,{questions:[{id:'q1',status:'open'}]},'PATCH');
 const patch={questions:[{id:'q2',round:2,title:'Real next question',rec:{}}]};
 const next=await f.call(`api/requests/${r.id}`,patch,'PATCH');assert.notEqual(next.body.notification.event_id,r.notification.event_id);
 await f.call(`api/requests/${r.id}`,patch,'PATCH');
 await f.call(`api/requests/${r.id}`,{questions:[{id:'q2',status:'answered'}]},'PATCH');
 await f.call(`api/requests/${r.id}`,{questions:[{id:'q2',status:'reopened'}]},'PATCH');
 await f.call(`api/requests/${r.id}`,{questions:[{id:'q2',status:'reopened'}]},'PATCH');
 const entries=f.app.store.get(r.id).notificationOutbox.entries;assert.equal(entries.length,3);assert.equal(new Set(entries.map(e=>e.event.event_id)).size,3);
});

test('断线未知结果重启后先查原 ID，Bot unknown/已接收状态绝不再次 POST',async t=>{
 const f=await fixture(t),r=await f.create();
 f.setHandler(async(req,res,event)=>{f.ledger.set(event.event_id,event);req.socket.destroy();});
 await f.step();assert.equal(f.app.store.get(r.id).notificationOutbox.entries[0].uncertain,true);
 await f.restart();f.setHandler(async(req,res)=>{const id=decodeURIComponent(req.url.split('/').pop()),e=f.ledger.get(id);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({event_id:id,request_id:e.request_id,state:'unknown',error:null}));});
 await f.step();assert.deepEqual(f.calls.map(c=>c.method),['POST','GET']);assert.equal(f.app.store.get(r.id).notificationOutbox.entries[0].state,'accepted');
 await f.step();assert.equal(f.calls.length,2);
});

test('只有明确 404 才以完全相同 ID/载荷重投；错误回执不能确认',async t=>{
 const f=await fixture(t),r=await f.create();let attempts=0;
 f.setHandler(async(req,res,event)=>{
  if(req.method==='GET'){res.writeHead(404,{'Content-Type':'application/json'});res.end('{"error":"not_found"}');return;}
  attempts++;res.writeHead(202,{'Content-Type':'application/json'});res.end(JSON.stringify({event_id:attempts===1?'wrong-id':event.event_id,request_id:event.request_id,state:'awaiting_approval',error:null}));
 });
 await f.step();await f.step();const posts=f.calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.deepEqual(posts[0].event,posts[1].event);assert.equal(f.app.store.get(r.id).notificationOutbox.entries[0].state,'accepted');
});

test('候选来源白名单、容量与持久速率限制不代替协调批准，也不阻断业务请求',async t=>{
 const f=await fixture(t,{notifyMaxPending:1,notifyPerMinute:1});
 const other=await f.create({source:{session:crypto.randomUUID()}});assert.equal(f.app.store.get(other.id).notificationOutbox,undefined);
 const first=await f.create(),second=await f.create();assert.equal(f.app.store.get(second.id).notificationOutbox.lastSkipped.reason,'queue_full');
 f.app.notifications.active=true;await f.app.notifications.drain();await f.app.notifications.stop();assert.equal(f.calls.length,1);
 await f.restart();const third=await f.create();assert.equal(f.app.store.get(third.id).notificationOutbox.lastSkipped.reason,'rate_limited');
 assert.equal(f.app.store.get(first.id).state.agent.handled,0);
});

test('已回答/取消的未投递项停止；异步接受回执不能覆盖答案或 ack',async t=>{
 const f=await fixture(t),cancelled=await f.create();await f.call(`api/requests/${cancelled.id}/cancel`,{});await f.step();assert.equal(f.calls.length,0);
 const r=await f.create();let release,started;const ready=new Promise(resolve=>{started=resolve;});
 f.setHandler(async(req,res,event)=>{started();await new Promise(resolve=>{release=resolve;});res.writeHead(202,{'Content-Type':'application/json'});res.end(JSON.stringify({event_id:event.event_id,request_id:event.request_id,state:'awaiting_approval',error:null}));});
 const sending=f.step();await ready;
 await f.call(`grill/${r.id}/send`,{submissionId:crypto.randomUUID(),actions:[{q:'q1',type:'answer',kind:'text',text:'Synthetic human reply'}]});
 await f.call(`api/requests/${r.id}/ack`,{seq:1});release();await sending;
 const saved=f.app.store.get(r.id);assert.equal(saved.events[0].actions[0].text,'Synthetic human reply');assert.equal(saved.state.agent.handled,1);assert.equal(saved.notificationOutbox.entries[0].state,'accepted');
});

test('socket 类型/所有者、响应上限和超时受限；不会跟随 TCP 重定向',async t=>{
 const f=await fixture(t),args={socketPath:f.socket,socketUid:process.getuid(),method:'POST',payload:{synthetic:true},timeoutMs:50};
 await assert.rejects(socketRequest({...args,socketUid:process.getuid()+1}),/UNTRUSTED_SOCKET/);
 const file=path.join(f.dir,'ordinary');fs.writeFileSync(file,'synthetic');await assert.rejects(socketRequest({...args,socketPath:file}),/UNTRUSTED_SOCKET/);
 f.setHandler(async(req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({huge:'x'.repeat(5000)}));});await assert.rejects(socketRequest(args));
 f.setHandler(async()=>{});await assert.rejects(socketRequest(args),/NOTIFY_TIMEOUT/);
 f.setHandler(async(req,res)=>{res.writeHead(302,{Location:'http://127.0.0.1:1/private','Content-Type':'application/json'});res.end('{}');});assert.equal((await socketRequest(args)).status,302);
});

test('CLI new/resume/state 返回同一个精确 descriptor，不需要微信凭据',async t=>{
 const f=await fixture(t),env={...process.env,CODEX_THREAD_ID:source,CLAUDE_SESSION_ID:'',HANDOVER_SERVER_URL:`http://127.0.0.1:${f.app.server.address().port}/handover`,HANDOVER_USERNAME:'Xpy',HANDOVER_CONFIG:path.join(f.dir,'absent.json'),HANDOVER_STATE_DIR:path.join(f.dir,'handles'),HANDOVER_SKIP_UPDATE:'1',HANDOVER_NO_OPEN:'1'};
 const exec=promisify(execFile),run=async(...args)=>JSON.parse((await exec(process.execPath,['cli.mjs',...args],{env})).stdout);
 const created=await run('new','--kind','help','--topic','Synthetic\n title','--no-open');assert.equal(created.notification.title,'Synthetic title');
 assert.deepEqual((await run('resume','--handle',created.handle)).notification,created.notification);
 assert.deepEqual((await run('state','--handle',created.handle)).notification,created.notification);
});
