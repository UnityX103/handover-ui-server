import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installBundle } from '../skills/grill-with-ui/scripts/install.mjs';
import { updateSkills, publicGit, publicContents, publicRemote } from '../skills/grill-with-ui/scripts/update.mjs';

const oldVersion = 'a'.repeat(40), latestVersion = 'b'.repeat(40);
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('skills/manifest.json', root), 'utf8'));
const files = Object.fromEntries(manifest.files.map((file) => [file, fs.readFileSync(new URL(file, root), 'utf8')]));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const skillsDir = path.join(dir, 'skills'), backupsDir = path.join(dir, 'backups'), lockFile = path.join(dir, 'state/update.lock');
  fs.mkdirSync(path.join(skillsDir, 'grill-with-docs-ui'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'grill-with-docs-ui/SKILL.md'), 'existing composition');
  installBundle({ manifest, files, version: oldVersion, skillsDir, backupsDir });
  const calls = [];
  const git = async (args) => { calls.push(args); assert.deepEqual(args,['ls-remote',publicRemote,'refs/heads/main']); return latestVersion+'\trefs/heads/main\n'; };
  const contents = async (file, version) => {
    calls.push([file,version]); assert.equal(version,latestVersion);
    if(file==='skills/manifest.json')return JSON.stringify(manifest);
    assert.ok(Object.hasOwn(files,file),file);return files[file]+'\n';
  };
  return { dir, skillsDir, backupsDir, lockFile, git, contents, calls };
}

test('Skill 已是 GitHub main 最新版时，仅检查一次且不重复安装', async (t) => {
  const f = fixture(t);
  const result = await updateSkills({ ...f, git: async (args) => { f.calls.push(args); return oldVersion + '\trefs/heads/main\n'; } });
  assert.equal(result.checked, true); assert.equal(result.updated, false); assert.equal(f.calls.length, 1);
  assert.equal(fs.readdirSync(f.backupsDir).length, 1);
  assert.equal(fs.readFileSync(path.join(f.skillsDir, 'grill-with-ui/SKILL.md'), 'utf8'), files['skills/grill-with-ui/SKILL.md']);
});

test('Skill 更新固定到同一提交，备份两份 Skill 并保留凭据和请求状态', async (t) => {
  const f = fixture(t);
  const privateState = path.join(f.dir, 'private-state.json');
  fs.writeFileSync(privateState, 'isolated config and request fixture', { mode: 0o600 });
  const result = await updateSkills(f);
  assert.equal(result.updated, true); assert.equal(result.version, latestVersion);
  assert.equal(f.calls.length, manifest.files.length + 2);
  for (const file of manifest.files.filter((file) => file.startsWith('skills/'))) assert.equal(fs.readFileSync(path.join(f.skillsDir, file.slice(7)), 'utf8'), files[file] + '\n');
  assert.equal(fs.readFileSync(path.join(result.backup, 'remote-handover/SKILL.md'), 'utf8'), files['skills/remote-handover/SKILL.md']);
  assert.equal(fs.readFileSync(path.join(f.skillsDir, 'grill-with-docs-ui/SKILL.md'), 'utf8'), files['scripts/grill-with-docs-ui.md'] + '\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.skillsDir, 'grill-with-ui/.handover-install.json'))).commit, latestVersion);
  assert.equal(fs.readFileSync(privateState, 'utf8'), 'isolated config and request fixture');
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('下载失败时保留当前 Skill 和版本，不留下更新锁', async (t) => {
  const f = fixture(t);
  const result = await updateSkills({ ...f, contents: async (file, version) => {
    if (file.startsWith('skills/remote-handover/')) throw new Error('isolated network failure');
    return f.contents(file, version);
  } });
  assert.equal(result.ok, false); assert.equal(result.updated, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.skillsDir, 'grill-with-ui/.handover-install.json'))).commit, oldVersion);
  assert.equal(fs.readFileSync(path.join(f.skillsDir, 'remote-handover/SKILL.md'), 'utf8'), files['skills/remote-handover/SKILL.md']);
  assert.equal(fs.existsSync(f.lockFile), false);
  assert.equal(fs.readdirSync(f.backupsDir).length, 1);
});

