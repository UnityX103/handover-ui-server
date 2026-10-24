import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appCode = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
async function home(search = '', hash = '') {
  const elements = new Map(), calls = [], replaced = [], assigned = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, value: ['kind','status'].includes(id) ? 'all' : '', textContent: '', addEventListener() {}, setAttribute() {} });
    return elements.get(id);
  };
  const sandbox = {
    document: { getElementById: get, hidden: false }, navigator: { onLine: true },
    location: { search, hash, pathname: '/', replace: (url) => replaced.push(url), assign: (url) => assigned.push(url) },
    history: { replaceState() {} }, window: { addEventListener() {} }, setInterval() {}, URLSearchParams,
    fetch: async (path, options) => {
      calls.push({path,options});
      const username = options.headers?.['X-Handover-Username'];
      return { ok: true, json: async () => path === '/api/me' ? { authenticated: false, version: 'test-version', ...(username ? {mode:'username',username} : {}) } : { requests: [{id:'test-request',kind:'help',topic:'Test',source:{session:'source-test'},status:'waiting',created:'2026-01-01T00:00:00Z'}] } };
    },
  };
  vm.createContext(sandbox); vm.runInContext(appCode, sandbox);
  await new Promise(setImmediate);
  return { sandbox, elements, calls, replaced, assigned };
}

test('username home exposes only its public namespace and ignores owner ticket', async () => {
  const h = await home('?username=Xpy', '#ticket=must-not-use');
  assert.deepEqual(h.calls.map((c) => c.path), ['/api/me','/api/requests']);
  assert.ok(h.calls.every((c) => c.options.headers['X-Handover-Username'] === 'Xpy'));
  assert.equal(h.elements.get('workspace').hidden, false);
  assert.equal(h.elements.get('settings-toggle').hidden, true);
  assert.match(h.elements.get('requests').innerHTML, /\/grill\/test-request\/\?username=Xpy/);
  await assert.rejects(vm.runInContext("api('/api/login-code',{})",h.sandbox), /不提供登录/);
});

test('legacy home remains login-gated and username selector defaults to Xpy', async () => {
  const h = await home();
  assert.deepEqual(h.calls.map((c) => c.path), ['/api/me']);
  assert.equal(h.elements.get('login').hidden, false);
  assert.equal(h.elements.get('workspace').hidden, true);
  assert.equal(h.elements.get('username').value, 'Xpy');
});

test('username redirect and selector keep explicit scope', async () => {
  const h = await home('?username=Xpy&request=test-request');
  assert.deepEqual(h.replaced, ['/grill/test-request/?username=Xpy']);
  h.elements.get('username').value = 'Another-user';
  h.elements.get('username-form').onsubmit({preventDefault(){}});
  assert.deepEqual(h.assigned, ['/?username=Another-user']);
});

test('question return state is scoped by username', () => {
  const code = fs.readFileSync(new URL('../web/grill-bridge.js', import.meta.url), 'utf8');
  const destinations = [], storage = new Map([['handover:return:/grill/test-request/?username=Xpy','2'],['handover:return:/grill/test-request/?username=Other','5']]);
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
    crypto:{randomUUID:()=> 'isolated-channel'},localStorage:{getItem:(key)=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:(key)=>storage.delete(key)},window:{addEventListener(){}},setTimeout(){},
    fetch:async(path)=>{calls.push(path);return {ok:true,json:async()=>({topic:'test',handled:0,page:{feedbackType:'test',pageHash:'hash'},maxFeedbackBytes:1000})};},
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/custom.js',import.meta.url),'utf8'),sandbox);
  await new Promise(setImmediate);
  assert.deepEqual(calls,['/grill/test-request/bridge?username=Xpy','/grill/test-request/bridge?username=Xpy']);
  assert.equal(nodes.get('#page').src,'/grill/test-request/content?username=Xpy');
  assert.equal(nodes.get('header a').href,'/?username=Xpy');
});
