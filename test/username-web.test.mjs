import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appCode = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
async function home(search = '', hash = '', saved = null, delayList = null, oldSession = null) {
  const storage = new Map(saved !== null ? [['handover:username',saved]] : []), oldStorage = new Map(oldSession ? [['handover:username',oldSession]] : []), listeners = {};
  const elements = new Map(), calls = [], replaced = [], assigned = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, value: ['kind','status'].includes(id) ? 'all' : '', textContent: '', addEventListener() {}, setAttribute() {} });
    return elements.get(id);
  };
  const sandbox = {
    document: { getElementById: get, hidden: false }, navigator: { onLine: true },
    location: { search, hash, pathname: '/', replace: (url) => replaced.push(url), assign: (url) => assigned.push(url) },
    history: { replaceState() {} }, localStorage: {getItem:(key)=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:(key)=>storage.delete(key)}, sessionStorage:{getItem:key=>oldStorage.get(key),removeItem:key=>oldStorage.delete(key)}, window: { HandoverPush:{epoch:()=> '0',transaction:async(fn)=>fn(),login:async(name,fn)=>fn(),clear:async()=>{},bind:async(name,fn)=>fn(),marker:()=>null,remember:async()=>{},restore:()=>{},active:async()=>{}}, addEventListener:(name,fn)=>{listeners[name]=fn;} }, atob, setInterval() {}, setTimeout, clearTimeout, AbortController, URLSearchParams,
    fetch: async (path, options) => {
      calls.push({path,options});
      if (path === '/api/requests' && delayList) await delayList;
      const username = options.headers?.['X-Handover-Username'];
      return { ok: true, json: async () => path === '/api/me' ? { authenticated: false, version: 'test-version', ...(username ? {mode:'username',username,vapidPublicKey:'AQID'} : {}) } : { requests: [{id:'test-request',kind:'help',topic:'Test',source:{session:'source-test'},status:'waiting',created:'2026-01-01T00:00:00Z'}] } };
    },
  };
  vm.createContext(sandbox); vm.runInContext(appCode, sandbox);
  await new Promise(setImmediate);
  return { sandbox, elements, calls, replaced, assigned, storage, oldStorage, listeners };
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
    assert.ok(!h.storage.get('handover:username'));
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
  await reload.elements.get('username-logout').onclick();assert.ok(!reload.storage.get('handover:username'));assert.deepEqual(reload.replaced,['/']);assert.equal(reload.elements.get('username').value,'');
});
test('deep link requires matching deliberate login and never switches active user', async () => {
  const h=await home('?username=Xpy&request=test-request');
  h.elements.get('username').value='Other';await h.elements.get('username-form').onsubmit({preventDefault(){}});assert.ok(!h.storage.get('handover:username'));
  h.elements.get('username').value='Xpy';await h.elements.get('username-form').onsubmit({preventDefault(){}});assert.deepEqual(h.assigned,['/?username=Xpy&request=test-request']);
  const mismatch=await home('?username=Other&request=test-request','','Xpy');assert.equal(mismatch.calls.length,0);assert.match(mismatch.elements.get('message').textContent,/不会自动切换/);assert.equal(mismatch.storage.get('handover:username'),'Xpy');
  const same=await home('?username=Xpy&request=test-request','','Xpy');assert.deepEqual(same.replaced,['/grill/test-request/?username=Xpy']);
});
test('legacy login remains separate and username cancellation has no session side effect', async () => {
  const h=await home('?mode=legacy');assert.deepEqual(h.calls.map(c=>c.path),['/api/me']);assert.equal(h.elements.get('login').hidden,false);assert.equal(h.elements.get('username-panel').hidden,true);
  const cancelled=await home('?username=Xpy');cancelled.elements.get('username').value='Unsubmitted';assert.ok(!cancelled.storage.get('handover:username'));assert.equal(cancelled.calls.length,0);
});
test('logout wins over an in-flight inbox response and pageshow rejects stale tab state', async () => {
  let release;const pending=new Promise(resolve=>{release=resolve;});const h=await home('?username=Xpy','','Xpy',pending);
  await h.elements.get('username-logout').onclick();release();await new Promise(setImmediate);assert.equal(h.elements.get('requests').innerHTML,'');assert.equal(h.elements.get('workspace').hidden,true);
  const restored=await home('?username=Xpy','','Xpy');restored.storage.clear();restored.listeners.pageshow();assert.deepEqual(restored.replaced,['/']);assert.equal(restored.elements.get('workspace').hidden,true);
});

