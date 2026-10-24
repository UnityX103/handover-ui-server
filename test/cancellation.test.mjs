import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createHandoverServer} from '../src/server.mjs';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'handover-cancel-'));
  const agentToken = 'isolated-cancel-agent-'.repeat(3), adminToken = 'isolated-cancel-owner-'.repeat(3);
  const app = createHandoverServer({dataDir:dir,port:0,publicUrl:'http://127.0.0.1:0',agentToken,adminToken,disablePush:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const call = async(route,{username='Xpy',source='isolated-cancel-source',key,cookie,data,method=data?'POST':'GET',origin}={})=>{
    const headers = {};
    if(username!==null)headers['X-Handover-Username']=username;
    if(source)headers['X-Handover-Source']=source;
    if(key)headers.Authorization='Bearer '+key;
    if(cookie)headers.Cookie=cookie;
    if(origin)headers.Origin=origin;
    if(data)headers['Content-Type']='application/json';
    const response=await fetch(base+route,{method,headers,body:data?JSON.stringify(data):undefined});
    return {status:response.status,headers:response.headers,body:await response.json()};
  };
  const create = async(extra={})=>{
    const r={id:crypto.randomUUID(),username:'Xpy',source:{session:'isolated-cancel-source'},kind:'help',topic:'Synthetic cancellation',...extra};
    const legacy=!r.username;
    assert.equal((await call('/api/requests',{username:legacy?null:r.username,key:legacy?agentToken:undefined,data:r})).status,201);
    return r;
  };
  return {...app,call,create,agentToken,adminToken};
}

test('网页取消唤醒来源等待，保持请求隔离、幂等且不制造答案',async t=>{
  const f=await fixture(t),a=await f.create(),b=await f.create();
  assert.equal((await f.call(`/api/requests/${a.id}/cancel`,{source:'another-source',data:{}})).status,403);
  assert.equal((await f.call(`/grill/${a.id}/cancel`,{username:'Other',data:{}})).status,404);
  assert.equal((await f.call(`/grill/${a.id}/cancel`,{origin:'https://other.invalid',data:{}})).status,403);
  const waiting=f.call(`/api/requests/${a.id}/wait?timeout=1`);
  const cancelled=await f.call(`/grill/${a.id}/cancel`,{data:{}});
  assert.equal(cancelled.status,200);assert.equal(cancelled.body.status,'cancelled');assert.equal(cancelled.body.cancellation.by,'user');
  const reply=(await waiting).body;
  assert.equal(reply.status,'cancelled');assert.equal(reply.cancellation.by,'user');assert.deepEqual(reply.events,[]);assert.equal(reply.handled,0);
  assert.deepEqual((await f.call(`/grill/${a.id}/cancel`,{data:{}})).body.cancellation,cancelled.body.cancellation);
  assert.equal((await f.call(`/api/requests/${b.id}`)).body.status,'waiting');
  assert.equal((await f.call(`/grill/${a.id}/send`,{data:{submissionId:crypto.randomUUID(),actions:[{q:'q1',type:'answer',kind:'text',text:'Must not be saved'}]}})).status,409);
  assert.equal(f.store.get(a.id).events.length,0);
  assert.equal((await f.call(`/grill/${a.id}/state`)).body.cancellation.by,'user');
});

test('来源 Agent 撤回保留已提交事件与消费游标，完成记录不被改成取消',async t=>{
  const f=await fixture(t),r=await f.create();
  await f.call(`/grill/${r.id}/send`,{data:{submissionId:crypto.randomUUID(),actions:[{q:'q1',type:'answer',kind:'text',text:'Existing synthetic reply'}]}});
  assert.equal((await f.call(`/api/requests/${r.id}/cancel`,{data:{}})).body.cancellation.by,'agent');
  const reply=(await f.call(`/api/requests/${r.id}/wait?timeout=0`)).body;
  assert.equal(reply.events.length,1);assert.equal(reply.events[0].actions[0].text,'Existing synthetic reply');assert.equal(reply.handled,0);
  assert.equal((await f.call(`/api/requests/${r.id}/ack`,{data:{seq:1}})).body.handled,1);
  assert.equal(f.store.get(r.id).status,'cancelled');
  const done=await f.create();
  await f.call(`/api/requests/${done.id}`,{method:'PATCH',data:{finished:{doc:''}}});
  assert.equal((await f.call(`/grill/${done.id}/cancel`,{data:{}})).status,409);
  assert.equal((await f.call(`/api/requests/${done.id}/cancel`,{data:{}})).status,409);
  assert.equal(f.store.get(done.id).status,'completed');
});

test('归档旧私有请求不可由网页或旧凭据取消，原数据保持不变',async t=>{
  const f=await fixture(t),created=await f.create();
  const archived=f.store.get(created.id);delete archived.username;delete archived.accessMode;f.store.put(archived);
  assert.equal((await f.call(`/grill/${created.id}/cancel`,{username:null,data:{}})).status,403);
  assert.equal((await f.call(`/grill/${created.id}/cancel`,{data:{}})).status,404);
  const login=await f.call('/api/login',{username:null,data:{token:f.adminToken}});
  assert.equal(login.status,410);assert.equal(login.headers.get('set-cookie'),null);
  assert.equal((await f.call(`/api/requests/${created.id}/cancel`,{username:null,key:f.agentToken,data:{}})).status,403);
  assert.deepEqual(f.store.get(created.id),archived);
});
