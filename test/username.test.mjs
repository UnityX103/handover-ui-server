import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {createHandoverServer} from '../src/server.mjs';
const adminToken='isolated-admin-'.repeat(4), agentToken='isolated-agent-'.repeat(4);
async function fixture(t,extra={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handover-username-'));
 const app=createHandoverServer({dataDir:dir,port:0,publicUrl:'http://127.0.0.1:0',agentToken:undefined,adminToken,disablePush:true,...extra});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const call=async(route,{username='Xpy',source='source-one',data,method=data?'POST':'GET',cookie,key}={})=>{
  const headers={};if(username!==null)headers['X-Handover-Username']=username;if(source)headers['X-Handover-Source']=source;if(data)headers['Content-Type']='application/json';if(cookie)headers.Cookie=cookie;if(key)headers.Authorization='Bearer '+key;
  const res=await fetch(base+route,{method,headers,body:data?JSON.stringify(data):undefined,redirect:'manual'});const raw=await res.text();let body;try{body=JSON.parse(raw);}catch{body=raw;}return {status:res.status,body,headers:res.headers};
 };
 const payload=(username='Xpy')=>({id:crypto.randomUUID(),username,kind:'help',topic:'Isolated public question',source:{session:'source-one'}});
 const create=async(p=payload())=>{assert.equal((await call('/api/requests',{username:p.username,data:p})).status,201);return p;};
 return {...app,call,payload,create};
}
test('username without global token completes question, reply, wait, ack and finish',async t=>{
 const f=await fixture(t),p=await f.create(),route='/api/requests/'+p.id;
 assert.equal((await f.call('/api/capabilities')).status,200);
 assert.equal((await f.call('/api/me')).body.authenticated,false);
 assert.equal((await f.call(route)).body.username,'Xpy');
 assert.equal((await f.call('/api/requests')).body.requests.length,1);
 const html=(await f.call('/grill/'+p.id+'/?username=Xpy')).body;
 for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(script[1].trim())new vm.Script(script[1]);
 assert.match(html,/handover:draft/);assert.match(html,/href="\/\?username=Xpy"/);
 assert.ok(html.includes('r.ok && j.ok && j.saved === true && Number.isSafeInteger(j.seq) && j.seq > 0 && handoverSessionActive()'));
 assert.ok(html.includes('handoverSubmissionReceived(j, actions, r.ok)'));
 const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(code=>code.includes('handover:username'));
 for(const selected of [null,'Other']) { const redirects=[];vm.runInNewContext(inline,{localStorage:{getItem:()=>selected,setItem(){}},sessionStorage:{getItem:()=>null,removeItem(){}},location:{replace:url=>redirects.push(url)}});assert.deepEqual(redirects,['/?request='+p.id+'&username=Xpy']); }
 const submit={submissionId:crypto.randomUUID(),actions:[{q:'q1',type:'answer',kind:'text',text:'Public reply'}]};
 assert.equal((await f.call('/grill/'+p.id+'/send',{data:submit})).body.seq,1);
 assert.equal((await f.call('/grill/'+p.id+'/send',{data:submit})).body.seq,1);
 const waited=await f.call(route+'/wait?timeout=0');assert.equal(waited.body.username,'Xpy');assert.equal(waited.body.events[0].username,'Xpy');
 assert.equal((await f.call(route,{method:'PATCH',data:{questions:[{id:'q1',status:'answered'}]}})).status,200);
 assert.equal((await f.call(route+'/ack',{data:{seq:1}})).body.handled,1);
 assert.equal((await f.call(route,{method:'PATCH',data:{finished:{doc:''}}})).body.status,'completed');
});
test('username cross-scope routes, malformed contexts and identity mutation fail closed',async t=>{
 const f=await fixture(t),p=await f.create(),q=await f.create(f.payload('Other'));
 for(const suffix of ['', '/wait?timeout=0','/ack','/cancel','/visual']){
  const method=suffix==='/visual'?'PUT':['/ack','/cancel'].includes(suffix)?'POST':'GET';
  assert.equal((await f.call('/api/requests/'+p.id+suffix,{username:'Other',method,data:method==='GET'?undefined:{seq:0,html:'x'}})).status,404);
 }
 for(const suffix of ['', 'state','listener','send','theme','visual','content','bridge','feedback'])assert.equal((await f.call('/grill/'+p.id+'/'+suffix,{username:'Other',...(['send','theme','feedback'].includes(suffix)?{data:{}}:{})})).status,404);
 assert.deepEqual((await f.call('/api/requests',{username:'Other'})).body.requests.map(r=>r.id),[q.id]);
 for(const username of ['', '../Xpy','X py','x'.repeat(65)])assert.equal((await f.call('/api/requests',{username})).status,400);
 assert.equal((await f.call('/api/requests?username=Other')).status,400);
 assert.equal((await f.call('/api/requests?username=Xpy&username=Xpy')).status,400);
 assert.equal((await f.call('/api/requests',{data:{...f.payload(),username:'Other'}})).status,400);
 for(const field of ['username','accessMode','source','tokenHash'])assert.equal((await f.call('/api/requests/'+p.id,{method:'PATCH',data:{[field]:'Other'}})).status,400);
 assert.equal((await f.call('/api/requests/'+p.id,{source:'another'})).status,403);
});
test('retired legacy records and credentials remain archived and inaccessible',async t=>{
 const f=await fixture(t,{agentToken}),old={...f.payload(),requestToken:'isolated-request-'.repeat(4)};delete old.username;
 const cookie='handover=isolated-old-cookie';
 f.store.put({id:old.id,kind:'help',source:old.source,state:{topic:'Archived secret',agent:{}},events:[],created:'2026-01-01',updated:'2026-01-01',status:'waiting',tokenHash:'old-hash'});
 const archives={sessions:{old:{expires:Date.now()+10000}},tickets:{old:{purpose:'browser'}},'login-code':{code:'Archived-Code'}};
 for(const [key,value]of Object.entries(archives))f.store.save(key,value);
 const before=JSON.stringify(f.store.get(old.id));const fresh=await f.create();
 assert.deepEqual((await f.call('/api/requests',{cookie})).body.requests.map(r=>r.id),[fresh.id]);
 assert.equal((await f.call('/api/requests',{username:null,cookie})).status,403);
 assert.equal((await f.call('/api/requests',{username:null,key:agentToken,data:old})).status,403);
 assert.equal((await f.call('/api/requests/'+old.id,{cookie})).status,404);
 assert.equal((await f.call('/grill/'+old.id+'/state',{cookie})).status,404);
 assert.equal((await f.call('/api/requests',{data:{...old,username:'Xpy'}})).status,404);
 for(const route of ['/api/browser-tickets','/api/login-code','/api/pairing-tickets','/api/logout','/api/login','/api/login/ticket'])for(const username of ['Xpy',null]){
  const res=await f.call(route,{username,cookie,key:agentToken,data:{token:adminToken,requestId:old.id}});assert.equal(res.status,410,route);assert.equal(res.headers.get('set-cookie'),null);
 }
 assert.equal((await f.call('/api/requests/'+old.id,{username:null,key:old.requestToken})).status,403);
 assert.equal(JSON.stringify(f.store.get(old.id)),before);for(const [key,value]of Object.entries(archives))assert.deepEqual(f.store.all(key),value);
});
test('custom page content and JSON feedback preserve public username scope',async t=>{
 const f=await fixture(t),p=await f.create({...f.payload(),page:{version:1,html:'<p>isolated</p>',feedbackType:'test',documentId:'test-doc'}});
 const bridge=await f.call('/grill/'+p.id+'/bridge');assert.equal(bridge.body.username,'Xpy');
 assert.equal((await f.call('/grill/'+p.id+'/content')).status,200);
 const data={submissionId:crypto.randomUUID(),feedbackType:'test',pageHash:bridge.body.page.pageHash,payload:{answer:'test'}};
 assert.equal((await f.call('/grill/'+p.id+'/feedback',{data})).status,200);
 assert.equal((await f.call('/api/requests/'+p.id+'/wait')).body.events[0].payload.answer,'test');
});
test('username creation does not notify legacy subscriptions and admin secret is still mandatory',async t=>{
 let pushes=0;
 const f=await fixture(t,{disablePush:false,sendNotification:async()=>{pushes++;}});
 f.store.save('subscriptions',{isolated:{subscription:{endpoint:'https://fcm.googleapis.com/isolated'},session:'legacy'}});
 await f.create();await new Promise(r=>setTimeout(r,20));assert.equal(pushes,0);
 assert.throws(()=>createHandoverServer({agentToken:undefined,adminToken:undefined}),/管理密钥/);
});
