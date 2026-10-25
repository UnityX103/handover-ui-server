import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createHandoverServer} from '../src/server.mjs';

const device=(name,byte=1)=>({endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-'+name,keys:{p256dh:Buffer.alloc(65,byte).toString('base64url'),auth:Buffer.alloc(16,byte).toString('base64url')}});
async function fixture(t,sendNotification) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handover-push-receipt-'));
 const app=createHandoverServer({dataDir:dir,publicUrl:'http://127.0.0.1:0',port:0,adminToken:'synthetic-admin-setting-'.repeat(3),disablePush:true,sendNotification});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
 const call=async(route,data,method=data?'POST':'GET',username='Xpy')=>{
  const response=await fetch('http://127.0.0.1:'+app.server.address().port+route,{method,headers:{'X-Handover-Username':username,'X-Handover-Source':'synthetic-push-source',...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
  return{status:response.status,body:await response.json()};
 };
 const create=async()=>{const id=crypto.randomUUID();assert.equal((await call('/api/requests',{id,username:'Xpy',kind:'help',topic:'Synthetic receipt test',source:{session:'synthetic-push-source'}})).status,201);return app.store.get(id);};
 const subscribe=async(name,username='Xpy',byte=1)=>{const sub=device(name,byte);assert.equal((await call('/api/subscriptions',sub,'POST',username)).status,200);return sub;};
 return{...app,call,create,subscribe};
}

test('持久区分推送接受、HTTP拒绝、订阅过期与网络未知，不保存端点/密钥/响应正文',async t=>{
 const calls=[],marker='PRIVATE_UPSTREAM_BODY_AND_HEADERS';
 const logs=[];t.mock.method(console,'info',line=>logs.push(line));t.mock.method(console,'error',line=>logs.push(line));
 const f=await fixture(t,async sub=>{
  calls.push(sub.endpoint);
  if(sub.endpoint.endsWith('-accepted'))return {statusCode:201,headers:{authorization:marker},body:marker};
  if(sub.endpoint.endsWith('-rejected'))throw Object.assign(new Error(marker),{statusCode:403,headers:{authorization:marker},body:marker});
  if(sub.endpoint.endsWith('-expired'))throw Object.assign(new Error(marker),{statusCode:410,body:marker});
  throw Object.assign(new Error(marker),{code:'ECONNRESET',body:marker});
 });
 const subscriptions=[];
 for(const name of ['accepted','rejected','expired','network'])subscriptions.push(await f.subscribe(name));
 await f.subscribe('other','Other',2);
 const r=await f.create();assert.equal(await f.notify(r),4);
 const receipt=f.store.get(r.id).webPushReceipt;
 assert.ok(receipt,'push results must survive outside the notification promise');
 assert.equal(receipt.phase,'completed');assert.equal(receipt.targeted,4);
 assert.deepEqual(receipt.counts,{accepted:1,rejected:1,expired:1,unconfirmed:1});
 assert.deepEqual(receipt.httpStatuses,{'201':1,'403':1,'410':1});assert.equal(receipt.errorCodes.ECONNRESET,1);
 const raw=JSON.stringify({receipt,logs});assert.ok(!raw.includes(marker));
 for(const sub of subscriptions){assert.ok(!raw.includes(sub.endpoint));assert.ok(!raw.includes(sub.keys.p256dh));assert.ok(!raw.includes(sub.keys.auth));}
 assert.equal(calls.length,4);assert.equal((await f.call('/api/requests/'+r.id)).body.webPushReceipt,undefined);
});

test('迟到的推送回执重新读取业务记录，保留同时到达的答案、ack与结束状态',async t=>{
 let release,started;const ready=new Promise(resolve=>{started=resolve;});
 const f=await fixture(t,()=>{started();return new Promise(resolve=>{release=resolve;});});await f.subscribe('delayed');
 const r=await f.create(),sending=f.notify(r);await ready;
 assert.equal(f.store.get(r.id).webPushReceipt.phase,'sending');
 await f.call('/grill/'+r.id+'/send',{submissionId:crypto.randomUUID(),actions:[{q:'q1',type:'answer',kind:'text',text:'Synthetic isolated answer'}]});
 await f.call('/api/requests/'+r.id+'/ack',{seq:1});
 await f.call('/api/requests/'+r.id,{finished:{doc:''}},'PATCH');
 release({statusCode:202});await sending;
 const saved=f.store.get(r.id);assert.equal(saved.status,'completed');assert.equal(saved.state.agent.handled,1);assert.equal(saved.events[0].actions[0].text,'Synthetic isolated answer');
 assert.equal(saved.webPushReceipt.counts.accepted,1);assert.equal(saved.webPushReceipt.httpStatuses['202'],1);
});

test('旧批次迟到回执不能覆盖新一轮推送的记录',async t=>{
 const pending=[];
 const f=await fixture(t,()=>new Promise(resolve=>pending.push(resolve)));await f.subscribe('rounds');
 const r=await f.create(),first=f.notify(r);await new Promise(setImmediate);
 await f.call('/api/requests/'+r.id,{questions:[{id:'q2',round:2,title:'Synthetic next round',rec:{}}]},'PATCH');
 const second=f.notify(f.store.get(r.id));await new Promise(setImmediate);
 pending[1]({statusCode:202});await second;const expected=f.store.get(r.id).webPushReceipt;
 pending[0]({statusCode:201});await first;
 assert.deepEqual(f.store.get(r.id).webPushReceipt,expected);assert.equal(expected.attentionVersion,2);assert.equal(expected.httpStatuses['202'],1);
});

test('过期订阅清理失败仍保留HTTP结果；Promise rejection不再被计为成功',async t=>{
 const f=await fixture(t,async()=>{throw Object.assign(new Error('PRIVATE_ERROR_BODY'),{statusCode:410});});await f.subscribe('expired');
 const r=await f.create(),save=f.store.save.bind(f.store);
 f.store.save=(name,value)=>{if(name==='subscriptions')throw new Error('PRIVATE_CLEANUP_ERROR');return save(name,value);};
 await f.notify(r);const receipt=f.store.get(r.id).webPushReceipt;
 assert.ok(receipt);assert.equal(receipt.counts.expired,1);assert.equal(receipt.cleanupFailures,1);assert.equal(receipt.counts.accepted,0);
 assert.ok(!JSON.stringify(receipt).includes('PRIVATE_'));
});

test('没有同名订阅与缺少明确上游状态分别记录，保持不自动重试',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return undefined;});
 await f.subscribe('other','Other');const r=await f.create();await f.notify(r);
 assert.equal(f.store.get(r.id).webPushReceipt.targeted,0);assert.equal(calls,0);
 await f.subscribe('unconfirmed');await f.notify(r);
 const receipt=f.store.get(r.id).webPushReceipt;assert.equal(receipt.counts.unconfirmed,1);assert.equal(receipt.counts.accepted,0);assert.equal(calls,1);
});

test('回执落盘失败不阻断原发送、不触发重试，日志不输出存储异常正文',async t=>{
 const logs=[];t.mock.method(console,'info',line=>logs.push(line));t.mock.method(console,'error',line=>logs.push(line));
 let calls=0;const f=await fixture(t,async()=>{calls++;return{statusCode:201};});await f.subscribe('receipt-disk-failure');
 const r=await f.create(),put=f.store.put.bind(f.store);
 f.store.put=value=>{if(value.webPushReceipt)throw new Error('PRIVATE_STORAGE_ERROR');return put(value);};
 assert.equal(await f.notify(r),1);await new Promise(setImmediate);
 assert.equal(calls,1);assert.equal(f.store.get(r.id).status,'waiting');assert.equal(f.store.get(r.id).webPushReceipt,undefined);
 assert.ok(logs.some(line=>JSON.parse(line).event==='push_receipt_storage_failed'));assert.ok(!JSON.stringify(logs).includes('PRIVATE_STORAGE_ERROR'));
});
