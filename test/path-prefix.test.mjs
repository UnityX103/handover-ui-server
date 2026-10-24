import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHandoverServer } from '../src/server.mjs';

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-prefix-')), sent = [];
  const app = createHandoverServer({dataDir:dir,port:0,adminToken:'isolated-prefix-owner-'.repeat(3),publicUrl:'https://legacy.example:8024',publicAliases:'https://shared.example/handover/',disablePush:true,sendNotification:async(sub,message)=>sent.push({sub,message:JSON.parse(message)}),...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const call = (route, {host='shared.example',data,method=data?'POST':'GET',headers={}}={}) => new Promise((resolve,reject)=>{
    const request=http.request(origin+route,{method,headers:{Host:host,...(data?{'Content-Type':'application/json'}:{}),...headers}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
    });request.on('error',reject);request.end(data?JSON.stringify(data):undefined);
  });
  return {...app,dir,sent,origin,call};
}

test('443 路径入口隔离静态资源、PWA 与 API，8024 原入口保持可用', async t => {
  const f = await fixture(t);
  const redirect = await f.call('/handover?username=Xpy');
  assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'/handover/?username=Xpy');
  const html = await (await f.call('/handover/')).text();
  assert.match(html,/content="\/handover\/"/);
  for (const [,url] of html.matchAll(/(?:href|src)="(\/[^\"]*)"/g)) {
    assert.ok(url.startsWith('/handover/'),url);
    if (!url.includes('?')) assert.equal((await f.call(url)).status,200,url);
  }
  const manifest = await (await f.call('/handover/manifest.webmanifest')).json();
  for (const key of ['id','start_url','scope']) assert.equal(manifest[key],'/handover/');
  assert.ok(manifest.icons.every(icon=>icon.src.startsWith('/handover/icons/')));
  const sw = await f.call('/handover/sw.js');assert.equal(sw.headers.get('service-worker-allowed'),'/handover/');assert.match(await sw.text(),/const BASE = "\/handover\/";/);
  for (const route of ['/','/api/requests','/sw.js','/handover-other/','/handover-other/api/me']) assert.equal((await f.call(route)).status,404,route);
  assert.equal((await f.call('/handover/healthz',{host:'unlisted.example'})).status,403);
  assert.equal((await f.call('/handover/api/me',{headers:{Origin:'https://attacker.invalid','X-Handover-Username':'Xpy'}})).status,403);
  assert.equal((await f.call('/handover/api/me',{headers:{Origin:'https://shared.example','X-Handover-Username':'Xpy'}})).status,200);
  assert.equal((await f.call('/',{host:'legacy.example:8024'})).status,200);
  assert.equal((await f.call('/healthz',{host:new URL(f.origin).host})).status,200);
});

test('同一请求跨入口读写、取消与推送路径保持请求及设备身份', async t => {
  const f = await fixture(t), headers = {'X-Handover-Username':'Xpy','X-Handover-Source':'isolated-prefix-source'};
  const payload={id:crypto.randomUUID(),kind:'help',topic:'隔离路径测试',username:'Xpy',source:{session:'isolated-prefix-source'}};
  const created=await (await f.call('/handover/api/requests',{data:payload,headers})).json();
  assert.equal(created.url,`https://shared.example/handover/grill/${payload.id}/?username=Xpy`);
  const old = await (await f.call('/api/requests',{host:'legacy.example:8024',data:payload,headers})).json();
  assert.equal(old.url,`https://legacy.example:8024/grill/${payload.id}/?username=Xpy`);assert.equal(f.store.list().length,1);
  const page=await (await f.call(`/handover/grill/${payload.id}/?username=Xpy`)).text();
  assert.ok(page.includes(`/handover/grill/${payload.id}`));assert.match(page,/src="\/handover\/paths.js"/);
  const device=n=>({endpoint:'https://fcm.googleapis.com/fcm/send/prefix-'+n,keys:{p256dh:Buffer.alloc(65,n).toString('base64url'),auth:Buffer.alloc(16,n).toString('base64url')}});
  await f.call('/handover/api/subscriptions',{data:device(1),headers});
  await f.call('/api/subscriptions',{host:'legacy.example:8024',data:device(2),headers});
  await f.notify(f.store.get(payload.id));
  assert.deepEqual(f.sent.map(x=>x.message.url).sort(),[`/grill/${payload.id}/?username=Xpy`,`/handover/grill/${payload.id}/?username=Xpy`].sort());
  const cancelled=await (await f.call(`/handover/grill/${payload.id}/cancel?username=Xpy`,{data:{}})).json();assert.equal(cancelled.status,'cancelled');
  const received=await (await f.call(`/api/requests/${payload.id}/wait?timeout=0`,{host:'legacy.example:8024',headers})).json();assert.equal(received.status,'cancelled');assert.deepEqual(received.events,[]);
});

test('客户端接受部署子路径，创建与恢复沿用相同 URL 和 handle', async t => {
  const f=await fixture(t,{publicUrl:'http://127.0.0.1:0/handover/',publicAliases:''}), base=f.origin+'/handover';
  const env={...process.env,HANDOVER_CONFIG:path.join(f.dir,'config.json'),HANDOVER_SERVER_URL:base+'/',HANDOVER_USERNAME:'Xpy',HANDOVER_STATE_DIR:path.join(f.dir,'handles'),HANDOVER_SKIP_UPDATE:'1',HANDOVER_NO_OPEN:'1',CODEX_THREAD_ID:'isolated-prefix-cli'};
  const exec=promisify(execFile),run=async(...args)=>JSON.parse((await exec(process.execPath,['cli.mjs',...args],{env})).stdout);
  assert.equal((await run('probe')).available,true);
  assert.equal((await run('home')).url,base+'/?username=Xpy');
  const created=await run('new','--kind','help','--topic','隔离客户端路径测试','--no-open');assert.equal(created.url,base+`/grill/${created.requestId}/?username=Xpy`);
  const handle=JSON.parse(fs.readFileSync(created.handle));assert.equal(handle.serverUrl,base);
  assert.equal((await run('resume','--handle',created.handle)).url,created.url);
  assert.equal((await run('cancel','--handle',created.handle)).status,'cancelled');
  assert.equal((await run('wait','--handle',created.handle,'--timeout','0')).status,'cancelled');
});
