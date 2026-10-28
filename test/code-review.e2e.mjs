// Local synthetic requests only. Approval buttons never touch a real request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHandoverServer } from '../src/server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_PKG || 'playwright');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handover-review-browser-'));
const app=createHandoverServer({dataDir:dir,port:0,publicUrl:'http://127.0.0.1:0/handover/',adminToken:crypto.randomBytes(32).toString('hex'),disablePush:true});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${app.server.address().port}`,base=origin+'/handover';
const browser=await chromium.launch({channel:'chromium',executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const context=await browser.newContext({viewport:{width:1377,height:859}}),page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const after='.body {\n    font-size: 22px;\n    line-height: 1.9;\n}\n/* '+ 'long line '.repeat(35) +' */\n// </code><img src=x onerror=alert(1)>';
const review={id:'review-browser',revision:1,summary:'放大说明并保持足够行距。',files:[{path:'/isolated/project/web/grill.css',summary:'重要内容使用大字号。',startLine:65,language:'css',before:'.body { font-size: 15px; }',after}],expected:{summary:'说明文字有清楚的行间留白。',html:`<!doctype html><html><head><style>body{font:22px/1.9 system-ui}</style></head><body><p>修改后的说明文字</p><button id="preview-toggle">查看效果</button><p id="preview-result"></p><span id="parent-access"></span><span id="network-access"></span><script>document.getElementById('preview-toggle').onclick=()=>document.getElementById('preview-result').textContent='效果已展开';try{parent.document.body;document.getElementById('parent-access').textContent='exposed'}catch{document.getElementById('parent-access').textContent='blocked'}fetch('/handover/api/requests?username=Preview').then(()=>document.getElementById('network-access').textContent='exposed',()=>document.getElementById('network-access').textContent='blocked');</script></body></html>`}};
const request={id:crypto.randomUUID(),username:'Preview',kind:'feedback',topic:'代码审核浏览器检查',source:{session:'isolated-review-browser-source'},questions:[{id:'q1',round:1,title:'检查代码修改',body:'先看预期效果，再查看对应代码。',rec:{},options:[{k:'A',text:'普通选项'}],codeReview:review},{id:'q2',round:1,title:'普通问题',body:'保持原有流程。',rec:{}}]};
async function api(route,data,method=data?'POST':'GET') {
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Handover-Username':'Preview','X-Handover-Source':request.source.session},body:data?JSON.stringify(data):undefined});
  const body=await response.json();assert.ok(response.ok,JSON.stringify(body));return body;
}
try {
  await api('/api/requests',request);
  await page.goto(base+'/?username=Preview');await page.locator('#username').fill('Preview');await page.locator('#username-form button').click();await page.locator('a.request').waitFor();
  await page.goto(base+`/grill/${request.id}/?username=Preview`);
  const panel=page.locator('.handover-code-review');await panel.waitFor();
  assert.equal(await panel.locator('.review-title').innerText(),review.summary);
  assert.equal(await panel.evaluate(el=>el.parentElement.lastElementChild === el),true);
  assert.equal(await panel.locator('.review-code-after .review-code-number').first().innerText(),'65');
  const raw=await panel.locator('.review-code-after .review-source').allTextContents();assert.equal(raw.join('\n'),after);
  assert.equal(await panel.locator('img,[onerror]').count(),0);
  assert.equal(await panel.locator('.review-token-number').first().evaluate(el=>getComputedStyle(el).color),'rgb(237, 148, 192)');
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.evaluate(()=>document.fonts.check('20px "Handover JetBrains Mono"')),true);
  const iframe=panel.locator('iframe');assert.equal(await iframe.getAttribute('sandbox'),'allow-scripts');assert.ok((await iframe.getAttribute('src')).startsWith('/handover/grill/'));
  const frame=page.frameLocator('.review-expected-frame');
  await iframe.scrollIntoViewIfNeeded();await frame.locator('#preview-toggle').click();assert.equal(await frame.locator('#preview-result').innerText(),'效果已展开');
  assert.equal(await frame.locator('#parent-access').innerText(),'blocked');await frame.locator('#network-access').filter({hasText:'blocked'}).waitFor();
  assert.equal((await api(`/api/requests/${request.id}/wait?timeout=0`)).events.length,0,'viewing code and effect cannot submit a decision');
  await panel.locator('.review-before>summary').click();assert.equal(await panel.locator('.review-code-before').isVisible(),true);
  await page.locator('.opt').click();assert.equal(await panel.locator('.review-code-before').isVisible(),true,'staging preserves before/after disclosure');
  await page.locator('#nav .item[data-q="q2"]').click();assert.equal(await panel.count(),0);
  await page.locator('#nav .item[data-q="q1"]').click();
  for(const width of [1377,768,390]) {
    await page.setViewportSize({width,height:859});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page width '+width);
    const sizes=await panel.locator('.review-code-after').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));assert.ok(sizes.scroll>sizes.client,'long code scrolls within code region');
  }
  // Keep the old view on screen while a newer proposal reaches the server.
  await page.route('**/grill/*/state*',route=>route.abort());
  await api(`/api/requests/${request.id}`,{questions:[{id:'q1',codeReview:{...review,revision:2,summary:'更新后的修改说明。'}}]},'PATCH');
  await panel.getByRole('button',{name:'批准并发送',exact:true}).click();
  await panel.locator('.review-error').filter({hasText:'修改方案已更新'}).waitFor();
  assert.equal((await api(`/api/requests/${request.id}/wait?timeout=0`)).events.length,0);
  await page.unroute('**/grill/*/state*');await panel.locator('.review-title').filter({hasText:'更新后的修改说明。'}).waitFor();
  await page.locator('#thread-in').fill('一并发送的真实测试草稿');
  await panel.getByRole('button',{name:'批准并发送',exact:true}).click();await page.waitForURL(base+'/?username=Preview');
  const saved=await api(`/api/requests/${request.id}/wait?timeout=0`);assert.equal(saved.handled,0);assert.equal(saved.events.length,1);
  const actions=saved.events[0].actions,decision=actions.find(action=>action.review);
  assert.equal(decision.review.decision,'approve');assert.equal(decision.review.revision,2);assert.equal(decision.q,'q1');assert.ok(actions.some(action=>action.type==='thread'&&action.text==='一并发送的真实测试草稿'));
  assert.deepEqual(errors,[]);
  console.log('PASS: bottom code review, Rider font/colors and exact source, sandboxed interactive effect, responsive code scrolling, preserved disclosure, stale approval rejection and explicit versioned decision receipt');
} finally {await browser.close();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
