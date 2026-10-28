import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHandoverServer } from '../src/server.mjs';
import { codeReviewLimits, prepareCodeReviews } from '../src/code-review.mjs';

const review = () => ({id:'readable-body',revision:1,summary:'放大说明。',files:[{path:'/isolated/project/web/grill.css',summary:'放大字号。',startLine:65,language:'css',before:'.body { font-size: 15px; }',after:'.body { font-size: 22px; }'}],expected:{summary:'更大字号。',html:'<!doctype html><body><p>22px 效果</p></body>'}});
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handover-code-review-'));
  const app=createHandoverServer({dataDir:dir,adminToken:crypto.randomBytes(32).toString('hex'),port:0,publicUrl:'https://example.invalid/handover/',disablePush:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const request={id:crypto.randomUUID(),username:'Preview',kind:'feedback',topic:'隔离代码审核',source:{session:'isolated-code-review-source'},questions:[{id:'q1',round:1,title:'查看具体修改',rec:{},codeReview:review()}]};
  const call=async(route,data,{method=data?'POST':'GET',username='Preview',source=request.source.session}={})=>{
    const response=await fetch(origin+'/handover'+route,{method,headers:{'X-Handover-Username':username,'X-Handover-Source':source,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
    const content=await response.text();let body;try{body=JSON.parse(content);}catch{body=content;}
    return {status:response.status,headers:response.headers,body};
  };
  assert.equal((await call('/api/requests',request)).status,201);
  const current=async()=>(await call('/api/requests/'+request.id)).body.state.questions[0].codeReview;
  return {...app,request,call,current};
}

test('代码与预览的版本绑定，重复发送幂等且不会替 Agent 消费事件',async t=>{
  const f=await fixture(t), current=await f.current();
  assert.match(current.digest,/^[a-f0-9]{64}$/);
  const decision={id:current.id,revision:current.revision,digest:current.digest,decision:'approve'};
  const data={submissionId:crypto.randomUUID(),actions:[{q:'q1',type:'answer',kind:'text',text:'批准这项修改',review:decision}]};
  const send=()=>f.call(`/grill/${f.request.id}/send`,data);
  assert.equal((await send()).body.seq,1);assert.equal((await send()).body.seq,1);
  let state=(await f.call(`/api/requests/${f.request.id}/wait?timeout=0`)).body;
  assert.equal(state.handled,0);assert.equal(state.events.length,1);assert.deepEqual(state.events[0].actions[0].review,decision);
  const next={...review(),revision:2,expected:{summary:'新效果。',html:'<body>新效果</body>'}};
  assert.equal((await f.call(`/api/requests/${f.request.id}`,{questions:[{id:'q1',codeReview:next}]},{method:'PATCH'})).status,200);
  assert.notEqual((await f.current()).digest,current.digest);
  // A retry of an already-saved submission still reports that original receipt.
  assert.equal((await send()).body.seq,1);
  data.submissionId=crypto.randomUUID();assert.equal((await send()).status,409);
  data.actions[0].review={...decision,...await f.current(),decision:'approve'};
  // Send only the declared decision identity, never copies of code or HTML.
  data.actions[0].review={id:data.actions[0].review.id,revision:2,digest:data.actions[0].review.digest,decision:'approve'};
  assert.equal((await send()).body.seq,2);
  state=(await f.call(`/api/requests/${f.request.id}/wait?timeout=0`)).body;
  assert.equal(state.handled,0);assert.equal(state.events.length,2);
  assert.equal((await f.call(`/api/requests/${f.request.id}`,undefined,{source:'other-source'})).status,403);
});

test('预期效果严格匹配用户名及修改内容，沙箱保留子路径且不缓存业务数据',async t=>{
  const f=await fixture(t),current=await f.current();
  const url=`/grill/${f.request.id}/review-preview?q=q1&digest=${current.digest}`;
  const response=await f.call(url);
  assert.equal(response.status,200);assert.equal(response.body,current.expected.html);assert.equal(response.headers.get('cache-control'),'no-store');
  const csp=response.headers.get('content-security-policy');assert.match(csp,/sandbox allow-scripts/);assert.doesNotMatch(csp,/allow-same-origin/);assert.match(csp,/connect-src 'none'/);assert.match(csp,/form-action 'none'/);
  assert.equal((await f.call(url,undefined,{username:'Other'})).status,404);
  assert.equal((await f.call(url.replace(current.digest,'outdated'))).status,409);
  assert.equal((await f.call(url.replace('q=q1','q=unknown'))).status,404);
  const font=await f.call('/fonts/JetBrainsMono-Regular.ttf');assert.equal(font.status,200);assert.equal(font.headers.get('content-type'),'font/ttf');
  assert.equal((await f.call('/api/capabilities')).body.codeReview.maxFiles,codeReviewLimits.maxFiles);
});

test('修改版本不可回退或复用；无预览及无代码的旧问题仍可使用',async t=>{
  const f=await fixture(t),current=await f.current();
  const change={...review(),summary:'改过的说明。'};
  assert.equal((await f.call(`/api/requests/${f.request.id}`,{questions:[{id:'q1',codeReview:change}]},{method:'PATCH'})).status,400);
  assert.equal((await f.current()).digest,current.digest);
  const bad={...review(),files:[{...review().files[0],after:'x'.repeat(codeReviewLimits.maxCodeBytes+1)}]};
  assert.throws(()=>prepareCodeReviews({questions:[{codeReview:bad}]}),/代码片段/);
  const without=review();delete without.expected;without.revision=2;
  assert.equal((await f.call(`/api/requests/${f.request.id}`,{questions:[{id:'q1',codeReview:without}]},{method:'PATCH'})).status,200);
  assert.equal((await f.call(`/grill/${f.request.id}/review-preview?q=q1&digest=${(await f.current()).digest}`)).status,404);
  assert.equal((await f.call(`/api/requests/${f.request.id}`,{questions:[{id:'q1',codeReview:null}]},{method:'PATCH'})).status,200);
  const ordinary={submissionId:crypto.randomUUID(),actions:[{q:'q1',type:'answer',kind:'text',text:'普通答复'}]};
  assert.equal((await f.call(`/grill/${f.request.id}/send`,ordinary)).status,200);
});
