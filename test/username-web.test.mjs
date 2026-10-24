import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appCode = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
async function home(search = '', hash = '', saved = null, delayList = null) {
  const storage = new Map(saved ? [['handover:username',saved]] : []), listeners = {};
  const elements = new Map(), calls = [], replaced = [], assigned = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, value: ['kind','status'].includes(id) ? 'all' : '', textContent: '', addEventListener() {}, setAttribute() {} });
    return elements.get(id);
  };
  const sandbox = {
    document: { getElementById: get, hidden: false }, navigator: { onLine: true },
    location: { search, hash, pathname: '/', replace: (url) => replaced.push(url), assign: (url) => assigned.push(url) },
    history: { replaceState() {} }, sessionStorage: {getItem:(key)=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:(key)=>storage.delete(key)}, window: { HandoverPush:{epoch:()=> '0',transaction:async(fn)=>fn(),login:async(name,fn)=>fn(),clear:async()=>{},bind:async(name,fn)=>fn(),marker:()=>null,remember:async()=>{},active:async()=>{}}, addEventListener:(name,fn)=>{listeners[name]=fn;} }, atob, setInterval() {}, setTimeout, clearTimeout, AbortController, URLSearchParams,
    fetch: async (path, options) => {
      calls.push({path,options});
      if (path === '/api/requests' && delayList) await delayList;
      const username = options.headers?.['X-Handover-Username'];
      return { ok: true, json: async () => path === '/api/me' ? { authenticated: false, version: 'test-version', ...(username ? {mode:'username',username,vapidPublicKey:'AQID'} : {}) } : { requests: [{id:'test-request',kind:'help',topic:'Test',source:{session:'source-test'},status:'waiting',created:'2026-01-01T00:00:00Z'}] } };
    },
  };
  vm.createContext(sandbox); vm.runInContext(appCode, sandbox);
  await new Promise(setImmediate);
  return { sandbox, elements, calls, replaced, assigned, storage, listeners };
}

test('username home exposes only its public namespace and ignores owner ticket', async () => {
  const h = await home('?username=Xpy', '#ticket=must-not-use', 'Xpy');
  assert.deepEqual(h.calls.map((c) => c.path), ['/api/me','/api/requests']);
  assert.ok(h.calls.every((c) => c.options.headers['X-Handover-Username'] === 'Xpy'));
  assert.equal(h.elements.get('workspace').hidden, false);
  assert.equal(h.elements.get('settings-toggle').hidden, false);
  assert.match(h.elements.get('requests').innerHTML, /\/grill\/test-request\/\?username=Xpy/);
  await assert.rejects(vm.runInContext("api('/api/login-code',{})",h.sandbox), /不提供登录/);
});

