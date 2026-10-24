import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { createHandoverServer } from '../src/server.mjs';

const exec = promisify(execFile), agentToken = 'test-agent-'.repeat(6), adminToken = 'test-owner-'.repeat(6);

test('通过 current 版本软链接启动时，服务与 Skill 客户端仍执行入口',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handover-symlink-'));
  fs.symlinkSync(fs.realpathSync(new URL('..',import.meta.url)),path.join(dir,'current'),'dir');
  const env={...process.env,HANDOVER_HOST:'127.0.0.1',HANDOVER_PORT:'0',HANDOVER_PUBLIC_URL:'http://127.0.0.1:0',HANDOVER_AGENT_TOKEN:agentToken,HANDOVER_ADMIN_TOKEN:adminToken,HANDOVER_DATA_DIR:path.join(dir,'data')};
  const child=spawn(process.execPath,[path.join(dir,'current/src/server.mjs')],{env,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){await new Promise((resolve)=>{child.once('exit',resolve);child.kill();});}fs.rmSync(dir,{recursive:true,force:true});});
  const ready=await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('软链接入口未启动')),5000);
    child.once('error',(error)=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code)=>{clearTimeout(timer);reject(new Error('提前退出 '+code));});
    child.stdout.on('data',(chunk)=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]));}});
  });
  const response=await fetch(`http://127.0.0.1:${ready.port}/healthz`);assert.equal((await response.json()).ok,true);
  const cli=await exec(process.execPath,[path.join(dir,'current/skills/grill-with-ui/scripts/handover.mjs'),'help'],{env});
  assert.match(cli.stdout,/new/);
});
async function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-test-'));
  const config = { dataDir: dir, agentToken, adminToken, port: 0, publicUrl: 'http://127.0.0.1:0', disablePush: true, ...extra };
  const app = createHandoverServer(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = async (route, { data, method = data ? 'POST' : 'GET', key, source, cookie, origin, username = (key || cookie) ? 'Xpy' : undefined } = {}) => {
    const headers = {}; if(username) headers['X-Handover-Username']=username; if (data) headers['Content-Type'] = 'application/json'; if (key) headers.Authorization = `Bearer ${key}`; if(source)headers['X-Handover-Source']=source;if(cookie)headers.Cookie=cookie;if(origin)headers.Origin=origin;
    const response = await fetch(url + route, { method, headers, body: data ? JSON.stringify(data) : undefined, redirect: 'manual' });
    const raw = await response.text(); let body; try { body = JSON.parse(raw); } catch { body = raw; }
    return { status: response.status, headers: response.headers, body };
  };
  const payload = (session = 'test-source-one') => ({ username: 'Xpy', id: crypto.randomUUID(), requestToken: crypto.randomBytes(32).toString('base64url'), kind: 'questionnaire', topic: '测试隔离用问卷', source: { session, project: '/test/project', machine: 'isolated-fixture' }, questions: [{ id: 'q1', round: 1, title: '测试选项', options: [{k:'A',text:'测试甲'},{k:'B',text:'测试乙'}], rec:{option:'A',why:'仅为隔离测试数据'} }] });
  const create = async (p = payload()) => { const result = await call('/api/requests', {key:agentToken,data:p}); assert.equal(result.status,201); return p; };
  const login = async () => 'username-test-session';
  const scoped = (r, route = '', options = {}) => call(`/api/requests/${r.id}${route}`, {key:r.requestToken,source:r.source.session,...options});
  const send = (r, cookie, id = crypto.randomUUID(), actions = [{q:'q1',type:'answer',kind:'option',option:'B'}]) => call(`/grill/${r.id}/send`,{cookie,data:{submissionId:id,actions}});
  return {...app,dir,url,call,payload,create,login,scoped,send};
}

test('用户名分类：无用户名不可读问卷，跨用户名及错误来源不能读写请求', async (t) => {
  const f=await fixture(t),r=await f.create();
  assert.equal((await f.call('/api/requests')).status,403);
  assert.equal((await f.call(`/grill/${r.id}/state`)).status,403);
  assert.equal((await f.call(`/api/requests/${r.id}`,{key:agentToken,source:r.source.session,username:'Other'})).status,404);
  assert.equal((await f.scoped(r,'',{source:'other-source'})).status,403);
  assert.equal((await f.call('/api/requests',{key:agentToken,data:f.payload(),origin:'https://attacker.invalid'})).status,403);
  const result=await f.scoped(r);assert.equal(result.body.source.session,r.source.session);assert.equal(result.body.tokenHash,undefined);
});

