// Isolated standard-page fixtures; no real requests, notifications or answers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHandoverServer } from '../src/server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_PKG || 'playwright');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'handover-readability-'));
const app = createHandoverServer({dataDir:dir,port:0,publicUrl:'http://127.0.0.1:0',adminToken:crypto.randomBytes(32).toString('hex'),disablePush:true});
await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({channel:'chromium',executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const context = await browser.newContext({viewport:{width:1377,height:859}});
const page = await context.newPage(), errors = [];
page.on('pageerror',error => errors.push(error.message));
const summary = '先读一句话结论，需要时再展开依据。';
const details = '这是保留的完整依据。\n\n第二段解释具体取舍，内容不会因暂存、切题或收到新消息而丢失。';
const legacy = '旧讨论的第一句话。后面的说明仍然保留。\n第二行也保留。';
const longTitle = '非常长的侧栏题目：' + '标题应当省略而完整内容仍能在正文中阅读。'.repeat(10);
const payload = {id:'isolated-readability-preview',username:'Preview',kind:'feedback',topic:'阅读布局回归',source:{session:'isolated-readability-source'},questions:[
  {id:'q1',round:1,title:longTitle,body:'重要说明应该足够大、足够宽松，选中答案后仍然清楚。',options:[{k:'A',text:'选项甲'},{k:'B',text:'选项乙'}],rec:{},thread:[
    {who:'agent',text:summary+'\n\n'+details},
    {who:'agent',text:legacy},
    {who:'agent',text:'**加粗总结。**\n\n<img src=x onerror=alert(1)> [不安全链接](javascript:alert(1))'},
    {who:'user',text:'用户自己的原话完整保留。'},
    {who:'agent',text:'只有一句话，无需额外展开。'}
  ]},
  {id:'q2',round:2,title:'另一题',body:'用于验证展开状态按问题隔离。',options:[],rec:{},thread:[{who:'agent',text:'另一题的结论。\n\n另一题的细节。'}]}
]};
async function api(route,data,method='POST') {
  const response = await fetch(origin+route,{method,headers:{'Content-Type':'application/json','X-Handover-Username':'Preview','X-Handover-Source':payload.source.session},body:JSON.stringify(data)});
  assert.ok(response.ok,await response.text());
}
const style = selector => page.locator(selector).first().evaluate(el => {const s=getComputedStyle(el);return {font:parseFloat(s.fontSize),line:parseFloat(s.lineHeight),weight:Number(s.fontWeight),letter:parseFloat(s.letterSpacing),opacity:s.opacity};});
const fit = async () => assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1));
try {
  await api('/api/requests',payload);
  await page.goto(origin+'/?username=Preview');
  await page.locator('#username').fill('Preview'); await page.locator('#username-form button').click();
  await page.locator('a.request').waitFor();
  await page.goto(origin+`/grill/${payload.id}/?username=Preview`);
  await page.locator('#nav .item[data-q="q1"]').click();
  const first = page.locator('.handover-discussion').first();
  await first.waitFor();
  assert.equal(await first.locator('summary').innerText(),summary);
  assert.equal(await first.getAttribute('open'),null);
  assert.equal(await first.locator('.text').isVisible(),false);
  assert.equal(await page.locator('.msg.user .text').innerText(),'用户自己的原话完整保留。');
  assert.equal(await page.locator('.handover-discussion-conclusion').innerText(),'只有一句话，无需额外展开。');
  assert.equal(await page.locator('#aside img, #aside [onerror], #aside a[href^="javascript:"]').count(),0);
  assert.equal(await page.locator('.handover-discussion').nth(2).locator('summary').innerText(),'加粗总结。');
  await first.locator('summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await first.locator('.text').innerText(),details);
  await page.locator('.opt[data-opt="A"]').click();
  assert.notEqual(await first.getAttribute('open'),null,'staging must keep the expanded reply open');
  assert.equal((await style('#main .body')).opacity,'1');
  await page.locator('#nav .item[data-q="q2"]').click();
  assert.equal(await first.getAttribute('open'),null,'another question starts collapsed');
  await page.locator('#nav .item[data-q="q1"]').click();
  assert.notEqual(await first.getAttribute('open'),null,'returning to a question restores its expansion');
  const old = page.locator('.handover-discussion').nth(1);
  assert.equal(await old.locator('summary').innerText(),'旧讨论的第一句话。');
  await old.locator('summary').click(); assert.equal(await old.locator('.text').innerText(),legacy);
  await api(`/api/requests/${payload.id}`,{questions:[{id:'q1',thread:[{who:'agent',text:'新增的结论。\n\n新增的细节。'}]}]},'PATCH');
  await page.locator('.handover-discussion summary').filter({hasText:'新增的结论。'}).waitFor();
  assert.notEqual(await first.getAttribute('open'),null,'incoming messages do not collapse what is being read');
  assert.equal(await page.locator('.handover-discussion').last().getAttribute('open'),null);
  assert.equal(await page.locator('#nav .round').first().isVisible(),false);
  assert.equal(await page.locator('#nav .mark.open').first().isVisible(),false);
  assert.ok((await page.locator('#nav .item').first().getAttribute('title')).includes(longTitle));
  assert.ok((await page.locator('#nav .item').first().getAttribute('aria-label')).includes(longTitle));
  const navTitle = await page.locator('#nav .item .t').first().evaluate(el => ({style:getComputedStyle(el).textOverflow,whiteSpace:getComputedStyle(el).whiteSpace,overflows:el.scrollWidth > el.clientWidth}));
  assert.deepEqual(navTitle,{style:'ellipsis',whiteSpace:'nowrap',overflows:true});
  for (const width of [1377,768,390]) {
    await page.setViewportSize({width,height:859}); await fit();
    for (const selector of ['#main .body','#aside .msg .text','#aside textarea','#aside summary']) {
      const s=await style(selector); assert.ok(s.font >= 20,selector+': '+JSON.stringify(s));
      assert.ok(s.line/s.font >= 1.8,selector+': '+JSON.stringify(s));
      assert.ok(s.weight >= 500,selector+': '+JSON.stringify(s));
      assert.ok(s.letter > 0,selector+': '+JSON.stringify(s));
    }
  }
  await page.locator('.handover-more summary').click();
  await page.getByRole('button',{name:'字号 +',exact:true}).click();
  assert.equal((await style('#aside .msg .text')).font,22);
  assert.equal((await style('#main .body')).font,22);
  assert.deepEqual(errors,[]);
  console.log('PASS: readable phone/tablet/desktop typography, sidebar ellipsis, conclusion-first discussion, keyboard expansion, state retention, old-message fidelity and escaped markup');
} finally {
  await browser.close();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});
}