test('blank home never logs in from URL and input has no default', async () => {
  for (const search of ['', '?username=Xpy']) {
    const h = await home(search);
    assert.equal(h.calls.length,0);
    assert.equal(h.elements.get('username').value,'');
    assert.equal(h.elements.get('workspace').hidden,true);
    assert.equal(h.elements.get('username-panel').hidden,false);
    assert.equal(h.storage.size,0);
  }
});
test('explicit submit remembers name, reload hides input, logout permits switching', async () => {
  const h = await home(); h.elements.get('username').value='Xpy';
  await h.elements.get('username-form').onsubmit({preventDefault(){}});
  assert.equal(h.storage.get('handover:username'),'Xpy');assert.deepEqual(h.assigned,['/?username=Xpy']);
  const reload=await home('', '', 'Xpy');
  assert.equal(reload.elements.get('username-panel').hidden,true);
  assert.equal(reload.elements.get('username-logout').hidden,false);
  reload.elements.get('username').value='Other';await reload.elements.get('username-form').onsubmit({preventDefault(){}});
  assert.equal(reload.storage.get('handover:username'),'Xpy');assert.equal(reload.assigned.length,0);
  await reload.elements.get('username-logout').onclick();assert.equal(reload.storage.size,0);assert.deepEqual(reload.replaced,['/']);assert.equal(reload.elements.get('username').value,'');
});
test('deep link requires matching deliberate login and never switches active user', async () => {
  const h=await home('?username=Xpy&request=test-request');
  h.elements.get('username').value='Other';await h.elements.get('username-form').onsubmit({preventDefault(){}});assert.equal(h.storage.size,0);
  h.elements.get('username').value='Xpy';await h.elements.get('username-form').onsubmit({preventDefault(){}});assert.deepEqual(h.assigned,['/?username=Xpy&request=test-request']);
  const mismatch=await home('?username=Other&request=test-request','','Xpy');assert.equal(mismatch.calls.length,0);assert.match(mismatch.elements.get('message').textContent,/不会自动切换/);assert.equal(mismatch.storage.get('handover:username'),'Xpy');
  const same=await home('?username=Xpy&request=test-request','','Xpy');assert.deepEqual(same.replaced,['/grill/test-request/?username=Xpy']);
});
test('legacy login remains separate and username cancellation has no session side effect', async () => {
  const h=await home('?mode=legacy');assert.deepEqual(h.calls.map(c=>c.path),['/api/me']);assert.equal(h.elements.get('login').hidden,false);assert.equal(h.elements.get('username-panel').hidden,true);
  const cancelled=await home('?username=Xpy');cancelled.elements.get('username').value='Unsubmitted';assert.equal(cancelled.storage.size,0);assert.equal(cancelled.calls.length,0);
});
test('logout wins over an in-flight inbox response and pageshow rejects stale tab state', async () => {
  let release;const pending=new Promise(resolve=>{release=resolve;});const h=await home('?username=Xpy','','Xpy',pending);
  await h.elements.get('username-logout').onclick();release();await new Promise(setImmediate);assert.equal(h.elements.get('requests').innerHTML,'');assert.equal(h.elements.get('workspace').hidden,true);
  const restored=await home('?username=Xpy','','Xpy');restored.storage.clear();restored.listeners.pageshow();assert.deepEqual(restored.replaced,['/']);assert.equal(restored.elements.get('workspace').hidden,true);
});

test('question return state is scoped by username', () => {
  const code = fs.readFileSync(new URL('../web/grill-bridge.js', import.meta.url), 'utf8');
  const destinations = [], storage = new Map([['handover:username','Xpy'],['handover:return:/grill/test-request/?username=Xpy','2'],['handover:return:/grill/test-request/?username=Other','5']]);
  const sandbox = {location:{pathname:'/grill/test-request/',search:'?username=Xpy',replace:(v)=>destinations.push(v)},URLSearchParams,navigator:{},document:{addEventListener(){}},sessionStorage:{getItem:(k)=>storage.get(k),removeItem:(k)=>storage.delete(k)},stagedCount:()=>0,typedAnswers:()=>[]};
  vm.createContext(sandbox);vm.runInContext(code,sandbox);vm.runInContext('handoverReturnWhenAcknowledged({agent:{handled:2}})',sandbox);
  assert.deepEqual(destinations,['/?username=Xpy']);
  assert.equal(storage.get('handover:return:/grill/test-request/?username=Other'),'5');
});

