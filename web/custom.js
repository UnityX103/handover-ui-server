'use strict';
(async () => {
  const id = document.querySelector('meta[name="handover-request"]').content;
  const frame = document.querySelector('#page'), status = document.querySelector('#status');
  const retry = document.querySelector('#retry'), cancel = document.querySelector('#cancel-request');
  const identityEpoch=localStorage.getItem('handover:identity-epoch')||'0';
  const username = new URLSearchParams(location.search).get('username');
  if (username !== null && (localStorage.getItem('handover:username') !== username || (localStorage.getItem('handover:identity-epoch')||'0')!==identityEpoch)) { location.replace(window.HandoverPaths.url('/?') + new URLSearchParams({username,request:id})); return; }
  const query = username === null ? '' : '?' + new URLSearchParams({username});
  const home = window.HandoverPaths.url(username === null ? '/' : '/' + query); document.querySelector('header a').href = home;
  const route = window.HandoverPaths.url(`/grill/${id}/`), channel = crypto.randomUUID(), storageKey = `handover:custom:${id}${query}`;
  let revision = 0, pending, handled = 0, closed = false, submitting = false, cancelled = false;
  try { pending = JSON.parse(localStorage.getItem(storageKey)); revision = pending?.currentRevision || 0; } catch {}
  const persist = () => { try { if (pending) localStorage.setItem(storageKey, JSON.stringify({ ...pending, currentRevision: revision })); else localStorage.removeItem(storageKey); } catch {} };
  const api = async (path, body) => {
    if (username !== null && (localStorage.getItem('handover:username') !== username || (localStorage.getItem('handover:identity-epoch')||'0')!==identityEpoch)) throw new Error('用户名会话已退出');
    const response = await fetch(route + path + query, { cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json(); if (username !== null && (localStorage.getItem('handover:username') !== username || (localStorage.getItem('handover:identity-epoch')||'0')!==identityEpoch)) throw new Error('用户名会话已退出'); if (!response.ok) throw new Error(data.error || '请求失败'); return data;
  };
  const info = await api('bridge');
  document.querySelector('#title').textContent = info.topic;
  const showCancellation = (current) => {
    cancelled = true; closed = true; cancel.disabled = true; retry.hidden = true;
    status.textContent = (current.cancellation?.by === 'agent' ? '来源 Agent 已取消本次请求' : '本次回答已取消') + '；保留当前内容，可导出 JSON。';
  };
  cancel.disabled = ['cancelled','completed'].includes(info.status);
  cancel.addEventListener('click', async () => {
    if (!window.confirm('取消本次回答？来源 Agent 会停止等待，已填写的内容会保留。')) return;
    cancel.disabled = true;
    try { showCancellation(await api('cancel', {})); }
    catch (error) { cancel.disabled = false; status.textContent = error.message; }
  });
  const flush = async () => {
    if (cancelled) throw new Error('此请求已取消，可导出当前内容');
    if (closed || submitting) throw new Error('正在提交或已提交，请稍候');
    submitting = true; retry.disabled = true; status.textContent = '正在保存答复…';
    try {
      const saved = await api('feedback', { submissionId: pending.submissionId, feedbackType: info.page.feedbackType, pageHash: info.page.pageHash, payload: JSON.parse(pending.serialized) });
      if (!saved?.ok || saved.saved !== true || !Number.isSafeInteger(saved.seq) || saved.seq <= 0) throw new Error('服务端尚未确认保存，请重试原内容');
      pending.seq = saved.seq; persist(); retry.hidden = true;
      if (!cancelled && revision > pending.revision) { status.textContent='答复已保存；保留发送期间新增的内容。'; }
      else if (!cancelled) { closed = true; status.textContent = '答复已保存，正在返回列表'; setTimeout(()=>{if(!cancelled && (username===null || localStorage.getItem('handover:username')===username && (localStorage.getItem('handover:identity-epoch')||'0')===identityEpoch))location.replace(home);},0); }
      return saved;
    } catch (error) { retry.hidden = cancelled; throw error; }
    finally { submitting = false; retry.disabled = false; }
  };
  retry.hidden = !pending || !!pending.seq;
  retry.addEventListener('click', () => { if (!submitting && pending) flush().catch((error) => { status.textContent = error.message; }); });
  const tell = (message) => frame.contentWindow.postMessage({ ...message, channel }, '*');
  frame.addEventListener('load', () => tell({ type: 'handover:init' }));
  window.addEventListener('message', async (event) => {
    if (username !== null && (localStorage.getItem('handover:username') !== username || (localStorage.getItem('handover:identity-epoch')||'0')!==identityEpoch)) return;
    const data = event.data;
    if (event.source !== frame.contentWindow || event.origin !== 'null' || data?.channel !== channel) return;
    if (data.type === 'handover:dirty') { revision++; persist(); return; }
    if (data.type !== 'handover:submit' || typeof data.messageId !== 'string') return;
    const result = (value) => tell({ type: 'handover:result', messageId: data.messageId, ...value });
    if (cancelled) { result({ok:false,error:'此请求已取消，可导出当前内容'}); return; }
    if (submitting || closed) { result({ ok: false, error: '正在提交，请稍候' }); return; }
    try {
      if (!data.payload || typeof data.payload !== 'object') throw new Error('需要 JSON 对象或数组');
      const serialized = JSON.stringify(data.payload);
      if (new TextEncoder().encode(serialized).length > info.maxFeedbackBytes) throw new Error('反馈 JSON 过大，请导出后交接');
      if (pending && !pending.seq && pending.serialized !== serialized) throw new Error('上次提交结果尚未确认，请先重试原内容或刷新页面');
      if (!pending || pending.serialized !== serialized || (pending.seq && handled >= pending.seq)) pending = { submissionId: crypto.randomUUID(), serialized, revision };
      persist(); const saved = await flush(); result(saved);
    } catch (error) { if (!cancelled) status.textContent = error.message; result({ ok: false, error: error.message }); }
    finally { submitting = false; }
  });
  frame.src = route + 'content' + query; status.textContent = pending ? '恢复提交状态，等待来源确认' : '请在下方页面填写';
  if (info.status === 'cancelled') showCancellation(info);
  const poll = async () => {
    if (closed) return;
    if (username !== null && (localStorage.getItem('handover:username') !== username || (localStorage.getItem('handover:identity-epoch')||'0')!==identityEpoch)) { closed = true; return; }
    try {
      const current = await api('bridge'); handled = current.handled;
      if (current.status === 'cancelled') { showCancellation(current); return; }
      if (current.status === 'completed') cancel.disabled = true;
      if (Number.isSafeInteger(pending?.seq) && pending.seq > 0 && handled >= pending.seq) { pending=undefined;persist(); }
    } catch { status.textContent = '连接中断；保留页面，可稍后重试或导出 JSON'; }
    if (!closed) setTimeout(poll, 1500);
  };
  poll();
})().catch(() => { document.querySelector('#status').textContent = '页面载入失败，请返回主界面重新登录'; });