test('创建与提交幂等：同一创建不会重复请求，同一提交只产生一个事件',async(t)=>{
  const f=await fixture(t),r=await f.create(),cookie=await f.login();
  assert.equal((await f.call('/api/requests',{key:agentToken,data:r})).status,200);
  assert.equal((await f.call('/api/requests',{key:agentToken,data:{...r,topic:'改动'}})).status,409);
  const id=crypto.randomUUID(),one=await f.send(r,cookie,id),two=await f.send(r,cookie,id);
  assert.equal(one.body.seq,1);assert.equal(two.body.seq,1);
  assert.equal((await f.send(r,cookie,id,[{q:'q1',type:'answer',kind:'option',option:'A'}])).status,409);
  assert.equal((await f.scoped(r,'/wait?timeout=0')).body.events.length,1);
  assert.equal(f.store.list().length,1);
});

test('多个来源并行等待：答复只唤醒所属请求，读取不自动消费',async(t)=>{
  const f=await fixture(t),a=await f.create(),b=await f.create(f.payload('test-source-two')),cookie=await f.login();
  const waitingA=f.scoped(a,'/wait?timeout=1'),waitingB=f.scoped(b,'/wait?timeout=0.15');
  assert.equal((await f.scoped(b,'',{key:a.requestToken,source:a.source.session})).status,403);
  await f.send(a,cookie);
  const [ra,rb]=await Promise.all([waitingA,waitingB]);
  assert.equal(ra.body.requestId,a.id);assert.equal(ra.body.events[0].sourceSession,a.source.session);assert.equal(ra.body.events[0].actions[0].option,'B');
  assert.deepEqual(rb.body.events,[]);
  assert.equal((await f.scoped(a,'/wait?timeout=0')).body.events[0].seq,1);
  assert.equal((await f.scoped(a,'/ack',{data:{seq:2}})).status,400);
  await f.scoped(a,'/ack',{data:{seq:1}});
  assert.deepEqual((await f.scoped(a,'/wait?timeout=0')).body.events,[]);
  assert.equal((await f.scoped(a,'/wait?timeout=0&after=0')).body.events.length,1);
  assert.equal((await f.scoped(a,'/wait?timeout=31')).status,400);
  assert.equal((await f.scoped(a,'/wait?timeout=0&after=99')).status,400);
});

test('多个设备并发提交同一请求时，答复序号连续且没有覆盖',async(t)=>{
  const f=await fixture(t),r=await f.create(),cookie=await f.login();
  const submissions=await Promise.all(Array.from({length:12},(_,i)=>f.send(r,cookie,crypto.randomUUID(),[{q:'q1',type:'thread',text:`隔离并发讨论 ${i}` }])));
  assert.deepEqual(submissions.map((x)=>x.body.seq).sort((a,b)=>a-b),Array.from({length:12},(_,i)=>i+1));
  assert.equal((await f.scoped(r,'/wait?timeout=0')).body.events.length,12);
  assert.equal((await f.scoped(r,'',{method:'PATCH',data:{agent:null}})).status,400);
});

test('持久事件与状态恢复：重新打开存储后仍可重放未消费答复',async(t)=>{
  const f=await fixture(t),r=await f.create(),cookie=await f.login();await f.send(r,cookie);
  const second=createHandoverServer({...f.config,dataDir:f.dir});
  assert.equal(second.store.get(r.id).events[0].seq,1);
  assert.equal(second.store.get(r.id).state.agent.handled,0);
  assert.equal(fs.statSync(path.join(f.dir,'requests',r.id+'.json')).mode&0o077,0);
});

test('真实问题校验：未知题、未知选项和空答复不能解除等待',async(t)=>{
  const f=await fixture(t),r=await f.create(),cookie=await f.login();
  for(const action of [{q:'missing',type:'answer',kind:'text',text:'测试'},{q:'q1',type:'answer',kind:'option',option:'Z'},{q:'q1',type:'answer',kind:'text',text:' '}])assert.equal((await f.send(r,cookie,crypto.randomUUID(),[action])).status,400);
  assert.deepEqual((await f.scoped(r,'/wait?timeout=0')).body.events,[]);
  assert.equal((await f.scoped(r,'',{method:'PATCH',data:{project:'/other'}})).status,400);
  assert.equal((await f.scoped(r,'',{method:'PATCH',data:{agent:{handled:1}}})).status,400);
});

test('旧登录和票据端点退休：凭据不能创建会话或票据，启动不生成登录码',async(t)=>{
  const f=await fixture(t);
  assert.equal(fs.existsSync(path.join(f.dir,'login-code.json')),false);
  for(const route of ['/api/login','/api/login/ticket','/api/browser-tickets','/api/login-code','/api/pairing-tickets','/api/logout']){
    const result=await f.call(route,{key:agentToken,cookie:'handover_session=old',data:{token:adminToken,ticket:'old'}});
    assert.equal(result.status,410,route);assert.equal(result.headers.get('set-cookie'),null);
  }
  assert.deepEqual(f.store.all('sessions'),{});assert.deepEqual(f.store.all('tickets'),{});
});