test('拒绝写入 Skill 范围之外的更新路径', async (t) => {
  const f = fixture(t);
  const result = await updateSkills({ ...f, contents: async (file, version) => {
    if (file==='skills/manifest.json') return JSON.stringify({ schema: 1, files: [...manifest.files, 'skills/grill-with-ui/../../outside.txt'] });
    return f.contents(file, version);
  } });
  assert.equal(result.ok, false); assert.equal(fs.existsSync(path.join(f.dir, 'outside.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.skillsDir, 'grill-with-ui/.handover-install.json'))).commit, oldVersion);
});

test('多个来源同时检查更新时，不覆盖另一个仍在运行的安装', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.lockFile), { recursive: true });
  const lock = { pid: process.pid, id: 'isolated-owner' };
  fs.writeFileSync(f.lockFile, JSON.stringify(lock));
  const result = await updateSkills(f);
  assert.equal(result.status, 'updating'); assert.equal(result.updated, false); assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.lockFile)), lock);
  assert.equal(fs.readdirSync(f.backupsDir).length, 1);
});


test('missing, malformed, duplicate and wrong-ref remote heads fail before downloading or installing', async t => {
 for(const head of ['',latestVersion,latestVersion+'\trefs/heads/other',latestVersion+'\trefs/heads/main\n'+latestVersion+'\trefs/heads/main','z'.repeat(40)+'\trefs/heads/main']){
  const f=fixture(t);const result=await updateSkills({...f,git:async()=>head,contents:async()=>{throw new Error('must not download');}});
  assert.equal(result.ok,false);assert.equal(result.checked,false);assert.equal(fs.existsSync(f.lockFile),false);assert.equal(fs.readdirSync(f.backupsDir).length,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.skillsDir,'grill-with-ui/.handover-install.json'))).commit,oldVersion);
 }
});
test('public git is noninteractive and isolates credentials, config and URL rewrites', async () => {
 let directory;
 const result=await publicGit(['ls-remote',publicRemote,'refs/heads/main'],async (command,args,options)=>{
  assert.equal(command,'git');assert.deepEqual(args.slice(-3),['ls-remote',publicRemote,'refs/heads/main']);
  assert.ok(args.includes('credential.helper='));assert.ok(args.includes('http.extraHeader='));
  assert.equal(options.env.GIT_TERMINAL_PROMPT,'0');assert.equal(options.env.GIT_CONFIG_NOSYSTEM,'1');
  assert.equal(options.env.HOME,options.cwd);assert.equal(options.env.USERPROFILE,options.cwd);directory=options.cwd;
  for(const key of ['GH_TOKEN','GITHUB_TOKEN','GIT_CONFIG_COUNT','GIT_ASKPASS','SSH_ASKPASS'])assert.equal(options.env[key],undefined);
  assert.equal(fs.existsSync(options.env.GIT_CONFIG_GLOBAL),false);assert.equal(options.timeout,12000);
  return {stdout:latestVersion+'\trefs/heads/main\n'};
 });assert.match(result,/refs\/heads\/main/);assert.equal(fs.existsSync(directory),false);
});
test('public raw files pin SHA without authentication or redirects; HTTP, size and UTF8 errors fail closed', async () => {
 let called;
 const fetcher=async(url,options)=>{called={url,options};return new Response('synthetic text');};
 assert.equal(await publicContents('skills/manifest.json',latestVersion,fetcher),'synthetic text');
 assert.equal(called.url,`https://raw.githubusercontent.com/UnityX103/handover-ui-server/${latestVersion}/skills/manifest.json`);
 assert.deepEqual(called.options.headers,{Accept:'text/plain'});assert.equal(called.options.credentials,'omit');assert.equal(called.options.redirect,'error');
 for(const response of [new Response('not public',{status:404}),new Response('x'.repeat(262145)),new Response(new Uint8Array([255]))])await assert.rejects(publicContents('skills/manifest.json',latestVersion,async()=>response));
});
test('network failure checking public remote never changes local install', async t => {
 const f=fixture(t);const result=await updateSkills({...f,git:async()=>{throw new Error('offline');}});
 assert.equal(result.ok,false);assert.equal(result.checked,false);assert.equal(fs.existsSync(f.lockFile),false);assert.equal(fs.readdirSync(f.backupsDir).length,1);
 assert.equal(fs.readFileSync(path.join(f.skillsDir,'grill-with-ui/SKILL.md'),'utf8'),files['skills/grill-with-ui/SKILL.md']);
});

