import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'handover-retired-client-')),calls=[];
  const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;calls.push({url:req.url,headers:req.headers,body:body?JSON.parse(body):undefined});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,service:'handover-ui',customPage:{version:1}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`,config=path.join(dir,'config.json'),secret='synthetic-old-secret-never-transmit';
  fs.writeFileSync(config,JSON.stringify({serverUrl:url,agentToken:secret,preserved:{unchanged:true}}),{mode:0o600});
  const env={...process.env,HANDOVER_CONFIG:config,HANDOVER_SERVER_URL:url,HANDOVER_STATE_DIR:path.join(dir,'state'),HANDOVER_AGENT_TOKEN:secret,HANDOVER_SKIP_UPDATE:'1',HANDOVER_NO_OPEN:'1',CODEX_THREAD_ID:'retirement-test-source'};delete env.HANDOVER_USERNAME;
  const run=(args,extra={},input='')=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.resolve('skills/grill-with-ui/scripts/handover.mjs'),...args],{env:{...env,...extra},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr,data:JSON.parse(stdout)}));child.stdin.on('error',()=>{});child.stdin.end(input);});
  return {dir,url,config,secret,calls,run};
}

test('retired Agent config ignored: Xpy default and explicit username, no secret transmission or file migration',async(t)=>{
  const f=await fixture(t),before=fs.readFileSync(f.config,'utf8');
  const shown=await f.run(['config','--show']);assert.equal(shown.code,0);assert.equal(shown.data.username,'Xpy');assert.equal(shown.data.tokenConfigured,undefined);assert.ok(!shown.stdout.includes(f.secret));
  assert.equal((await f.run(['probe'])).code,0);assert.equal(f.calls[0].headers['x-handover-username'],'Xpy');assert.equal(f.calls[0].headers.authorization,undefined);
  assert.equal((await f.run(['probe'],{HANDOVER_USERNAME:'ExplicitUser'})).code,0);assert.equal(f.calls[1].headers['x-handover-username'],'ExplicitUser');assert.ok(!JSON.stringify(f.calls).includes(f.secret));
  assert.equal((await f.run(['home'])).data.url,f.url+'/?username=Xpy');assert.equal(f.calls.length,2);assert.equal(fs.readFileSync(f.config,'utf8'),before);
  assert.equal((await f.run(['config','--username','ConfiguredUser'])).code,0);const saved=JSON.parse(fs.readFileSync(f.config,'utf8'));assert.equal(saved.agentToken,f.secret);assert.deepEqual(saved.preserved,{unchanged:true});
});

test('schema 1 is archived: all commands fail before network/update, preserve handle and config',async(t)=>{
  const f=await fixture(t),handle=path.join(f.dir,'old.json'),marker=path.join(f.dir,'unexpected-update');
  const bin=path.join(f.dir,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'gh'),`#!/bin/sh\nprintf touched > '${marker}'\nexit 1\n`,{mode:0o700});
  const old=JSON.stringify({schema:1,id:'archived-request',requestToken:f.secret,source:{session:'retirement-test-source'},serverUrl:f.url,registered:false,creation:{secret:f.secret},cursor:2});fs.writeFileSync(handle,old,{mode:0o600});const before=fs.readFileSync(f.config,'utf8');
  for(const command of ['resume','open','state','wait','pending','patch','ack','finish','cancel','visual']){const r=await f.run([command,'--handle',handle],{HANDOVER_SKIP_UPDATE:'',HANDOVER_UPDATE_CHECKED:'',PATH:bin+path.delimiter+process.env.PATH});assert.equal(r.code,1,command);assert.match(r.data.error,/归档/);assert.ok(!r.stdout.includes(f.secret));assert.equal(fs.readFileSync(handle,'utf8'),old);}
  assert.equal(f.calls.length,0);assert.equal(fs.existsSync(marker),false);assert.equal(fs.readFileSync(f.config,'utf8'),before);assert.equal(fs.existsSync(path.join(f.dir,'state')),false);
});

test('retired token-stdin rejects without printing secrets or rewriting saved config',async(t)=>{
  const f=await fixture(t),before=fs.readFileSync(f.config,'utf8'),r=await f.run(['config','--token-stdin','--username','Changed'],{},f.secret+'\n');
  assert.equal(r.code,1);assert.match(r.data.error,/停用/);assert.ok(!r.stdout.includes(f.secret));assert.ok(!r.stderr.includes(f.secret));assert.equal(f.calls.length,0);assert.equal(fs.readFileSync(f.config,'utf8'),before);
});
