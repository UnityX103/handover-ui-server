import path from 'node:path';
import {hash, now} from './store.mjs';
import {publicEndpoint} from './public-paths.mjs';
import {socketRequest} from './notify-socket.mjs';

const schema = 'handover.notification.v1';
const waiting = (r) => r?.accessMode === 'username' && !['completed','cancelled'].includes(r.status) && !r.state.finished && !(r.awaitingReply ?? r.status === 'submitted') && r.state.questions.some(q=>['open','reopened'].includes(q.status));
const recordLimit = 32;
const accepted = new Set(['awaiting_approval','pending','dispatching','succeeded','failed','unknown']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const integer = (value, fallback, min, max, name) => {
  const result = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${name} 配置无效`);
  return result;
};
const list = (value, pattern, name) => {
  const result = String(value || '').split(',').map(x=>x.trim()).filter(Boolean);
  if (!result.length || result.some(x=>!pattern.test(x))) throw new Error(`${name} 必须显式配置精确白名单`);
  return new Set(result);
};

export function notificationSettings(config) {
  if (config.notifyEnabled !== true && config.notifyEnabled !== '1') {
    if (![undefined, false, '', '0'].includes(config.notifyEnabled)) throw new Error('HANDOVER_NOTIFY_ENABLED 只能为 0 或 1');
    return {enabled:false};
  }
  if (!path.isAbsolute(config.notifySocket || '') || config.notifySocket.includes('\0') || Buffer.byteLength(config.notifySocket) > 100) throw new Error('HANDOVER_NOTIFY_SOCKET 应为绝对 Unix socket 路径');
  return {enabled:true, socketPath:config.notifySocket,
    socketUid:integer(config.notifySocketUid, -1, 0, 0xffffffff, 'HANDOVER_NOTIFY_SOCKET_UID'),
    sources:list(config.notifySources, /^[A-Za-z0-9_-]{8,200}$/, 'HANDOVER_NOTIFY_SOURCES'),
    usernames:list(config.notifyUsernames, /^[A-Za-z0-9_-]{1,64}$/, 'HANDOVER_NOTIFY_USERNAMES'),
    maxPending:integer(config.notifyMaxPending, 128, 1, 512, 'HANDOVER_NOTIFY_MAX_PENDING'),
    perMinute:integer(config.notifyPerMinute, 5, 1, 20, 'HANDOVER_NOTIFY_PER_SOURCE_MINUTE'),
    intervalMs:integer(config.notifyIntervalMs, 1000, 50, 60000, 'HANDOVER_NOTIFY_INTERVAL_MS'),
    timeoutMs:integer(config.notifyTimeoutMs, 3000, 50, 10000, 'HANDOVER_NOTIFY_TIMEOUT_MS')};
}

export function notificationId(requestId, version) { return hash(JSON.stringify([schema, requestId, version])); }

function validLink(value, request, endpoints) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash || url.searchParams.size !== 1 || url.searchParams.get('username') !== request.username) return false;
  return endpoints.some(endpoint => value===publicEndpoint(endpoint).href+'grill/'+request.id+'/?username='+encodeURIComponent(request.username));
}

export function notificationDescriptor(r, url, endpoints) {
  if(r.accessMode!=='username'||!uuid.test(r.id)||!uuid.test(r.source?.session)||!['questionnaire','feedback','help'].includes(r.kind))return undefined;
  const version=r.userAttentionVersion||1;
  const previous=r.notificationOutbox?.entries.find(entry=>entry.version===version)?.event || r.notificationEvent;
  if(previous?.event_id===notificationId(r.id,version)&&validLink(previous.url,r,endpoints))return previous;
  if(!validLink(url,r,endpoints))return undefined;
  const title=Array.from(r.state.topic.replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim()).slice(0,140).join('');
  if(!title)return undefined;
  return {schema,event_id:notificationId(r.id,version),request_id:r.id,source_session:r.source.session,username:r.username,title,url,kind:r.kind};
}

export class NotificationOutbox {
  constructor({store, settings, endpoints, transport = socketRequest, clock = Date.now}) {
    this.store=store;this.settings=settings;this.endpoints=endpoints;this.transport=transport;this.clock=clock;
    this.pending=new Map();this.recent=new Map();this.active=false;this.running=null;this.timer=null;this.nextDispatch=0;
    if (!settings.enabled) return;
    for (const r of store.list()) {
      for (const entry of r.notificationOutbox?.entries || []) {
        if (entry.state==='pending') this.pending.set(entry.event.event_id,r.id);
        this.remember(entry);
      }
    }
  }
  allowed(r) { return this.settings.enabled && uuid.test(r.id) && uuid.test(r.source?.session) && this.settings.sources.has(r.source?.session) && this.settings.usernames.has(r.username); }
  remember(entry) {
    if (entry.createdAt < this.clock()-60000) return;
    const source=entry.event.source_session, times=this.recent.get(source)||[];
    times.push(entry.createdAt);this.recent.set(source,times);
  }
  // Prepare the intent on the caller's request object. Its existing atomic put
  // commits both the business mutation and this outbox entry in one write.
  prepare(r, url) {
    if (!this.allowed(r) || !waiting(r)) return false;
    const version=r.userAttentionVersion || 1, box=r.notificationOutbox ||= {seenVersion:0,entries:[]};
    if (version<=box.seenVersion) return false;
    box.seenVersion=version;
    const times=(this.recent.get(r.source.session)||[]).filter(t=>t>this.clock()-60000);this.recent.set(r.source.session,times);
    const reason=!validLink(url,r,this.endpoints())?'invalid_link':this.pending.size>=this.settings.maxPending?'queue_full':times.length>=this.settings.perMinute?'rate_limited':null;
    if (reason) { box.lastSkipped={version,at:now(),reason};return false; }
    const event=notificationDescriptor(r,url,this.endpoints());
    if(!event){box.lastSkipped={version,at:now(),reason:'invalid_descriptor'};return false;}
    const entry={version,event,createdAt:this.clock(),state:'pending',uncertain:false,attempts:0,nextAttemptAt:this.clock()};
    box.entries=box.entries.filter(e=>e.state==='pending').concat(box.entries.filter(e=>e.state!=='pending').slice(-(recordLimit-1)),entry);
    return true;
  }
  committed(r) {
    if (!this.settings.enabled) return;
    for (const entry of r.notificationOutbox?.entries||[]) if (entry.state==='pending') {
      const id=entry.event.event_id;if(!this.pending.has(id)){this.pending.set(id,r.id);this.remember(entry);}
    }
    this.wake(0);
  }
  update(requestId, eventId, change) {
    const r=this.store.get(requestId),entry=r?.notificationOutbox?.entries.find(e=>e.event.event_id===eventId);
    if (!entry) {this.pending.delete(eventId);return;}
    change(entry);
    const entries=r.notificationOutbox.entries;
    r.notificationOutbox.entries=entries.filter(e=>e.state==='pending').concat(entries.filter(e=>e.state!=='pending').sort((a,b)=>a.createdAt-b.createdAt).slice(-recordLimit));
    this.store.put(r);
    if(entry.state!=='pending')this.pending.delete(eventId);
    return entry;
  }
  start() { if(this.settings.enabled&&!this.active){this.active=true;this.wake(0);} }
  stop() {this.active=false;clearTimeout(this.timer);this.timer=null;this.abort?.abort();return this.running;}
  wake(delay) {
    if(!this.active||this.timer||this.running||!this.pending.size)return;
    this.timer=setTimeout(()=>{this.timer=null;void this.drain();},delay);this.timer.unref();
  }
  async drain() {
    if(this.running||!this.active)return;
    this.running=this.runOne();
    try{await this.running;}
    catch{this.nextDispatch=this.clock()+1000;console.error(JSON.stringify({event:'notification_outbox_unavailable'}));}
    finally{this.running=null;this.wake(this.settings.intervalMs);}
  }
  receipt(response,eventId,requestId) {
    return [200,202].includes(response.status) && response.data.event_id===eventId && response.data.request_id===requestId && accepted.has(response.data.state);
  }
  async runOne() {
    if(this.clock()<this.nextDispatch)return;
    for (const [eventId,requestId] of this.pending) {
      const r=this.store.get(requestId),entry=r?.notificationOutbox?.entries.find(e=>e.event.event_id===eventId);
      if(!entry){this.pending.delete(eventId);continue;}
      if(!this.allowed(r)||!waiting(r)){this.update(requestId,eventId,e=>{e.state='skipped';e.reason='not_awaiting_user';});continue;}
      if(entry.nextAttemptAt>this.clock())continue;
      if(!validLink(entry.event.url,r,this.endpoints()) || entry.event.event_id!==notificationId(r.id,entry.version) || entry.event.request_id!==r.id || entry.event.source_session!==r.source.session || entry.event.username!==r.username){this.update(requestId,eventId,e=>{e.state='rejected';e.reason='invalid_identity';});continue;}
      this.nextDispatch=this.clock()+this.settings.intervalMs;this.abort=new AbortController();
      const call=(method)=>this.transport({socketPath:this.settings.socketPath,socketUid:this.settings.socketUid,method,eventId,payload:method==='POST'?entry.event:undefined,timeoutMs:this.settings.timeoutMs,signal:this.abort.signal});
      try {
        let response;
        if(entry.uncertain){
          response=await call('GET');if(!this.active)return;
          if(this.receipt(response,eventId,requestId)){this.update(requestId,eventId,e=>{e.state='accepted';e.receiptState=response.data.state;e.acceptedAt=now();});return;}
          if(response.status!==404)throw Object.assign(new Error('receipt query failed'),{code:'QUERY_UNCONFIRMED',status:response.status});
          this.update(requestId,eventId,e=>{e.uncertain=false;});
        }
        this.update(requestId,eventId,e=>{e.uncertain=true;e.attempts++;e.lastAttemptAt=now();});
        response=await call('POST');if(!this.active)return;
        if(this.receipt(response,eventId,requestId))this.update(requestId,eventId,e=>{e.state='accepted';e.receiptState=response.data.state;e.acceptedAt=now();});
        else if([400,401,403,409,422].includes(response.status))this.update(requestId,eventId,e=>{e.state='rejected';e.lastStatus=response.status;});
        else throw Object.assign(new Error('notification not acknowledged'),{code:'POST_UNCONFIRMED',status:response.status});
      }catch(error){
        if(this.active)this.update(requestId,eventId,e=>{e.lastError=/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'NOTIFY_FAILED';e.lastStatus=error.status||null;e.nextAttemptAt=this.clock()+Math.min(300000,1000*2**Math.min(e.attempts,8));});
      }finally{this.abort=null;}
      return;
    }
  }
}