test('question return state is scoped by username', () => {
  const code = fs.readFileSync(new URL('../web/grill-bridge.js', import.meta.url), 'utf8');
  const destinations = [], storage = new Map([['handover:username','Xpy'],['handover:return:/grill/test-request/?username=Xpy','2'],['handover:return:/grill/test-request/?username=Other','5']]);
  const sandbox = {location:{pathname:'/grill/test-request/',search:'?username=Xpy',replace:(v)=>destinations.push(v)},URLSearchParams,navigator:{},document:{addEventListener(){}},localStorage:{getItem:k=>storage.get(k)},sessionStorage:{getItem:(k)=>storage.get(k),removeItem:(k)=>storage.delete(k)},stagedCount:()=>0,typedAnswers:()=>[]};
  vm.createContext(sandbox);vm.runInContext(code,sandbox);vm.runInContext('handoverReturnWhenAcknowledged({agent:{handled:2}})',sandbox);
  assert.deepEqual(destinations,['/?username=Xpy']);
  assert.equal(storage.get('handover:return:/grill/test-request/?username=Other'),'5');
});

test('custom page scopes metadata, iframe, persisted replies and return URL', async () => {
  const calls = [], destinations = [], storage = new Map([['handover:username','Xpy']]);
  const nodes = new Map();
  for (const selector of ['meta[name="handover-request"]','#page','#status','#retry','#cancel-request','#title','header a']) nodes.set(selector,{content:'test-request',addEventListener(){},contentWindow:{postMessage(){}}});
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
  const sandbox={URLSearchParams,location:{pathname:'/grill/test-request/',search:'?username=Xpy',replace:url=>destinations.push(url)},navigator:{},sessionStorage:{getItem:()=>null,removeItem(){}},localStorage:{getItem:k=>k==='draft'?draft.get(k):storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},window:{addEventListener(){},confirm:()=>confirmed},document:{documentElement:{},createElement:()=>({}),querySelector:()=>({append:value=>{button=value;}})}};
  vm.runInNewContext(code,sandbox);button.onclick();assert.equal(storage.get('handover:username'),'Xpy');assert.equal(destinations.length,0);
  confirmed=true;await button.onclick();assert.ok(!storage.get('handover:username'));assert.deepEqual(destinations,['/']);assert.equal(draft.get('draft'),'keep');
});

test('custom deep link without deliberate session does not load private-shaped content', async () => {
  const destinations=[],calls=[];const nodes=new Map([['meta[name="handover-request"]',{content:'test-request'}],['#page',{}],['#status',{}],['#retry',{}]]);
  const sandbox={document:{querySelector:key=>nodes.get(key)},location:{search:'?username=Xpy',replace:url=>destinations.push(url)},URLSearchParams,localStorage:{getItem:()=>null},sessionStorage:{getItem:()=>null},fetch:async(url)=>calls.push(url)};
  vm.runInNewContext(fs.readFileSync(new URL('../web/custom.js',import.meta.url),'utf8'),sandbox);await new Promise(setImmediate);
  assert.deepEqual(calls,[]);assert.deepEqual(destinations,['/?username=Xpy&request=test-request']);
});