test('custom page scopes metadata, iframe, persisted replies and return URL', async () => {
  const calls = [], destinations = [], storage = new Map();
  const nodes = new Map();
  for (const selector of ['meta[name="handover-request"]','#page','#status','#retry','#title','header a']) nodes.set(selector,{content:'test-request',addEventListener(){},contentWindow:{postMessage(){}}});
  const sandbox = {
    document:{querySelector:(selector)=>nodes.get(selector)},location:{search:'?username=Xpy',replace:(url)=>destinations.push(url)},URLSearchParams,
    sessionStorage:{getItem:()=> 'Xpy'},crypto:{randomUUID:()=> 'isolated-channel'},localStorage:{getItem:(key)=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:(key)=>storage.delete(key)},window:{addEventListener(){}},setTimeout(){},
    fetch:async(path)=>{calls.push(path);return {ok:true,json:async()=>({topic:'test',handled:0,page:{feedbackType:'test',pageHash:'hash'},maxFeedbackBytes:1000})};},
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/custom.js',import.meta.url),'utf8'),sandbox);
  await new Promise(setImmediate);
  assert.deepEqual(calls,['/grill/test-request/bridge?username=Xpy','/grill/test-request/bridge?username=Xpy']);
  assert.equal(nodes.get('#page').src,'/grill/test-request/content?username=Xpy');
  assert.equal(nodes.get('header a').href,'/?username=Xpy');
});

test('question logout cancellation retains session and drafts; confirmation exits', async () => {
  const code=fs.readFileSync(new URL('../web/navigation.js',import.meta.url),'utf8');
  const storage=new Map([['handover:username','Xpy']]),draft=new Map([['draft','keep']]),destinations=[];let button,confirmed=false;
  const sandbox={URLSearchParams,location:{pathname:'/grill/test-request/',search:'?username=Xpy',replace:url=>destinations.push(url)},navigator:{},sessionStorage:{getItem:key=>storage.get(key),removeItem:key=>storage.delete(key)},localStorage:draft,window:{addEventListener(){},confirm:()=>confirmed},document:{documentElement:{},createElement:()=>({}),querySelector:()=>({append:value=>{button=value;}})}};
  vm.runInNewContext(code,sandbox);button.onclick();assert.equal(storage.get('handover:username'),'Xpy');assert.equal(destinations.length,0);
  confirmed=true;await button.onclick();assert.equal(storage.size,0);assert.deepEqual(destinations,['/']);assert.equal(draft.get('draft'),'keep');
});

test('custom deep link without deliberate session does not load private-shaped content', async () => {
  const destinations=[],calls=[];const nodes=new Map([['meta[name="handover-request"]',{content:'test-request'}],['#page',{}],['#status',{}],['#retry',{}]]);
  const sandbox={document:{querySelector:key=>nodes.get(key)},location:{search:'?username=Xpy',replace:url=>destinations.push(url)},URLSearchParams,sessionStorage:{getItem:()=>null},fetch:async(url)=>calls.push(url)};
  vm.runInNewContext(fs.readFileSync(new URL('../web/custom.js',import.meta.url),'utf8'),sandbox);await new Promise(setImmediate);
  assert.deepEqual(calls,[]);assert.deepEqual(destinations,['/?username=Xpy&request=test-request']);
});

test('failed connection does not remember username and canceled login cannot later succeed', async () => {
  const failed=await home();failed.sandbox.fetch=async()=>{throw new Error('offline');};failed.elements.get('username').value='Xpy';
  await failed.elements.get('username-form').onsubmit({preventDefault(){}});assert.equal(failed.storage.size,0);assert.equal(failed.assigned.length,0);assert.match(failed.elements.get('message').textContent,/尚未登录/);
  const canceled=await home();let complete;canceled.sandbox.fetch=()=>new Promise(resolve=>{complete=resolve;});canceled.elements.get('username').value='Xpy';
  const pending=canceled.elements.get('username-form').onsubmit({preventDefault(){}});canceled.elements.get('username-cancel').onclick();complete({ok:true,json:async()=>({mode:'username',username:'Xpy'})});await pending;
  assert.equal(canceled.storage.size,0);assert.equal(canceled.assigned.length,0);
});

test('delayed question submit and acknowledgement callbacks do nothing after logout', () => {
 const storage=new Map([['handover:username','Xpy']]),local=new Map(),destinations=[];
 const sandbox={location:{pathname:'/grill/test-request/',search:'?username=Xpy',replace:url=>destinations.push(url)},URLSearchParams,navigator:{},document:{addEventListener(){}},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},localStorage:{getItem:key=>local.get(key),setItem:(key,value)=>local.set(key,value)},stagedCount:()=>0,typedAnswers:()=>[]};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(new URL('../web/grill-bridge.js',import.meta.url),'utf8'),sandbox);
 storage.delete('handover:username');vm.runInContext("handoverSubmissionReceived({ok:true,seq:1},[{type:'answer'}]); handoverReturnWhenAcknowledged({agent:{handled:1}})",sandbox);
 assert.equal(storage.size,0);assert.equal(local.size,0);assert.deepEqual(destinations,[]);
});

