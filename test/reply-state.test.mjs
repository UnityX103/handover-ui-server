import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createHandoverServer} from '../src/server.mjs';
import {Store} from '../src/store.mjs';
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handover-reply-phase-'));
 const app=createHandoverServer({dataDir:dir,agentToken:undefined,adminToken:'isolated-owner-'.repeat(4),publicUrl:'http://127.0.0.1:0',port:0,disablePush:true});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const call=async(route,data,method=data?'POST':'GET')=>{const res=await fetch(origin+route,{method,headers:{'X-Handover-Username':'Xpy','X-Handover-Source':'reply-source',...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});return{status:res.status,body:await res.json()};};
 const create=async(extra={})=>{const id=crypto.randomUUID();assert.equal((await call('/api/requests',{id,kind:'help',topic:'Isolated reply phase',username:'Xpy',source:{session:'reply-source'},...extra})).status,201);return id;};
 const state=async id=>(await call('/api/requests/'+id)).body;
 const send=(id,actions=[{q:'q1',type:'answer',kind:'text',text:'Synthetic response'}],submissionId=crypto.randomUUID())=>call('/grill/'+id+'/send',{submissionId,actions});
 const patch=(id,body)=>call('/api/requests/'+id,body,'PATCH');
 return{...app,dir,call,create,state,send,patch};
}
test('successful submit stays awaiting agent through answer patch and ack until a new question arrives',async t=>{
 const f=await fixture(t),id=await f.create();assert.equal((await f.state(id)).waitingFor,'user');
 const failed=await f.send(id,[{q:'q1',type:'answer',kind:'text',text:''}]);assert.equal(failed.status,400);assert.equal((await f.state(id)).waitingFor,'user');
 const submissionId=crypto.randomUUID(),actions=[{q:'q1',type:'answer',kind:'text',text:'Synthetic response'}];
 assert.equal((await f.send(id,actions,submissionId)).status,200);assert.equal((await f.state(id)).waitingFor,'agent');
 await f.patch(id,{questions:[{id:'q1',status:'answered'}]});await f.call('/api/requests/'+id+'/ack',{seq:1});
 assert.equal((await f.state(id)).status,'waiting');assert.equal((await f.state(id)).waitingFor,'agent');
 assert.equal((await f.call('/api/requests/'+id+'/wait?timeout=0')).body.waitingFor,'agent');
 assert.equal(new Store(f.dir).get(id).awaitingReply,true);
 assert.equal((await f.patch(id,{questions:[{id:'q2',round:2,title:'Next question',rec:{}}]})).status,200);assert.equal((await f.state(id)).waitingFor,'user');
 // A network retry for the prior receipt must not move a new round back to sent.
 await f.send(id,actions,submissionId);assert.equal((await f.state(id)).waitingFor,'user');
});
test('reopen returns request to awaiting user; completion and cancellation remain terminal',async t=>{
 const f=await fixture(t),id=await f.create();await f.send(id);await f.patch(id,{questions:[{id:'q1',status:'answered'}]});
 await f.patch(id,{questions:[{id:'q1',status:'reopened'}]});assert.equal((await f.state(id)).waitingFor,'user');
 await f.send(id);assert.equal((await f.state(id)).waitingFor,'agent');
 await f.send(id,[{q:'q1',type:'reopen'}]);assert.equal((await f.state(id)).waitingFor,'user');
 await f.call('/api/requests/'+id+'/ack',{seq:3});assert.equal((await f.state(id)).waitingFor,'user');
 await f.patch(id,{finished:{doc:''}});assert.equal((await f.state(id)).waitingFor,null);assert.equal((await f.state(id)).status,'completed');
 const cancelled=await f.create();await f.send(cancelled);await f.call('/api/requests/'+cancelled+'/cancel',{});assert.equal((await f.state(cancelled)).waitingFor,null);
});
test('custom JSON feedback waiting phase persists through ack and ends only on explicit finish',async t=>{
 const f=await fixture(t),id=await f.create({page:{version:1,html:'<p>Test</p>',feedbackType:'phase-test',documentId:'synthetic'}});
 const info=(await f.call('/grill/'+id+'/bridge')).body;
 assert.equal((await f.call('/grill/'+id+'/feedback',{submissionId:crypto.randomUUID(),feedbackType:'phase-test',pageHash:info.page.pageHash,payload:{answer:'test'}})).status,200);
 await f.call('/api/requests/'+id+'/ack',{seq:1});assert.equal((await f.call('/grill/'+id+'/bridge')).body.waitingFor,'agent');
 await f.patch(id,{doc:'Agent is preparing a reply',agent:{status:'working'}});assert.equal((await f.state(id)).waitingFor,'agent');
 await f.patch(id,{finished:{doc:'Done'}});assert.equal((await f.state(id)).waitingFor,null);
});
test('legacy rows derive only known submitted state and ack persists that phase without rewriting identity',async t=>{
 const f=await fixture(t),id=await f.create();await f.send(id);let r=f.store.get(id);delete r.awaitingReply;f.store.put(r);
 assert.equal((await f.state(id)).waitingFor,'agent');await f.call('/api/requests/'+id+'/ack',{seq:1});assert.equal((await f.state(id)).waitingFor,'agent');
 r=f.store.get(id);delete r.awaitingReply;r.status='waiting';f.store.put(r);assert.equal((await f.state(id)).waitingFor,'user');
 assert.equal((await f.patch(id,{awaitingReply:false})).status,400);
 assert.equal((await f.call('/api/requests')).body.requests[0].waitingFor,'user');
});

test('attention version advances only for new user work, never for receipts or local unread clearing',async t=>{
 const f=await fixture(t),id=await f.create();assert.equal((await f.state(id)).userAttentionVersion,1);
 await f.send(id);await f.call('/api/requests/'+id+'/ack',{seq:1});await f.patch(id,{questions:[{id:'q1',status:'answered'}]});
 assert.equal((await f.state(id)).userAttentionVersion,1);
 assert.equal((await f.patch(id,{questions:[{id:'q2',round:2,title:'New work',rec:{}}]})).status,200);
 assert.equal((await f.state(id)).userAttentionVersion,2);
 await f.patch(id,{questions:[{id:'q1',status:'open'}]});assert.equal((await f.state(id)).userAttentionVersion,3);
});