test('corrupt update lock during failed download cannot abort the original handover', async t => {
 const f=fixture(t);const result=await updateSkills({...f,contents:async()=>{fs.writeFileSync(f.lockFile,'invalid lock JSON');throw new Error('interrupted');}});
 assert.equal(result.ok,false);assert.equal(result.updated,false);assert.equal(fs.readFileSync(f.lockFile,'utf8'),'invalid lock JSON');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.skillsDir,'grill-with-ui/.handover-install.json'))).commit,oldVersion);
});

test('stale lock is never unconditionally removed over a concurrent updater', async t => {
 const f=fixture(t);fs.mkdirSync(path.dirname(f.lockFile),{recursive:true});const lock={pid:2147483647,id:'dead-fixture'};fs.writeFileSync(f.lockFile,JSON.stringify(lock));
 const result=await updateSkills(f);assert.equal(result.status,'stale-lock');assert.equal(result.updated,false);assert.deepEqual(JSON.parse(fs.readFileSync(f.lockFile)),lock);assert.equal(f.calls.length,1);
});

test('installation failure rolls back both prior Skills without executing downloaded content', async t => {
 const f=fixture(t),rename=fs.renameSync;
 t.mock.method(fs,'renameSync',(from,to)=>{if(String(from).endsWith('remote-handover.new'))throw new Error('simulated install failure');return rename(from,to);});
 const result=await updateSkills(f);assert.equal(result.ok,false);assert.equal(result.status,'unavailable');assert.equal(fs.existsSync(f.lockFile),false);
 for(const name of ['grill-with-ui','remote-handover'])assert.equal(fs.readFileSync(path.join(f.skillsDir,name,'SKILL.md'),'utf8'),files['skills/'+name+'/SKILL.md']);
});
test('rollback failure still attempts other Skill recovery and reports retained backup accurately', async t => {
 const f=fixture(t),rename=fs.renameSync;let attemptedOther=false;
 t.mock.method(fs,'renameSync',(from,to)=>{
  if(String(from).endsWith('remote-handover.new'))throw new Error('simulated install failure');
  if(String(from).startsWith(f.backupsDir)&&String(from).endsWith('/remote-handover'))throw new Error('simulated restore failure');
  if(String(from).startsWith(f.backupsDir)&&String(from).endsWith('/grill-with-ui'))attemptedOther=true;
  return rename(from,to);
 });
 const result=await updateSkills(f);assert.equal(result.ok,false);assert.equal(result.updated,false);assert.equal(result.status,'recovery-needed');assert.equal(attemptedOther,true);
 assert.equal(fs.readFileSync(path.join(result.backup,'remote-handover/SKILL.md'),'utf8'),files['skills/remote-handover/SKILL.md']);
 assert.equal(fs.readFileSync(path.join(f.skillsDir,'grill-with-ui/SKILL.md'),'utf8'),files['skills/grill-with-ui/SKILL.md']);assert.equal(JSON.parse(fs.readFileSync(f.lockFile)).recoveryNeeded,true);
 const again=await updateSkills(f);assert.equal(again.status,'recovery-needed');assert.equal(again.updated,false);
});
