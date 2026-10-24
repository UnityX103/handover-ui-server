// Uses generated Skill HTML and an isolated local service, never live requests or Unity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHandoverServer} from '../src/server.mjs';

const root=path.resolve(process.env.MIDA_FLOW_PROJECT_ROOT || '');
assert.ok(process.env.MIDA_FLOW_PROJECT_ROOT,'Set MIDA_FLOW_PROJECT_ROOT to the target Skill workspace');
const output=fs.mkdtempSync(path.join(fs.mkdirSync(path.join(root,'TestTemp/SegmentFlow/HandoverRestore'),{recursive:true})||path.join(root,'TestTemp/SegmentFlow/HandoverRestore'),'case-'));
const dir=fs.mkdtempSync(path.resolve('.local/sent-feedback-'));
const input=path.join(output,'input.json'),exec=promisify(execFile);
fs.writeFileSync(input,JSON.stringify({topic:'合成反馈持久化回归',context:'隔离回归，不表示真人答复或批准',fields:[{id:'decision',label:'合成选择',type:'choice',options:[{id:'keep',label:'保留'},{id:'defer',label:'暂缓'}]},{id:'details',label:'自定义 JSON',type:'json',required:false}],feedbackMetadata:{synthetic:true}}));
const helper=path.join(root,'.agents/skills/mida-segment-autotest/scripts/review_handover.py');
const prepared=JSON.parse((await exec('python3',['-B',helper,'prepare','--skill','mida-segment-testing','--input',input,'--out',path.join(output,'page'),'--root',root])).stdout);
const manifest=JSON.parse(fs.readFileSync(prepared.manifest));
const html=process.env.MIDA_FLOW_TEMPLATE?fs.readFileSync(process.env.MIDA_FLOW_TEMPLATE,'utf8').replace('__REVIEW_DATA__',JSON.stringify(manifest).replaceAll('<','\\u003c')):fs.readFileSync(prepared.html,'utf8');
const app=createHandoverServer({dataDir:dir,port:0,publicUrl:'http://127.0.0.1:0/handover/',adminToken:'isolated-restore-admin-'.repeat(3),disablePush:true});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${app.server.address().port}/handover/`;
const id=crypto.randomUUID(),source='isolated-sent-feedback-source';
const api=async(route,data)=>{
 const response=await fetch(base+route,{method:data?'POST':'GET',headers:{'X-Handover-Username':'Xpy','X-Handover-Source':source,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
 const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
};
const {chromium}=await import(process.env.PLAYWRIGHT_PKG||'playwright');
const browser=await chromium.launch({channel:'chromium',executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
try {
 await api('api/requests',{id,username:'Xpy',source:{session:source},kind:'feedback',topic:manifest.topic,page:{version:1,html,feedbackType:manifest.feedbackType,documentId:manifest.reviewId}});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const page=await context.newPage(),errors=[];page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'?username=Xpy');await page.locator('#username').fill('Xpy');await page.locator('#username-form button').click();await page.locator('#workspace').waitFor();
 const url=base+`grill/${id}/?username=Xpy`;
 await page.goto(url);
 const frame=page.frameLocator('#page');await frame.locator('#fields').waitFor();
 const radio=frame.locator('input[name="decision"][value="defer"]');
 if(await radio.count())await radio.check();else await frame.locator('select').first().selectOption('defer');
 await frame.getByRole('textbox',{name:'自定义 JSON'}).fill('{"kept":["synthetic",2]}');
 if(!await frame.locator('#comment').isVisible())await frame.locator('#comment-summary').click();
 await frame.locator('#comment').fill('合成补充：重新打开后必须保留');
 await frame.locator('#remote').click();await page.waitForURL(base+'?username=Xpy');
 const before=await api(`api/requests/${id}/wait?timeout=0`);assert.equal(before.events[0].payload.answers.decision,'defer');
 await page.locator('#status').selectOption('sent');await page.locator('a.request').click();
 await frame.locator('#fields').waitFor();
 const selected=await frame.locator('body').evaluate(()=>{const field=controls.get('decision');return Array.isArray(field)?field.find(input=>input.checked)?.value:field.value;});
 assert.equal(selected,'defer','从已发送反馈重新打开，必须恢复上次所选项');
 assert.deepEqual(JSON.parse(await frame.getByRole('textbox',{name:'自定义 JSON'}).inputValue()),{kept:['synthetic',2]});
 assert.equal(await frame.locator('#comment').inputValue(),'合成补充：重新打开后必须保留');
 await page.reload();await frame.locator('#fields').waitFor();
 await frame.locator('#export').click();assert.equal(JSON.parse(await frame.locator('#export-json').inputValue()).answers.decision,'defer');
 await api(`api/requests/${id}/ack`,{seq:1});
 await context.close();
 const otherDevice=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const reopened=await otherDevice.newPage();await reopened.goto(url);await reopened.locator('#username').fill('Xpy');await reopened.locator('#username-form button').click();await reopened.waitForURL(url);
 const remoteFrame=reopened.frameLocator('#page');await remoteFrame.locator('#fields').waitFor();
 assert.equal(await remoteFrame.locator('body').evaluate(()=>{const field=controls.get('decision');return Array.isArray(field)?field.find(input=>input.checked)?.value:field.value;}),'defer');
 assert.deepEqual(JSON.parse(await remoteFrame.getByRole('textbox',{name:'自定义 JSON'}).inputValue()),{kept:['synthetic',2]});
 assert.equal(JSON.parse(await reopened.locator('#saved-feedback-json').textContent()).comment,'合成补充：重新打开后必须保留');
 const state=await api(`api/requests/${id}/wait?timeout=0`);assert.equal(state.events.length,0);assert.equal(state.handled,1);assert.equal(state.waitingFor,'agent');assert.deepEqual(errors,[]);
 assert.equal(app.store.get(id).events.length,1);
 // A new browser must also recover ordinary Grill options without borrowing local drafts.
 const questionId=crypto.randomUUID();
 await api('api/requests',{id:questionId,username:'Xpy',source:{session:source},kind:'feedback',topic:'合成普通反馈',questions:[{id:'q1',title:'合成选项',round:1,options:[{k:'A',text:'合成甲'},{k:'B',text:'合成乙'}],rec:{}}]});
 const questionUrl=base+`grill/${questionId}/?username=Xpy`;
 await reopened.goto(questionUrl);await reopened.locator('.opt[data-opt="B"]').click();await reopened.locator('#send').click();await reopened.waitForURL(base+'?username=Xpy');
 await otherDevice.close();
 const fresh=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const freshPage=await fresh.newPage();await freshPage.goto(questionUrl);await freshPage.locator('#username').fill('Xpy');await freshPage.locator('#username-form button').click();await freshPage.waitForURL(questionUrl);
 await freshPage.locator('.opt.pending[data-opt="B"]').waitFor();assert.equal(app.store.get(questionId).state.agent.handled,0);assert.equal(app.store.get(questionId).events.length,1);
 await fresh.close();
 if(process.env.MIDA_RESOURCE_PROJECT_ROOT){
  const resourceProject=path.resolve(process.env.MIDA_RESOURCE_PROJECT_ROOT);
  const fixtureCode=`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1])/'.agents/skills/mida-resource-packaging/scripts'))\nfrom test_resource_review import ResourceReviewTests\nimport resource_review as rr\nt=ResourceReviewTests();t.setUp();t.temp._finalizer.detach()\nm=rr.make_review(t.root,'scope.json',['report.json'],'plans.json')\nprint(json.dumps({'manifest':m,'html':rr.render(m)}))\n`;
  const fixture=JSON.parse((await exec('python3',['-B','-c',fixtureCode,resourceProject],{maxBuffer:4*1024*1024})).stdout),resourceId=crypto.randomUUID();
  await api('api/requests',{id:resourceId,username:'Xpy',source:{session:source},kind:'feedback',topic:'合成资源反馈持久化',page:{version:1,html:fixture.html,feedbackType:'mida-resource-decisions',documentId:fixture.manifest.reviewId}});
  const resourceUrl=base+`grill/${resourceId}/?username=Xpy`,device=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),resourcePage=await device.newPage();
  await resourcePage.goto(resourceUrl);await resourcePage.locator('#username').fill('Xpy');await resourcePage.locator('#username-form button').click();await resourcePage.waitForURL(resourceUrl);
  const resource=resourcePage.frameLocator('#page');await resource.locator('input[value="keep"]').first().waitFor();
  for(const input of await resource.locator('input[value="keep"]:enabled').all())await input.check();
  await resource.locator('input[value="manual"]:enabled').first().check();await resource.locator('.manual-text').first().fill('合成手动处理方式，必须持久保留');await resource.locator('.manual-save').first().click();
  if(await resource.locator('#normal-confirm').isEnabled())await resource.locator('#normal-confirm').check();
  const chosen=await resource.locator('body').evaluate(()=>JSON.parse(JSON.stringify(decisionPayload())));
  await resource.locator('#send-remote').click();await resourcePage.waitForURL(base+'?username=Xpy');
  await resourcePage.locator('#status').selectOption('sent');await resourcePage.locator(`a.request[href="/handover/grill/${resourceId}/?username=Xpy"]`).click();
  await resource.locator('.manual-text').first().waitFor();assert.equal(await resource.locator('.manual-text').first().inputValue(),'合成手动处理方式，必须持久保留');
  const restored=await resource.locator('body').evaluate(()=>JSON.parse(JSON.stringify(decisionPayload())));
  for(const field of ['choices','normalConfirmation','manualHandlingLibrary'])assert.deepEqual(restored[field],chosen[field]);
  await api(`api/requests/${resourceId}/ack`,{seq:1});await resourcePage.reload();await resource.locator('.manual-text').first().waitFor();assert.equal(await resource.locator('.manual-text').first().inputValue(),'合成手动处理方式，必须持久保留');assert.equal(app.store.get(resourceId).events.length,1);
  await device.close();
 }
 console.log('PASS: 已发送反馈重新打开后恢复选择、JSON 和补充，不消费或重复发送事件');
} finally {
 await browser.close();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});
}