test('failed connection does not remember username and canceled login cannot later succeed', async () => {
  const failed=await home();failed.sandbox.fetch=async()=>{throw new Error('offline');};failed.elements.get('username').value='Xpy';
  await failed.elements.get('username-form').onsubmit({preventDefault(){}});assert.ok(!failed.storage.get('handover:username'));assert.equal(failed.assigned.length,0);assert.match(failed.elements.get('message').textContent,/尚未登录/);
  const canceled=await home();let complete;canceled.sandbox.fetch=()=>new Promise(resolve=>{complete=resolve;});canceled.elements.get('username').value='Xpy';
  const pending=canceled.elements.get('username-form').onsubmit({preventDefault(){}});canceled.elements.get('username-cancel').onclick();complete({ok:true,json:async()=>({mode:'username',username:'Xpy'})});await pending;
  assert.ok(!canceled.storage.get('handover:username'));assert.equal(canceled.assigned.length,0);
});

test('delayed question submit and acknowledgement callbacks do nothing after logout', () => {
 const storage=new Map([['handover:username','Xpy']]),local=new Map(),destinations=[];
 const sandbox={location:{pathname:'/grill/test-request/',search:'?username=Xpy',replace:url=>destinations.push(url)},URLSearchParams,navigator:{},document:{addEventListener(){}},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},localStorage:{getItem:key=>key==='handover:username'?storage.get(key):local.get(key),setItem:(key,value)=>local.set(key,value)},stagedCount:()=>0,typedAnswers:()=>[]};
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
 assert.equal(subscribed,0);assert.ok(!h.calls.some(c=>c.path==='/api/subscriptions'));assert.ok(!h.storage.get('handover:username'));
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
 const sent=h.calls.find(call=>call.path==='/api/subscriptions');assert.ok(sent);assert.equal(sent.options.headers['X-Handover-Username'],'Xpy');assert.deepEqual(JSON.parse(sent.options.body),subscription);assert.deepEqual(remembered.at(-1),['Xpy',subscription.endpoint]);assert.match(h.elements.get('push').textContent,/已开启/);
});

test('fresh-tab login may remember another username without automatically rebinding device', async () => {
 const h=await home();h.sandbox.window.HandoverPush.marker=()=>({username:'Original',endpoint:'opaque'});h.elements.get('username').value='Other';await h.elements.get('username-form').onsubmit({preventDefault(){}});
 assert.equal(h.calls.length,1);assert.equal(h.storage.get('handover:username'),'Other');assert.equal(h.sandbox.window.HandoverPush.marker().username,'Original');
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
 const h=await home();const active=[];h.sandbox.navigator.serviceWorker={};h.sandbox.window.HandoverPush.active=async(value)=>{assert.ok(!h.storage.get('handover:username'));active.push(value);};h.elements.get('username').value='Xpy';await h.elements.get('username-form').onsubmit({preventDefault(){}});
 assert.deepEqual(active,[null]);assert.equal(h.storage.get('handover:username'),'Xpy');
});