test('退休不改写已有凭据、会话和旧请求；旧请求不能由用户名或旧凭据读取',async(t)=>{
  const f=await fixture(t),r=await f.create(),record=f.store.get(r.id);
  delete record.username;delete record.accessMode;record.tokenHash=crypto.createHash('sha256').update(r.requestToken).digest('hex');f.store.put(record);
  const previous={code:'Existing9Code',created:123};f.store.save('login-code',previous);f.store.save('sessions',{old:{expires:Date.now()+60000}});
  const before=fs.readFileSync(path.join(f.dir,'requests',r.id+'.json'),'utf8');
  const restarted=createHandoverServer(f.config);
  assert.equal(fs.readFileSync(path.join(f.dir,'requests',r.id+'.json'),'utf8'),before);
  assert.equal(await restarted.notify(record),0);
  assert.deepEqual(restarted.store.all('login-code'),previous);assert.deepEqual(restarted.store.all('sessions'),f.store.all('sessions'));
  assert.deepEqual((await f.call('/api/requests',{username:'Xpy'})).body.requests,[]);
  assert.equal((await f.scoped(r)).status,404);
  assert.equal((await f.call(`/api/requests/${r.id}`,{key:r.requestToken,source:r.source.session,username:null})).status,403);
  assert.equal((await f.call('/api/login',{data:{token:previous.code}})).status,410);
});

test('反馈、求助与取消：没有预选答案，取消会结束等待',async(t)=>{
  const f=await fixture(t);
  for(const kind of ['feedback','help']){
    const p=f.payload('source-'+kind);p.kind=kind;delete p.questions;
    const r=await f.create(p),state=(await f.scoped(r)).body.state;
    assert.equal(state.questions.length,1);assert.equal(state.questions[0].answer,undefined);
    const waiting=f.scoped(r,'/wait?timeout=1');await f.scoped(r,'/cancel',{data:{}});
    assert.equal((await waiting).body.status,'cancelled');
  }
});

test('推送订阅与新请求：仅向有效订阅发送，创建重试不会重复推送',async(t)=>{
  const messages=[];const f=await fixture(t,{disablePush:false,sendNotification:async(sub,payload)=>messages.push(JSON.parse(payload))});
  const cookie=await f.login(),sub={endpoint:'https://fcm.googleapis.com/fcm/send/test-fixture',keys:{p256dh:Buffer.alloc(65,1).toString('base64url'),auth:Buffer.alloc(16,2).toString('base64url')}};
  assert.equal((await f.call('/api/subscriptions',{cookie,data:{...sub,endpoint:'https://127.0.0.1/internal'}})).status,400);
  assert.equal((await f.call('/api/subscriptions',{cookie,data:sub})).status,200);
  const r=await f.create();await f.call('/api/requests',{key:agentToken,data:r});
  assert.equal(messages.length,1);assert.equal(messages[0].url,`/grill/${r.id}/?username=Xpy`);
  await f.call('/api/subscriptions',{cookie,method:'DELETE',data:sub});assert.deepEqual(f.store.all('subscriptions'),{});
});

