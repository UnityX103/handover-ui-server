#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateSkills } from './update.mjs';

const configFile = () => path.resolve(process.env.HANDOVER_CONFIG || path.join(os.homedir(), '.config/handover-ui/config.json'));
const stateHome = () => path.resolve(process.env.HANDOVER_STATE_DIR || path.join(os.homedir(), '.local/state/handover-ui'));
const out = (data) => process.stdout.write(JSON.stringify(data) + '\n');
const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { if(e.code === 'ENOENT')return fallback; throw e; } };
const atomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'}); fs.renameSync(temp,file); } finally { fs.rmSync(temp,{force:true}); }
};
const args = (argv) => {
  const options={_:[]};
  for(let i=0;i<argv.length;i++) { const k=argv[i]; if(!k.startsWith('--'))options._.push(k); else if(argv[i+1] && !argv[i+1].startsWith('--'))options[k.slice(2)]=argv[++i]; else options[k.slice(2)]=true; }
  return options;
};
function serverUrl(value) {
  const url = new URL(value);
  if(url.username||url.password||url.search||url.hash||!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(url.pathname)||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new Error('服务器必须是 HTTPS 站点地址，可包含部署路径；本机回环测试可使用 HTTP');
  return url.origin+url.pathname.replace(/\/$/,'');
}
const username = (value) => { if(typeof value!=='string'|| !/^[A-Za-z0-9_-]{1,64}$/.test(value))throw new Error('用户名应为 1–64 个英文字母、数字、下划线或短横线');return value; };
const requestUrl = (cfg,id='') => cfg.serverUrl+(id?`/grill/${encodeURIComponent(id)}/`:'/')+'?username='+encodeURIComponent(username(cfg.username));
function config() {
  const saved=read(configFile(),{});
  const url=process.env.HANDOVER_SERVER_URL||saved.serverUrl;
  if(!url)throw new Error('请先配置 HANDOVER_SERVER_URL 或本地 config.json');
  return {serverUrl:serverUrl(url),username:username(process.env.HANDOVER_USERNAME??saved.username??'Xpy')};
}
const sourceSession = (o) => {
  const env=process.env.CODEX_THREAD_ID||process.env.CLAUDE_SESSION_ID;
  if(env && o['source-session'] && o['source-session']!==env)throw new Error('指定的来源会话与当前客户端环境不匹配');
  const value=env||o['source-session']; if(typeof value!=='string'||!value.trim()||value.length>200)throw new Error('缺少经过确认的来源会话 ID；请使用 CODEX_THREAD_ID 或 --source-session'); return value;
};
function handleFor(o) {
  if(typeof o.handle!=='string')throw new Error('需要 --handle <创建时返回的绝对路径>');
  const file=path.resolve(o.handle),h=read(file);
  if(h?.schema===1)throw new Error('旧凭据模式已停用；此 handle 与请求仅保留归档，不再联网恢复，不会自动迁移或重复创建。');
  if(!h||h.schema!==2||typeof h.id!=='string'||typeof h.username!=='string'||!h.source)throw new Error('handle 文件不存在或格式不正确');
  if(sourceSession(o)!==h.source.session)throw new Error('此请求不属于当前来源会话');
  if(process.platform!=='win32'&&(fs.statSync(file).mode&0o077))throw new Error('handle 必须仅当前用户可读，请设置权限 0600');
  username(h.username);
  h.serverUrl=serverUrl(h.serverUrl); return {file,h};
}
async function request(base,route,{source,username,method='GET',data,timeout=10000,signal}={}) {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeout);
  const abort=()=>controller.abort(); signal?.addEventListener('abort',abort,{once:true});
  try {
    const headers={}; if(source)headers['X-Handover-Source']=source; if(username)headers['X-Handover-Username']=username;
    if(data!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data),signal:controller.signal,redirect:'error'});
    const result=await response.json(); if(!response.ok)throw Object.assign(new Error(result.error||`HTTP ${response.status}`),{status:response.status}); return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
}
const scoped = (h,route='',options={}) => request(h.serverUrl,`/api/requests/${encodeURIComponent(h.id)}${route}`,{username:h.username,source:h.source.session,...options});
function input(o) {
  if(typeof o.file==='string')return JSON.parse(fs.readFileSync(path.resolve(o.file),'utf8'));
  if(o.stdin)return JSON.parse(fs.readFileSync(0,'utf8'));
  return {};
}
async function openBrowser(cfg,requestId='') {
  const result={loginUrl:requestUrl(cfg,requestId)};
  try {
    if(process.env.HANDOVER_NO_OPEN==='1')return {opened:false};
    if(process.platform==='darwin')execFileSync('/usr/bin/open',[result.loginUrl],{stdio:'ignore',timeout:8000});
    else if(process.platform==='win32')execFileSync('rundll32.exe',['url.dll,FileProtocolHandler',result.loginUrl],{stdio:'ignore',timeout:8000});
    else execFileSync('xdg-open',[result.loginUrl],{stdio:'ignore',timeout:8000});
    return {opened:true};
  } catch { return {opened:false,note:'无法自动打开默认浏览器；请打开返回的普通 URL 并选择对应用户名。'}; }
}
function lockWait(file) {
  const lock=file+'.wait.lock',id=crypto.randomUUID();
  const old=read(lock);
  if(old) {
    let alive=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)throw new Error('同一 handle 已有前台等待进程');
    fs.rmSync(lock,{force:true});
  }
  try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid,id,at:Date.now()}),{flag:'wx',mode:0o600});}catch(e){if(e.code==='EEXIST')throw new Error('同一 handle 已有前台等待进程');throw e;}
  return ()=>{if(read(lock)?.id===id)fs.rmSync(lock,{force:true});};
}
export async function main(argv=process.argv.slice(2)) {
  const o=args(argv),command=o._[0]||'help';
  if(command==='config'&&Object.hasOwn(o,'token-stdin'))throw new Error('旧 Agent Token 配置已停用；请使用 config --username Xpy。原配置保持不变。');
  if(command==='resume')handleFor(o); // Retired handles fail before update/network access.
  if(command==='help') { out({commands:{probe:'probe；探测自定义 HTML / JSON 桥接能力，不创建请求',update:'update；检查 GitHub main 并更新本地两份 Skill',config:'config --server HTTPS_URL [--username Xpy] | config --show',new:'new --kind questionnaire|feedback|help --topic 标题 [--file JSON | --stdin] [--context 内容] [--no-open]',resume:'resume --handle FILE',wait:'wait --handle FILE [--timeout 25] [--after SEQ]；单次最长 30 秒，超时退出码 3',pending:'pending --handle FILE',patch:'patch --handle FILE --file PATCH_JSON | --stdin',ack:'ack --handle FILE --seq N',finish:'finish --handle FILE [--doc PATH]',cancel:'cancel --handle FILE',open:'open --handle FILE | home',state:'state --handle FILE',visual:'visual --handle FILE --file HTML',sessions:'sessions [--source-session ID]'},config:configFile(),state:stateHome()}); return; }
  if(command==='update') { const result=await updateSkills();out(result);if(!result.ok)process.exitCode=1;return; }
  if(['new','resume','home'].includes(command) && process.env.HANDOVER_SKIP_UPDATE!=='1' && !process.env.HANDOVER_UPDATE_CHECKED) {
    const result=await updateSkills();process.stderr.write(JSON.stringify({event:'skill_update',...result})+'\n');
    if(result.updated) {
      const child=spawn(process.execPath,[result.entrypoint,...argv],{stdio:'inherit',env:{...process.env,HANDOVER_UPDATE_CHECKED:result.version}});
      process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code)=>resolve(code??1));});return;
    }
  }
  if(command==='config') {
    const file=configFile(),saved=read(file,{});
    if(o.server)saved.serverUrl=serverUrl(o.server);
    if(o.username!==undefined)saved.username=username(o.username);
    if(o.server||o.username!==undefined)atomic(file,saved);
    out({ok:true,file,serverUrl:process.env.HANDOVER_SERVER_URL||saved.serverUrl,username:username(process.env.HANDOVER_USERNAME??saved.username??'Xpy')});return;
  }
  if(command==='home') { const cfg=config(); out({ok:true,url:requestUrl(cfg),...await openBrowser(cfg)});return; }
  if(command==='probe') {
    try { const cfg=config(); const result=await request(cfg.serverUrl,'/api/capabilities',{username:cfg.username,timeout:4000});out({...result,available:result.service==='handover-ui'&&result.customPage?.version===1}); }
    catch(error) { out({ok:false,available:false,status:error.status,note:'远程页面桥接不可用，可使用本地 HTML 和导出 JSON。'});process.exitCode=1; }return;
  }
  if(command==='sessions') {
    const dir=path.join(stateHome(),'requests'),current=process.env.CODEX_THREAD_ID||o['source-session'];
    const list=fs.existsSync(dir)?fs.readdirSync(dir).filter((f)=>f.endsWith('.json')).map((f)=>({file:path.join(dir,f),h:read(path.join(dir,f))})).filter(({h})=>h&&(!current||h.source.session===current)).map(({file,h})=>({handle:file,requestId:h.id,source:h.source,serverUrl:h.serverUrl,username:h.username,archived:h.schema===1,cursor:h.cursor||0,created:h.created})):[];
    out({requests:list});return;
  }
  if(command==='new') {
    const cfg=config(),data=input(o),id=crypto.randomUUID();
    const source={session:sourceSession(o),project:typeof o.project==='string'?o.project:process.cwd(),machine:os.hostname()};
    const payload={...data,id,username:cfg.username,source,kind:o.kind||data.kind||'questionnaire',topic:o.topic||data.topic||'',context:o.context||data.context||''};
    const file=path.join(stateHome(),'requests',id+'.json');
    delete payload.requestToken;
    const h={schema:2,id,username:cfg.username,source,serverUrl:cfg.serverUrl,created:new Date().toISOString(),cursor:0,creation:payload,registered:false};atomic(file,h);
    try{
      const result=await request(cfg.serverUrl,'/api/requests',{username:cfg.username,method:'POST',data:payload});
      h.registered=true;atomic(file,h);
      let opened={opened:false}; if(!o['no-open'])try{opened=await openBrowser(cfg,id);}catch{opened={opened:false,note:'请求已保存，自动打开未完成。可使用 open 重试。'};}
      out({ok:true,handle:file,requestId:id,source,url:result.url,...opened});
    }catch(error){out({ok:false,handle:file,requestId:id,error:error.message,recovery:'使用 resume --handle 恢复同一请求，不要重新 new'});process.exitCode=1;}return;
  }
  const {file,h}=handleFor(o);
  if(command==='resume') {
    if(!h.registered) {
      const cfg=config();if(cfg.serverUrl!==h.serverUrl)throw new Error('当前配置已指向其他服务器，请恢复原服务器配置后重试创建');
      await request(h.serverUrl,'/api/requests',{username:h.username,method:'POST',data:h.creation}); h.registered=true;atomic(file,h);
    }
    const result=await scoped(h);out({ok:true,handle:file,requestId:h.id,source:h.source,status:result.status,handled:result.handled,url:requestUrl(h,h.id)});return;
  }
  if(command==='open') { const cfg=config();if(cfg.serverUrl!==h.serverUrl)throw new Error('当前服务器配置与 handle 不一致');out({ok:true,url:requestUrl(h,h.id),...await openBrowser({...cfg,username:h.username},h.id)});return; }
  if(command==='state') { out(await scoped(h));return; }
  if(command==='wait'||command==='pending') {
    const timeout=command==='pending'?0:Number(o.timeout??25);
    if(!Number.isFinite(timeout)||timeout<0||timeout>30)throw new Error('每次前台等待应为 0–30 秒');
    const params=new URLSearchParams({timeout:String(timeout)});if(o.after!==undefined)params.set('after',String(o.after));
    const unlock=lockWait(file),abort=new AbortController(),stop=()=>abort.abort();
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{
      const result=await scoped(h,'/wait?'+params,{timeout:(timeout+5)*1000,signal:abort.signal});
      if(result.requestId!==h.id||result.source?.session!==h.source.session||result.username!==h.username)throw new Error('服务器返回的请求或来源身份不匹配');
      out(result); if(!result.events.length)process.exitCode=['completed','cancelled'].includes(result.status)?0:3;
    }catch(e){if(abort.signal.aborted){out({ok:false,status:'interrupted',requestId:h.id,handle:file,cursor:h.cursor||0});process.exitCode=130;}else throw e;}
    finally{unlock();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}return;
  }
  if(command==='patch') { out(await scoped(h,'',{method:'PATCH',data:input(o)}));return; }
  if(command==='ack') {
    const seq=Number(o.seq);if(!Number.isInteger(seq)||seq<0)throw new Error('需要有效的 --seq');
    const result=await scoped(h,'/ack',{method:'POST',data:{seq}});h.cursor=result.handled;atomic(file,h);out(result);return;
  }
  if(command==='finish') { out(await scoped(h,'',{method:'PATCH',data:{finished:{doc:typeof o.doc==='string'?o.doc:''}}}));return; }
  if(command==='cancel') { out(await scoped(h,'/cancel',{method:'POST',data:{}}));return; }
  if(command==='visual') { if(typeof o.file!=='string')throw new Error('需要 --file HTML');out(await scoped(h,'/visual',{method:'PUT',data:{html:fs.readFileSync(path.resolve(o.file),'utf8')}}));return; }
  throw new Error('未知命令，请运行 help');
}
if(process.argv[1] && fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) main().catch((error)=>{out({ok:false,error:error.message,status:error.status});process.exitCode=1;});
