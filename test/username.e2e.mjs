// Synthetic local requests only; no real user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHandoverServer } from '../src/server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_PKG || 'playwright');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'username-browser-'));
const app = createHandoverServer({dataDir:dir,agentToken:undefined,adminToken:crypto.randomBytes(32).toString('hex'),publicUrl:'http://127.0.0.1:0',port:0,disablePush:true});
await new Promise((resolve)=>app.server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
const page = await context.newPage(), errors = [], urls = [];
page.on('pageerror',(error)=>errors.push(error.message));
page.on('request',(request)=>urls.push(new URL(request.url()).pathname));
async function api(route,body,method=body?'POST':'GET',username='Xpy') {
 const response=await fetch(base+route,{method,headers:{'X-Handover-Username':username,'X-Handover-Source':'isolated-username-source',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
}
const request = (extra={})=>({id:crypto.randomUUID(),kind:'help',topic:'Synthetic username test',username:'Xpy',source:{session:'isolated-username-source'},...extra});
const fit=async()=>{const [width,scroll]=await page.evaluate(()=>[innerWidth,document.documentElement.scrollWidth]);assert.ok(scroll<=width+1,`mobile overflow ${scroll}/${width}`);};
try {
 const a=request(); await api('/api/requests',a);
 const other=request({username:'Other',topic:'Must not appear'});await api('/api/requests',other,'POST','Other');
 await page.goto(base+'/?username=Xpy');
 assert.equal(await page.locator('#username').inputValue(),'');
 await page.locator('#username').fill('Xpy');await page.locator('#username-form button').click();
 await page.locator(`a.request[href="/grill/${a.id}/?username=Xpy"]`).waitFor();
 assert.equal(await page.locator('a.request').count(),1);assert.equal(await page.locator('#settings-toggle').isVisible(),true);await fit();
 await page.locator('a.request').click();await page.locator('#free').fill('Synthetic answer');await page.locator('#stage-text').click();await page.locator('#send').click();
 await page.waitForFunction(()=>sessionStorage.getItem('handover:return:'+location.pathname+location.search));
 const events=await api(`/api/requests/${a.id}/wait?timeout=0`);assert.equal(events.events.length,1);assert.equal(events.events[0].actions[0].text,'Synthetic answer');assert.equal(events.username,'Xpy');
 await api(`/api/requests/${a.id}`,{questions:[{id:'q1',status:'answered',answer:{kind:'text',text:'Synthetic answer'}}]},'PATCH');
 await api(`/api/requests/${a.id}/ack`,{seq:1});await page.waitForURL(base+'/?username=Xpy');
 const custom=request({page:{version:1,feedbackType:'synthetic',documentId:'synthetic-document',html:'<!doctype html><html><body><button id="submit">Send synthetic JSON</button><script>document.querySelector("button").onclick=()=>HandoverBridge.submit({synthetic:true}).then(()=>document.body.dataset.saved="yes")</script></body></html>'}});
 await api('/api/requests',custom);await page.goto(base+`/grill/${custom.id}/?username=Xpy`);
 await page.frameLocator('#page').locator('#submit').click();
 await page.frameLocator('#page').locator('body[data-saved="yes"]').waitFor();await fit();
 const customEvents=await api(`/api/requests/${custom.id}/wait?timeout=0`);assert.deepEqual(customEvents.events[0].payload,{synthetic:true});assert.equal(customEvents.events[0].username,'Xpy');
 await api(`/api/requests/${custom.id}/ack`,{seq:1});await page.waitForURL(base+'/?username=Xpy');
 assert.equal((await context.cookies()).length,0,'public browser must receive no owner cookie');
 assert.ok(!urls.some((url)=>/^\/api\/(login|browser-tickets|subscriptions|pairing-tickets)/.test(url)),JSON.stringify(urls));
 await page.reload();assert.equal(await page.locator('#username-panel').isVisible(),false);
 await page.locator('#username-logout').click();await page.waitForURL(base+'/');assert.equal(await page.locator('#username').inputValue(),'');
 assert.deepEqual(errors,[]);console.log('PASS: username mobile inbox, isolation, question answer/ack scoped return, custom JSON bridge, no owner routes/cookie');
} finally {await browser.close();app.server.closeAllConnections();await new Promise((resolve)=>app.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