test('username notification permission is requested only by click, denied permission never binds', async () => {
 const h=await home('?username=Xpy','','Xpy');let permissions=0;
 h.sandbox.navigator.serviceWorker={ready:Promise.resolve({pushManager:{getSubscription:async()=>null}})};h.sandbox.window.PushManager={};h.sandbox.window.Notification={};h.sandbox.Notification={requestPermission:async()=>{permissions++;return 'denied';}};
 assert.equal(permissions,0);h.elements.get('push').onclick();await new Promise(setImmediate);
 assert.equal(permissions,1);assert.ok(!h.calls.some(c=>c.path==='/api/subscriptions'));assert.match(h.elements.get('message').textContent,/尚未获准/);
});

test('permission pending during logout never registers stale username', async () => {
 const h=await home('?username=Xpy','','Xpy');let grant,subscribed=0;
 h.sandbox.navigator.serviceWorker={ready:Promise.resolve({pushManager:{getSubscription:async()=>{subscribed++;return null;}}})};h.sandbox.window.PushManager={};h.sandbox.window.Notification={};h.sandbox.Notification={requestPermission:()=>new Promise(resolve=>{grant=resolve;})};
 h.elements.get('push').onclick();await new Promise(setImmediate);await h.elements.get('username-logout').onclick();grant('granted');await new Promise(setImmediate);
 assert.equal(subscribed,0);assert.ok(!h.calls.some(c=>c.path==='/api/subscriptions'));assert.equal(h.storage.size,0);
});

test('logout delete failure leaves session and offers retry', async () => {
 const h=await home('?username=Xpy','','Xpy');h.sandbox.window.HandoverPush.clear=async()=>{throw new Error('无法解除此设备通知绑定，尚未退出；请联网后重试');};
 await h.elements.get('username-logout').onclick();assert.equal(h.storage.get('handover:username'),'Xpy');assert.equal(h.replaced.length,0);assert.match(h.elements.get('message').textContent,/尚未退出/);
});

test('push coordinator waits for binding, deletes full capability and never unbinds another username', async () => {
 const values=new Map(),calls=[],messages=[];let finish;
 const subscription={endpoint:'https://push.invalid/device',toJSON:()=>({endpoint:'https://push.invalid/device',keys:{auth:'test',p256dh:'test-key'}})};
 const sandbox={window:{},MessageChannel,setTimeout,clearTimeout,location:{pathname:'/'},navigator:{locks:{request:async(name,fn)=>fn()},serviceWorker:{addEventListener(){},ready:Promise.resolve({active:{postMessage:(m,ports)=>{messages.push(m);ports?.[0]?.postMessage({ok:true});}},pushManager:{getSubscription:async()=>subscription}})}},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},fetch:async(url,options)=>{calls.push({url,options});return {ok:true};}};
 vm.runInNewContext(fs.readFileSync(new URL('../web/navigation.js',import.meta.url),'utf8'),sandbox);
 const manager=sandbox.window.HandoverPush;
 const binding=manager.bind('Xpy',async()=>{await new Promise(resolve=>{finish=resolve;});await manager.remember('Xpy',subscription.endpoint);});await new Promise(setImmediate);
 const clearing=manager.clear('Xpy');assert.equal(calls.length,0);finish();await binding;await clearing;
 assert.equal(calls.length,1);assert.equal(calls[0].options.method,'DELETE');assert.deepEqual(JSON.parse(calls[0].options.body),subscription.toJSON());assert.equal(manager.marker(),null);
 await manager.remember('Other',subscription.endpoint);await manager.clear('Xpy');assert.equal(calls.length,1);assert.equal(manager.marker().username,'Other');
});