test('real coordinator never holds a binding lock while native permission is unanswered', async () => {
 const h=await home('?username=Xpy','','Xpy');let grant,locks=0;h.sandbox.MessageChannel=MessageChannel;const device=new Map([['handover:username','Xpy']]);h.sandbox.localStorage={getItem:k=>device.get(k),setItem:(k,v)=>device.set(k,v)};
 h.sandbox.navigator.locks={request:async(name,fn)=>{locks++;return fn();}};
 h.sandbox.navigator.serviceWorker={addEventListener(){},ready:Promise.resolve({active:{postMessage(){}},pushManager:{getSubscription:async()=>{throw new Error('must not subscribe');}}})};
 vm.runInContext(fs.readFileSync(new URL('../web/navigation.js',import.meta.url),'utf8'),h.sandbox);
 h.sandbox.window.PushManager={};h.sandbox.window.Notification={};h.sandbox.Notification={requestPermission:()=>new Promise(resolve=>{grant=resolve;})};
 const enabling=h.elements.get('push').onclick();await new Promise(setImmediate);assert.equal(locks,0);
 await h.elements.get('username-logout').onclick();assert.ok(!device.get('handover:username'));grant('granted');await enabling;assert.equal(locks,1);
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
 const h=await home('?username=Xpy','','Xpy');const values=new Map([['handover:username','Xpy']]);let grant,registrations=0;
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

test('legacy logout completes only after device lock, server revocation and worker acknowledgement', async () => {
 const h=await home('?mode=legacy');let releaseLock,releaseWorker,authenticated=true;
 const lock=new Promise(resolve=>{releaseLock=resolve;}),worker=new Promise(resolve=>{releaseWorker=resolve;});
 const phases=[];
 h.sandbox.window.HandoverPush.transaction=async work=>{await lock;phases.push('locked');return work();};
 h.sandbox.window.HandoverPush.active=async()=>{phases.push('worker-start');await worker;phases.push('worker-complete');};
 h.sandbox.navigator.serviceWorker={};
 h.sandbox.fetch=async path=>{if(path==='/api/logout'){authenticated=false;phases.push('revoked');return{ok:true,json:async()=>({ok:true})};}return{ok:true,json:async()=>({authenticated,version:'test-version'})};};
 h.elements.get('login').hidden=true;h.elements.get('workspace').hidden=false;
 const completion=h.elements.get('logout').onclick();
 assert.equal(h.elements.get('logout').disabled,true);assert.equal(authenticated,true);assert.deepEqual(phases,[]);
 releaseLock();await new Promise(setImmediate);
 assert.equal(authenticated,false);assert.equal(h.elements.get('login').hidden,true);assert.equal(h.elements.get('logout').disabled,true);
 releaseWorker();await completion;
 assert.deepEqual(phases,['locked','revoked','worker-start','worker-complete']);
 assert.equal(h.elements.get('login').hidden,false);assert.equal(h.elements.get('workspace').hidden,true);assert.equal(h.elements.get('logout').disabled,false);
});

test('remembered username survives a fresh visit and same-user deep link without login', async () => {
 const first=await home();first.elements.get('username').value='Xpy';await first.elements.get('username-form').onsubmit({preventDefault(){}});
 const next=await home('?username=Xpy&request=test-request','',first.storage.get('handover:username'));
 assert.equal(next.elements.get('username-panel').hidden,true);assert.deepEqual(next.replaced,['/grill/test-request/?username=Xpy']);assert.equal(next.oldStorage.size,0);
 const different=await home('?username=Other','','Xpy');assert.equal(different.calls.length,0);assert.equal(different.storage.get('handover:username'),'Xpy');
});

test('session username migrates once but persistent logout tombstone defeats old tabs', async () => {
 const migrated=await home('?username=Xpy','',null,null,'Xpy');assert.equal(migrated.storage.get('handover:username'),'Xpy');assert.equal(migrated.oldStorage.size,0);
 const loggedOut=await home('?username=Xpy','','',null,'Xpy');assert.equal(loggedOut.storage.get('handover:username'),'');assert.equal(loggedOut.oldStorage.size,0);assert.equal(loggedOut.calls.length,0);assert.equal(loggedOut.elements.get('username').value,'');
});

test('cross-tab persistent change immediately hides inbox and same-name epoch prevents stale restoration', async () => {
 const h=await home('?username=Xpy','','Xpy');h.storage.set('handover:identity-epoch','2');h.listeners.storage({key:'handover:identity-epoch'});assert.equal(h.elements.get('workspace').hidden,true);assert.deepEqual(h.replaced,['/']);
 const restored=await home('?username=Xpy','','Xpy');restored.storage.set('handover:identity-epoch','1');restored.listeners.pageshow();assert.equal(restored.elements.get('workspace').hidden,true);
});

test('explicit device opt-in rebinds possessed subscription and known failure restores old marker', async () => {
 for (const success of [true,false]) {
  const h=await home('?username=Xpy','','Xpy');let marker={username:'Other',endpoint:'https://push.invalid/existing'};const before=marker,active=[];
  const sub={endpoint:marker.endpoint,keys:{auth:'owned-auth',p256dh:'owned-key'}};
  h.sandbox.navigator.serviceWorker={ready:Promise.resolve({pushManager:{getSubscription:async()=>({endpoint:sub.endpoint,toJSON:()=>sub})}})};h.sandbox.window.PushManager={};h.sandbox.window.Notification={};h.sandbox.Notification={requestPermission:async()=> 'granted'};
  Object.assign(h.sandbox.window.HandoverPush,{marker:()=>marker,remember:async(username,endpoint,pending=false,previous=null)=>{marker={username,endpoint,...(pending?{pending,previous}:{})};},restore:()=>{marker=marker.previous;},active:async(value)=>active.push(value)});
  const original=h.sandbox.fetch;h.sandbox.fetch=async(path,options)=>path==='/api/subscriptions'?{ok:success,status:success?200:409,json:async()=>({error:'proof mismatch'})}:original(path,options);
  assert.equal(marker.username,'Other');await h.elements.get('push').onclick();
  if(success){assert.equal(marker.username,'Xpy');assert.equal(marker.pending,undefined);assert.deepEqual(active,['Xpy']);}else{assert.deepEqual(marker,before);assert.deepEqual(active,[]);}
 }
});

test('stale same-name logout cannot delete a newer identity binding inside device lock', async () => {
 const state=new Map([['handover:username','Xpy'],['handover:identity-epoch','2'],['handover:push-binding',JSON.stringify({username:'Xpy',endpoint:'owned'})]]),calls=[];
 const sandbox={window:{},location:{pathname:'/'},navigator:{locks:{request:async(name,fn)=>fn()}},localStorage:{getItem:key=>state.get(key),setItem:(key,value)=>state.set(key,value),removeItem:key=>state.delete(key)},fetch:async(...args)=>{calls.push(args);}};
 vm.runInNewContext(fs.readFileSync(new URL('../web/navigation.js',import.meta.url),'utf8'),sandbox);await sandbox.window.HandoverPush.clear('Xpy','1');
 assert.equal(calls.length,0);assert.equal(JSON.parse(state.get('handover:push-binding')).username,'Xpy');assert.equal(state.get('handover:push-epoch'),undefined);
 const h=await home('?username=Xpy','','Xpy');let finish;h.sandbox.window.HandoverPush.clear=()=>new Promise(resolve=>{finish=resolve;});const logout=h.elements.get('username-logout').onclick();h.storage.set('handover:identity-epoch','1');finish();await logout;assert.equal(h.storage.get('handover:username'),'Xpy');
});

test('reply categories distinguish sent awaiting agent after ack from questions awaiting user', async () => {
 const h=await home('?username=Xpy','','Xpy');
 const records=[{id:'test-user',topic:'USER_PENDING',status:'waiting',waitingFor:'user'},{id:'test-agent',topic:'AGENT_AFTER_ACK',status:'waiting',waitingFor:'agent'},{id:'test-legacy',topic:'LEGACY_SENT',status:'submitted'},{id:'test-done',topic:'FINISHED',status:'completed',waitingFor:'agent'}].map(row=>({...row,kind:'help',source:{session:'test'},created:'2026-01-01T00:00:00Z'}));
 vm.runInContext('requests='+JSON.stringify(records),h.sandbox);
 h.elements.get('status').value='sent';vm.runInContext('render()',h.sandbox);const sent=h.elements.get('requests').innerHTML;assert.match(sent,/AGENT_AFTER_ACK/);assert.match(sent,/LEGACY_SENT/);assert.doesNotMatch(sent,/USER_PENDING|FINISHED/);assert.match(sent,/已发送，等待回复/);
 h.elements.get('status').value='waiting';vm.runInContext('render()',h.sandbox);assert.match(h.elements.get('requests').innerHTML,/USER_PENDING/);assert.doesNotMatch(h.elements.get('requests').innerHTML,/AGENT_AFTER_ACK|LEGACY_SENT/);
});
