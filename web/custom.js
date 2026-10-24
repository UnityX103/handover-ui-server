'use strict';
(async () => {
  const id = document.querySelector('meta[name="handover-request"]').content;
  const frame = document.querySelector('#page'), status = document.querySelector('#status');
  const retry = document.querySelector('#retry');
  const username = new URLSearchParams(location.search).get('username');
  if (username !== null && sessionStorage.getItem('handover:username') !== username) { location.replace('/?' + new URLSearchParams({username,request:id})); return; }
  const query = username === null ? '' : '?' + new URLSearchParams({username});
  const home = username === null ? '/?mode=legacy' : '/' + query; document.querySelector('header a').href = home;
  const route = `/grill/${id}/`, channel = crypto.randomUUID(), storageKey = `handover:custom:${id}${query}`;
  let revision = 0, pending, handled = 0, closed = false, submitting = false;
  try { pending = JSON.parse(localStorage.getItem(storageKey)); revision = pending?.currentRevision || 0; } catch {}
  const persist = () => { try { if (pending) localStorage.setItem(storageKey, JSON.stringify({ ...pending, currentRevision: revision })); else localStorage.removeItem(storageKey); } catch {} };
  const api = async (path, body) => {
    if (username !== null && sessionStorage.getItem('handover:username') !== username) throw new Error('用户名会话已退出');
    const response = await fetch(route + path + query, { cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json(); if (username !== null && sessionStorage.getItem('handover:username') !== username) throw new Error('用户名会话已退出'); if (!response.ok) throw new Error(data.error || '请求失败'); return data;
  };
  const info = await api('bridge');
  document.querySelector('#title').textContent = info.topic;
  const flush = async () => {
    submitting = true; retry.disabled = true; status.textContent = '正在保存答复…';
    try {
      const saved = await api('feedback', { submissionId: pending.submissionId, feedbackType: info.page.feedbackType, pageHash: info.page.pageHash, payload: JSON.parse(pending.serialized) });
      pending.seq = saved.seq; persist(); retry.hidden = true; status.textContent = '答复已保存，等待来源 Agent 确认'; return saved;
    } catch (error) { retry.hidden = false; throw error; }
    finally { submitting = false; retry.disabled = false; }
  };
  retry.hidden = !pending || !!pending.seq;
  retry.addEventListener('click', () => { if (!submitting && pending) flush().catch((error) => { status.textContent = error.message; }); });
  const tell = (message) => frame.contentWindow.postMessage({ ...message, channel }, '*');
  frame.addEventListener('load', () => tell({ type: 'handover:init' }));
  window.addEventListener('message', async (event) => {
    if (username !== null && sessionStorage.getItem('handover:username') !== username) return;
    const data = event.data;
    if (event.source !== frame.contentWindow || event.origin !== 'null' || data?.channel !== channel) return;
    if (data.type === 'handover:dirty') { revision++; persist(); return; }
    if (data.type !== 'handover:submit' || typeof data.messageId !== 'string') return;
    const result = (value) => tell({ type: 'handover:result', messageId: data.messageId, ...value });
    if (submitting) { result({ ok: false, error: '正在提交，请稍候' }); return; }
    try {
      if (!data.payload || typeof data.payload !== 'object') throw new Error('需要 JSON 对象或数组');
      const serialized = JSON.stringify(data.payload);
      if (new TextEncoder().encode(serialized).length > info.maxFeedbackBytes) throw new Error('反馈 JSON 过大，请导出后交接');
      if (pending && !pending.seq && pending.serialized !== serialized) throw new Error('上次提交结果尚未确认，请先重试原内容或刷新页面');
      if (!pending || pending.serialized !== serialized || (pending.seq && handled >= pending.seq)) pending = { submissionId: crypto.randomUUID(), serialized, revision };
      persist(); const saved = await flush(); result(saved);
    } catch (error) { status.textContent = error.message; result({ ok: false, error: error.message }); }
    finally { submitting = false; }
  });
  frame.src = route + 'content' + query; status.textContent = pending ? '恢复提交状态，等待来源确认' : '请在下方页面填写';
  const poll = async () => {
    if (username !== null && sessionStorage.getItem('handover:username') !== username) { closed = true; return; }
    try {
      const current = await api('bridge'); handled = current.handled;
      if (pending?.seq && handled >= pending.seq) {
        const edited = revision > pending.revision;
        pending = undefined; persist();
        if (!edited) { closed = true; location.replace(home); return; }
        status.textContent = '来源 Agent 已收到；保留你新写入的内容';
      }
      if (current.status === 'cancelled') status.textContent = '此请求已取消，可导出当前内容';
    } catch { status.textContent = '连接中断；保留页面，可稍后重试或导出 JSON'; }
    if (!closed) setTimeout(poll, 1500);
  };
  poll();
})().catch(() => { document.querySelector('#status').textContent = '页面载入失败，请返回主界面重新登录'; });