test('explicit permission grant registers current username capability without owner routes', async () => {
 const h=await home('?username=Xpy','','Xpy');const subscription={endpoint:'https://push.invalid/test',keys:{auth:'auth',p256dh:'key'}};const remembered=[];
 h.sandbox.navigator.serviceWorker={ready:Promise.resolve({pushManager:{getSubscription:async()=>({endpoint:subscription.endpoint,toJSON:()=>subscription})}})};h.sandbox.window.PushManager={};h.sandbox.window.Notification={};h.sandbox.Notification={requestPermission:async()=> 'granted'};
 h.sandbox.window.HandoverPush.remember=async(...args)=>remembered.push(args);await h.elements.get('push').onclick();
 const sent=h.calls.find(call=>call.path==='/api/subscriptions');assert.ok(sent);assert.equal(sent.options.headers['X-Handover-Username'],'Xpy');assert.deepEqual(JSON.parse(sent.options.body),subscription);assert.deepEqual(remembered,[['Xpy',subscription.endpoint]]);assert.match(h.elements.get('push').textContent,/已开启/);
});

test('fresh-tab login cannot switch browser notification binding', async () => {
 const h=await home();h.sandbox.window.HandoverPush.marker=()=>({username:'Original',endpoint:'opaque'});h.elements.get('username').value='Other';await h.elements.get('username-form').onsubmit({preventDefault(){}});
 assert.equal(h.calls.length,0);assert.equal(h.storage.size,0);assert.match(h.elements.get('message').textContent,/原用户名退出/);
});

test('cross-tab clear waits for delayed bind before its marker exists and preserves next-user ordering', async () => {
 const storage=new Map(),active=[];let response,tail=Promise.resolve();const locks={request:(name,fn)=>{const operation=tail.then(fn);tail=operation.catch(()=>{});return operation;}};
 const sub={endpoint:'https://push.invalid/shared',toJSON:()=>({endpoint:'https://push.invalid/shared',keys:{auth:'a',p256dh:'p'}})};
 function tab(){const sandbox={window:{},MessageChannel,setTimeout,clearTimeout,location:{pathname:'/'},navigator:{locks,serviceWorker:{addEventListener(){},ready:Promise.resolve({active:{postMessage:(m,ports)=>{if(m.type==='handover:push-user'){active.push(m.username);ports[0].postMessage({ok:true});}}},pushManager:{getSubscription:async()=>sub}})}},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},fetch:async()=>({ok:true})};vm.runInNewContext(fs.readFileSync(new URL('../web/navigation.js',import.meta.url),'utf8'),sandbox);return sandbox.window.HandoverPush;}
 const a=tab(),b=tab();const first=a.bind('Xpy',async()=>{await new Promise(resolve=>{response=resolve;});await a.remember('Xpy',sub.endpoint);await a.active('Xpy');});await new Promise(setImmediate);
 const logout=b.clear('Xpy');await new Promise(setImmediate);const next=b.bind('Other',async()=>{await b.remember('Other',sub.endpoint);await b.active('Other');});response();await Promise.all([first,logout,next]);
 assert.deepEqual(active,['Xpy',null,'Other']);assert.equal(b.marker().username,'Other');
});

test('successful public login suppresses old legacy queue before session save when no public binding exists', async () => {
 const h=await home();const active=[];h.sandbox.navigator.serviceWorker={};h.sandbox.window.HandoverPush.active=async(value)=>{assert.equal(h.storage.size,0);active.push(value);};h.elements.get('username').value='Xpy';await h.elements.get('username-form').onsubmit({preventDefault(){}});
 assert.deepEqual(active,[null]);assert.equal(h.storage.get('handover:username'),'Xpy');
});