test('原 Grill 页面通过请求路由复用，脚本语法、离线边界和可视化沙箱有效',async(t)=>{
  const f=await fixture(t),r=await f.create(),cookie=await f.login();
  const page=await f.call(`/grill/${r.id}/`,{cookie});assert.equal(page.status,200);assert.ok(page.body.includes(`/grill/${r.id}`));
  for(const script of page.body.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
  await f.scoped(r,'/visual',{method:'PUT',data:{html:'<h1>独立测试图解</h1>'}});
  const visual=await f.call(`/grill/${r.id}/visual`,{cookie});assert.match(visual.headers.get('content-security-policy'),/sandbox allow-scripts/);assert.match(visual.headers.get('content-security-policy'),/connect-src 'none'/);
  const sw=await f.call('/sw.js');assert.equal(sw.body.includes('__HANDOVER_BUILD__'),false);assert.ok(sw.body.includes('Private responses'));
});

test('通用客户端：前台超时退出 3、来源校验、恢复和显式确认消费',async(t)=>{
  const f=await fixture(t),home=path.join(f.dir,'client'),env={...process.env,CODEX_THREAD_ID:'cli-fixture-one',HANDOVER_SERVER_URL:f.url,HANDOVER_AGENT_TOKEN:agentToken,HANDOVER_USERNAME:'Xpy',HANDOVER_CONFIG:path.join(f.dir,'absent-config.json'),HANDOVER_STATE_DIR:home,HANDOVER_NO_OPEN:'1',HANDOVER_SKIP_UPDATE:'1'};
  const cli=path.resolve('skills/grill-with-ui/scripts/handover.mjs');
  const run=async(args,extra={})=>{try{const r=await exec(process.execPath,[cli,...args],{env:{...env,...extra}});return {code:0,data:JSON.parse(r.stdout)};}catch(e){return {code:e.code,data:JSON.parse(e.stdout)};}};
  const created=await run(['new','--kind','help','--topic','客户端隔离测试','--no-open']);assert.equal(created.code,0);const handle=created.data.handle;
  assert.equal((await run(['wait','--handle',handle,'--timeout','0.01'])).code,3);
  assert.equal((await run(['wait','--handle',handle,'--timeout','0'],{CODEX_THREAD_ID:'cli-fixture-two'})).code,1);
  const h=JSON.parse(fs.readFileSync(handle,'utf8')),cookie=await f.login();await f.send({id:h.id},cookie,crypto.randomUUID(),[{q:'q1',type:'answer',kind:'text',text:'隔离测试回答'}]);
  const first=await run(['wait','--handle',handle,'--timeout','0']);assert.equal(first.data.events[0].seq,1);
  assert.equal((await run(['resume','--handle',handle])).data.handled,0);
  await run(['ack','--handle',handle,'--seq','1']);assert.equal((await run(['pending','--handle',handle])).data.events.length,0);
});

test('客户端使用前检查并更新 Skill，新版继续同次创建且恢复不重复请求',async(t)=>{
  const f=await fixture(t),bin=path.join(f.dir,'bin'),state=path.join(f.dir,'client-state'),skills=path.join(f.dir,'client-skills');
  fs.mkdirSync(bin);
  const manifest=JSON.parse(fs.readFileSync('skills/manifest.json','utf8'));
  const files=Object.fromEntries(manifest.files.map((file)=>[file,fs.readFileSync(file,'utf8')]));
  const snapshot=path.join(f.dir,'github-fixture.json'),calls=path.join(f.dir,'github-calls.jsonl'),version='c'.repeat(40);
  fs.writeFileSync(snapshot,JSON.stringify({manifest,files,version}));
  fs.writeFileSync(path.join(bin,'gh'),`#!/usr/bin/env node
import fs from 'node:fs';
const fixture=JSON.parse(fs.readFileSync(process.env.HANDOVER_TEST_GITHUB_FIXTURE,'utf8'));
const args=process.argv.slice(2);fs.appendFileSync(process.env.HANDOVER_TEST_GITHUB_CALLS,JSON.stringify(args)+'\\n');
if(args[1].endsWith('/commits/main'))process.stdout.write(fixture.version+'\\n');
else {const target=new URL('https://api.github.com/'+args.at(-1));if(target.searchParams.get('ref')!==fixture.version)process.exit(1);const file=target.pathname.split('/contents/')[1];process.stdout.write(file==='skills/manifest.json'?JSON.stringify(fixture.manifest):fixture.files[file]);}
`,{mode:0o700});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CODEX_THREAD_ID:'update-source-fixture',HANDOVER_SERVER_URL:f.url,HANDOVER_AGENT_TOKEN:agentToken,HANDOVER_USERNAME:'Xpy',HANDOVER_CONFIG:path.join(f.dir,'absent-config.json'),HANDOVER_STATE_DIR:state,HANDOVER_SKILLS_DIR:skills,HANDOVER_SKILL_BACKUP_DIR:path.join(f.dir,'backups'),HANDOVER_NO_OPEN:'1',HANDOVER_SKIP_UPDATE:'',HANDOVER_UPDATE_CHECKED:'',HANDOVER_TEST_GITHUB_FIXTURE:snapshot,HANDOVER_TEST_GITHUB_CALLS:calls};
  const cli=path.resolve('skills/grill-with-ui/scripts/handover.mjs');
  const created=await exec(process.execPath,[cli,'new','--kind','help','--topic','更新后创建隔离请求','--no-open'],{env});
  const result=JSON.parse(created.stdout);
  assert.equal(result.ok,true);assert.equal(result.source.session,env.CODEX_THREAD_ID);assert.equal(f.store.list().length,1);
  assert.equal(JSON.parse(created.stderr).updated,true);
  assert.equal(fs.readFileSync(calls,'utf8').trim().split('\n').length,manifest.files.length+2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(skills,'grill-with-ui/.handover-install.json'))).commit,version);
  const resumed=await exec(process.execPath,[path.join(skills,'grill-with-ui/scripts/handover.mjs'),'resume','--handle',result.handle],{env});
  assert.equal(JSON.parse(resumed.stdout).requestId,result.requestId);assert.equal(f.store.list().length,1);
  assert.equal(JSON.parse(resumed.stderr).updated,false);
  assert.equal(fs.readFileSync(calls,'utf8').trim().split('\n').length,manifest.files.length+3);
  await exec(process.execPath,[cli,'state','--handle',result.handle],{env});
  assert.equal(fs.readFileSync(calls,'utf8').trim().split('\n').length,manifest.files.length+3);
});
