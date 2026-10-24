(() => {
  'use strict';
  const origin = window.__HANDOVER_BRIDGE__.origin;
  let channel, resolveReady;
  const pending = new Map();
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const send = (message) => parent.postMessage({ ...message, channel }, origin);
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== origin) return;
    const data = event.data;
    if (data?.type === 'handover:init' && typeof data.channel === 'string') { channel = data.channel; resolveReady(); return; }
    if (!channel || data?.channel !== channel || data.type !== 'handover:result') return;
    const operation = pending.get(data.messageId);
    if (!operation) return;
    clearTimeout(operation.timer); pending.delete(data.messageId);
    if (data.ok) operation.resolve(data); else operation.reject(new Error(data.error || '提交失败，可重试或导出 JSON'));
  });
  const dirty = () => { if (channel) send({ type: 'handover:dirty' }); };
  window.HandoverBridge = Object.freeze({
    version: 1, markDirty: dirty,
    async submit(payload) {
      if (!payload || typeof payload !== 'object') throw new Error('请提交 JSON 对象或数组');
      let timer;
      try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('桥接尚未就绪，可导出 JSON')), 5000); })]); }
      finally { clearTimeout(timer); }
      const messageId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(messageId); reject(new Error('提交结果未知，重试会沿用提交身份；也可导出 JSON')); }, 20000);
        pending.set(messageId, { resolve, reject, timer });
        send({ type: 'handover:submit', messageId, payload });
      });
    },
  });
  document.addEventListener('input', dirty, true);
  document.addEventListener('change', dirty, true);
})();