test('real coordinator never holds a binding lock while native permission is unanswered', async () => {
 const h=await home('?username=Xpy','','Xpy');let grant,locks=0;h.sandbox.MessageChannel=MessageChannel;const device=new Map();h.sandbox.localStorage={getItem:k=>device.get(k),setItem:(k,v)=>device.set(k,v)};
 h.sandbox.navigator.locks={request:async(name,fn)=>{locks++;return fn();}};
 h.sandbox.navigator.serviceWorker={addEventListener(){},ready:Promise.resolve({active:{postMessage(){}},pushManager:{getSubscription:async()=>{throw new Error('must not subscribe');}}})};
 vm.runInContext(fs.readFileSync(new URL('../web/navigation.js',import.meta.url),'utf8'),h.sandbox);
 h.sandbox.window.PushManager={};h.sandbox.window.Notification={};h.sandbox.Notification={requestPermission:()=>new Promise(resolve=>{grant=resolve;})};
 const enabling=h.elements.get('push').onclick();await new Promise(setImmediate);assert.equal(locks,0);
 await h.elements.get('username-logout').onclick();assert.equal(h.storage.size,0);grant('granted');await enabling;assert.equal(locks,1);
});

function pullGesture(h,{x=0,y=90,interactive=false}={}) {
 const start={touches:[{clientX:20,clientY:20}],target:{closest:()=>interactive?{}:null}};
 h.listeners.touchstart(start);h.listeners.touchmove({touches:[{clientX:20+x,clientY:20+y}]});h.listeners.touchend();
}
test('pull refresh requires top, vertical downward threshold and noninteractive origin', async () => {
 const h=await home('?username=Xpy','','Xpy');const initial=h.calls.length;
 h.sandbox.window.scrollY=20;pullGesture(h);h.sandbox.window.scrollY=0;
 pullGesture(h,{x:100,y:50});pullGesture(h,{y:-90});pullGesture(h,{y:50});pullGesture(h,{interactive:true});await new Promise(setImmediate);assert.equal(h.calls.length,initial);
 pullGesture(h);await new Promise(setImmediate);assert.equal(h.calls.length,initial+2);
});
test('pull refresh does not duplicate an in-flight refresh or revive a logged-out session', async () => {
 const h=await home('?username=Xpy','','Xpy');let release;const original=h.sandbox.fetch;h.sandbox.fetch=async(...args)=>{await new Promise(resolve=>{release=resolve;});return original(...args);};
 pullGesture(h);pullGesture(h);assert.ok(release);assert.equal(h.calls.length,2);
 await h.elements.get('username-logout').onclick();release();await new Promise(setImmediate);assert.equal(h.elements.get('workspace').hidden,true);assert.equal(h.elements.get('requests').innerHTML,'');
 const calls=h.calls.length;pullGesture(h);await new Promise(setImmediate);assert.equal(h.calls.length,calls);
});

test('other-tab device logout invalidates an unanswered permission prompt through shared epoch', async () => {
 const h=await home('?username=Xpy','','Xpy');const values=new Map();let grant,registrations=0;
 const device={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 h.sandbox.localStorage=device;h.sandbox.MessageChannel=MessageChannel;
 h.sandbox.navigator.locks={request:async(name,fn)=>fn()};
 h.sandbox.navigator.serviceWorker={addEventListener(){},ready:Promise.resolve({active:{postMessage(){}},pushManager:{getSubscription:async()=>{registrations++;return null;}}})};
 vm.runInContext(fs.readFileSync(new URL('../web/navigation.js',import.meta.url),'utf8'),h.sandbox);
 const other={window:{},location:{pathname:'/'},navigator:h.sandbox.navigator,localStorage:device};vm.runInNewContext(fs.readFileSync(new URL('../web/navigation.js',import.meta.url),'utf8'),other);
 h.sandbox.window.PushManager={};h.sandbox.window.Notification={};h.sandbox.Notification={requestPermission:()=>new Promise(resolve=>{grant=resolve;})};
 const enabling=h.elements.get('push').onclick();await new Promise(setImmediate);await other.window.HandoverPush.clear('Xpy');assert.equal(h.storage.get('handover:username'),'Xpy');grant('granted');await enabling;
 assert.equal(registrations,0);assert.ok(!h.calls.some(c=>c.path==='/api/subscriptions'));
});
