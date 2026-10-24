import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createHandoverServer} from '../src/server.mjs';
const adminToken='isolated-admin-'.repeat(4),agentToken='isolated-agent-'.repeat(4);
const subscription=(name,byte=1)=>({endpoint:'https://fcm.googleapis.com/fcm/send/isolated-'+name,keys:{p256dh:Buffer.alloc(65,byte).toString('base64url'),auth:Buffer.alloc(16,byte).toString('base64url')}});
async function fixture(t,options={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handover-user-push-')),sent=[];
 const app=createHandoverServer({dataDir:dir,publicUrl:'http://127.0.0.1:0',port:0,adminToken,agentToken,disablePush:true,sendNotification:async(sub,message)=>{sent.push({sub,message:JSON.parse(message)});},...options});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const call=async(route,{name='Xpy',data,method=data?'POST':'GET',cookie,origin,key}={})=>{
  const headers={};if(name!==null)headers['X-Handover-Username']=name;if(data)headers['Content-Type']='application/json';if(cookie)headers.Cookie=cookie;if(origin)headers.Origin=origin;if(key)headers.Authorization='Bearer '+key;
  const res=await fetch(url+route,{method,headers,body:data?JSON.stringify(data):undefined});return{status:res.status,body:await res.json()};
 };
 const create=async(name='Xpy')=>{const data={id:crypto.randomUUID(),kind:'help',topic:'Isolated notice',source:{session:'isolated-source'},...(name?{username:name}:{requestToken:'request-'.repeat(6)})};assert.equal((await call('/api/requests',{name,data,key:name?undefined:agentToken})).status,201);return app.store.get(data.id);};
 const login=async()=>{const r=await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:adminToken})});return r.headers.get('set-cookie').split(';')[0];};
 return{...app,sent,call,create,login};
}
test('username opt-in binds only its devices, legacy and other usernames never receive its push',async t=>{
 const f=await fixture(t),a=subscription('x1'),b=subscription('x2',2),other=subscription('other',3),legacy=subscription('legacy',4),cookie=await f.login();
 for(const [name,sub] of [['Xpy',a],['Xpy',b],['Other',other]])assert.deepEqual(await f.call('/api/subscriptions',{name,data:sub}),{status:200,body:{ok:true}});
 assert.equal((await f.call('/api/subscriptions',{name:null,cookie,data:legacy})).status,200);
 const me=await f.call('/api/me');assert.equal(typeof me.body.vapidPublicKey,'string');assert.equal(me.body.authenticated,false);assert.equal(me.body.vapidPrivateKey,undefined);
 assert.equal((await f.call('/api/subscriptions')).status,404);
 const r=await f.create();await f.notify(r);assert.deepEqual(f.sent.map(x=>x.sub.endpoint).sort(),[a.endpoint,b.endpoint].sort());
 for(const x of f.sent){assert.equal(x.message.username,'Xpy');assert.equal(x.message.url,'/grill/'+r.id+'/?username=Xpy');}
 f.sent.length=0;await f.notify(await f.create(null));assert.deepEqual(f.sent.map(x=>x.sub.endpoint),[legacy.endpoint]);
 f.sent.length=0;await f.notify(await f.create('Other'));assert.deepEqual(f.sent.map(x=>x.sub.endpoint),[other.endpoint]);
});
test('device unsubscribe requires subscription proof and matching username; other devices and legacy preserved',async t=>{
 const f=await fixture(t),a=subscription('a'),b=subscription('b',2),cookie=await f.login();
 await f.call('/api/subscriptions',{data:a});await f.call('/api/subscriptions',{data:b});
 assert.equal((await f.call('/api/subscriptions',{method:'DELETE',data:{endpoint:a.endpoint}})).status,400);
 await f.call('/api/subscriptions',{name:'Other',method:'DELETE',data:a});
 await f.call('/api/subscriptions',{method:'DELETE',data:{...a,keys:b.keys}});
 await f.call('/api/subscriptions',{name:null,cookie,method:'DELETE',data:{endpoint:a.endpoint}});
 assert.equal(Object.keys(f.store.all('subscriptions')).length,2);
 await f.call('/api/subscriptions',{method:'DELETE',data:a});assert.equal(Object.keys(f.store.all('subscriptions')).length,1);
 await f.call('/api/subscriptions',{method:'DELETE',data:a});
 await f.notify(await f.create());assert.deepEqual(f.sent.map(x=>x.sub.endpoint),[b.endpoint]);
});
test('binding collision refuses cross-user or legacy takeover and origin restrictions stay enforced',async t=>{
 const f=await fixture(t),a=subscription('a'),cookie=await f.login();await f.call('/api/subscriptions',{data:a});
 for(const options of [{name:'Other'},{name:null,cookie}])assert.equal((await f.call('/api/subscriptions',{...options,data:a})).status,409);
 assert.equal((await f.call('/api/subscriptions',{data:{...a,keys:subscription('wrong',3).keys}})).status,409);
 assert.equal((await f.call('/api/subscriptions',{data:a,origin:'https://attacker.invalid'})).status,403);
 assert.equal((await f.call('/api/subscriptions',{method:'DELETE',data:a,origin:'https://attacker.invalid'})).status,403);
 await f.call('/api/subscriptions',{method:'DELETE',data:a});assert.equal((await f.call('/api/subscriptions',{name:'Other',data:a})).status,200);
 // A stale old-tab logout cannot erase the new binding.
 await f.call('/api/subscriptions',{method:'DELETE',data:a});assert.equal(Object.values(f.store.all('subscriptions'))[0].username,'Other');
});
test('late expired-provider response cannot delete a replacement device binding',async t=>{
 let rejectSend,started;const ready=new Promise(r=>started=r);
 const f=await fixture(t,{sendNotification:()=>new Promise((resolve,reject)=>{rejectSend=reject;started();})}),a=subscription('a');
 await f.call('/api/subscriptions',{data:a});const sending=f.notify(await f.create());await ready;
 await f.call('/api/subscriptions',{method:'DELETE',data:a});await f.call('/api/subscriptions',{name:'Other',data:a});
 rejectSend(Object.assign(new Error('gone'),{statusCode:410}));await sending;
 assert.equal(Object.values(f.store.all('subscriptions'))[0].username,'Other');
});
test('new username request automatically dispatches opted-in device notification without legacy broadcast',async t=>{
 const f=await fixture(t,{disablePush:false}),device=subscription('automatic');
 await f.call('/api/subscriptions',{data:device});const r=await f.create();await new Promise(setImmediate);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].message.requestId,r.id);assert.equal(f.sent[0].message.username,'Xpy');
});
