import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('桥接恢复保留 JSON、只接受父页面握手，回填不提交或自动标脏',async()=>{
 const events={},messages=[],parent={postMessage:(...args)=>messages.push(args)},origin='https://isolated.example';
 const window={__HANDOVER_BRIDGE__:{origin},addEventListener:(name,listener)=>{events[name]=listener;}};
 vm.runInNewContext(fs.readFileSync(new URL('../web/custom-sdk.js',import.meta.url),'utf8'),{window,parent,document:{addEventListener(){}},console,setTimeout,clearTimeout,crypto:{randomUUID:()=> 'isolated-id'}});
 const result=[];window.HandoverBridge.onRestore((payload,receipt)=>{result.push(JSON.parse(JSON.stringify({payload,receipt})));payload.answers.choice='local mutation';});
 const saved={seq:1,pageHash:'synthetic-hash',payload:{answers:{choice:'keep'},nested:[1,{a:true}]}};
 events.message({source:{},origin,data:{type:'handover:init',channel:'bad',lastFeedback:saved}});assert.equal(result.length,0);
 events.message({source:parent,origin:'https://other.invalid',data:{type:'handover:init',channel:'bad',lastFeedback:saved}});assert.equal(result.length,0);
 events.message({source:parent,origin,data:{type:'handover:init',channel:'isolated-channel',lastFeedback:saved}});
 assert.equal(result[0].payload.answers.choice,'keep');assert.equal((await window.HandoverBridge.getFeedback()).payload.answers.choice,'keep');
 const late=[];window.HandoverBridge.onRestore(payload=>late.push(payload.answers.choice));assert.deepEqual(late,['keep']);
 events.message({source:parent,origin,data:{type:'handover:init',channel:'new',lastFeedback:{payload:{different:true}}}});assert.equal(result.length,1);assert.equal(messages.length,0);
});

test('收到历史回执前的新编辑不会被自动回填覆盖',()=>{
 const events={},messages=[],parent={postMessage:message=>messages.push(message)},window={__HANDOVER_BRIDGE__:{origin:'https://isolated.example'},addEventListener:(name,fn)=>{events[name]=fn;}};
 vm.runInNewContext(fs.readFileSync(new URL('../web/custom-sdk.js',import.meta.url),'utf8'),{window,parent,document:{addEventListener(){}},console,setTimeout,clearTimeout});
 let restored=0;window.HandoverBridge.onRestore(()=>restored++);window.HandoverBridge.markDirty();
 events.message({source:parent,origin:'https://isolated.example',data:{type:'handover:init',channel:'test-channel',lastFeedback:{seq:1,payload:{old:true}}}});
 window.HandoverBridge.onRestore(()=>restored++);assert.equal(restored,0);assert.deepEqual(messages.map(message=>message.type),['handover:dirty']);
});
