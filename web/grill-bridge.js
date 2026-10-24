function handoverRequireUsername() {
  const target = new URLSearchParams(location.search).get('username');
  if (target === null) return;
  let current; try { current = localStorage.getItem('handover:username'); } catch {}
  if (current !== target) { location.replace('/?' + new URLSearchParams({username:target,request:location.pathname.split('/')[2]})); throw new Error('请先登录匹配的用户名'); }
}
handoverRequireUsername();
const handoverUsername = new URLSearchParams(location.search).get('username');
const handoverScope = location.pathname + (handoverUsername === null ? '' : '?' + new URLSearchParams({username:handoverUsername}));
const handoverHome = handoverUsername === null ? '/' : '/?' + new URLSearchParams({username:handoverUsername});
const handoverIdentityEpoch=localStorage.getItem('handover:identity-epoch')||'0';
const handoverSessionActive = () => { if (handoverUsername === null) return true; try { return localStorage.getItem('handover:username') === handoverUsername && (localStorage.getItem('handover:identity-epoch')||'0')===handoverIdentityEpoch; } catch { return false; } };
// The upstream post function is hoisted; a second gesture must not start another POST.
if (typeof post === 'function') {
  const handoverOriginalPost = post; let handoverPosting = false;
  post = async function(...args) {
    if (handoverPosting) return null; handoverPosting = true;
    const before = typeof local === 'undefined' ? null : JSON.parse(JSON.stringify({staged:local.staged,drafts:local.drafts,vfeedback:local.vfeedback}));
    try {
      const result = await handoverOriginalPost(...args);
      if (before && Array.isArray(args[0]) && args[0].some(action=>!['visualize','explore'].includes(action.type)) && result?.ok && result.saved === true && Number.isSafeInteger(result.seq) && result.seq > 0 && handoverSessionActive()) {
        const after=JSON.parse(JSON.stringify({staged:local.staged,drafts:local.drafts,vfeedback:local.vfeedback}));
        if(JSON.stringify(after)!==JSON.stringify(before)) {
          for(const[id,staged]of Object.entries(after.staged)){const old=before.staged[id]||{};for(const field of ['answer','defer','reopen'])if(JSON.stringify(staged[field])===JSON.stringify(old[field]))delete staged[field];if(staged.thread&&old.thread&&JSON.stringify(staged.thread.slice(0,old.thread.length))===JSON.stringify(old.thread))staged.thread=staged.thread.slice(old.thread.length);if(staged.thread&&!staged.thread.length)delete staged.thread;if(!Object.keys(staged).length)delete after.staged[id];}
          if(JSON.stringify(after.vfeedback.slice(0,before.vfeedback.length))===JSON.stringify(before.vfeedback))after.vfeedback=after.vfeedback.slice(before.vfeedback.length);
          handoverRecoveredDraft=after;
        }
      }
      return result;
    } finally { handoverPosting = false; }
  };
}
let handoverReturning = false, handoverRecoveredDraft = null, handoverCommitPending = false, handoverCancelled = false;
// Included inside the upstream page's script; each send keeps its identity on retry.
function handoverSubmissionId(actions) {
  if (!handoverSessionActive()) throw new Error('用户名会话已退出');
  const key = 'handover:submission:' + handoverScope;
  const digest = JSON.stringify(actions);
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
  if (!saved || saved.digest !== digest || (saved.seq && (S?.agent?.handled || 0) >= saved.seq)) {
    saved = { id: crypto.randomUUID(), digest };
    localStorage.setItem(key, JSON.stringify(saved));
  }
  return saved.id;
}
function handoverSubmissionReceived(result, actions, httpOk) {
  if (!handoverSessionActive()) return;
  if (httpOk !== true || !result?.ok || result.saved !== true || !Number.isSafeInteger(result.seq) || result.seq <= 0) return;
  const key = 'handover:submission:' + handoverScope;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved) { saved.seq = result.seq; localStorage.setItem(key, JSON.stringify(saved)); }
  } catch {}
  if (actions.some((action) => !['visualize', 'explore'].includes(action.type))) {
    sessionStorage.setItem('handover:return:' + handoverScope, String(result.seq));
    const receipt = document.getElementById('handover-receipt');
    if (receipt) { receipt.hidden = false; receipt.textContent = '答复已保存，正在返回列表；来源 Agent 将继续处理。'; }
    handoverCommitPending = true;
    setTimeout(() => { handoverCommitPending = false; handoverReturnWhenAcknowledged(S); }, 0);
  }
}
function handoverReturnWhenAcknowledged(state) {
  if (!handoverSessionActive()) return;
  if (state?.cancellation) handoverCancelled = true;
  if (handoverCommitPending) return;
  if (handoverRecoveredDraft) {
    const recovered=handoverRecoveredDraft;handoverRecoveredDraft=null;local.staged=recovered.staged;local.drafts=recovered.drafts;local.vfeedback=recovered.vfeedback;sessionStorage.removeItem('handover:return:'+handoverScope);commit();
    const receipt=document.getElementById('handover-receipt');if(receipt){receipt.hidden=false;receipt.textContent='答复已保存；保留发送期间新增的草稿。';}return;
  }
  if (handoverCancelled) {
    const receipt = document.getElementById('handover-receipt'), cancel = document.getElementById('handover-cancel');
    if (cancel) cancel.disabled = true;
    if (receipt) { receipt.hidden = false; receipt.textContent = '本次回答已取消；保留已有内容，不会当作同意继续。'; }
    return;
  }
  const key = 'handover:return:' + handoverScope;
  const seq = Number(sessionStorage.getItem(key));
  if (!Number.isSafeInteger(seq) || seq <= 0 || handoverReturning) return;
  sessionStorage.removeItem(key);
  handoverReturning = true;
  location.replace(handoverHome);
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('DOMContentLoaded', () => {
  const home = document.querySelector('.home-link'); if (home) home.href = handoverHome;
  const receipt = document.createElement('span'); receipt.id = 'handover-receipt'; receipt.hidden = true; receipt.setAttribute('role', 'status');
  document.querySelector('header').append(receipt);
  const cancel = document.createElement('button'); cancel.id = 'handover-cancel'; cancel.type = 'button'; cancel.className = 'handover-size'; cancel.textContent = '取消本次回答';
  cancel.onclick = async () => {
    if (!handoverSessionActive() || !window.confirm('取消本次回答？来源 Agent 会停止等待，已填写的内容会保留。')) return;
    cancel.disabled = true;
    try {
      const response = await fetch(withToken('/cancel'), {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '取消失败');
      handoverReturnWhenAcknowledged({cancellation:result.cancellation});
    } catch (error) { cancel.disabled = false; receipt.hidden = false; receipt.textContent = error.message; }
  };
  document.querySelector('header').append(cancel);
  if (S?.finished) cancel.disabled = true;
  handoverReturnWhenAcknowledged(S);
  if (sessionStorage.getItem('handover:return:' + handoverScope)) {
    receipt.hidden = false; receipt.textContent = '答复已保存，正在返回列表；来源 Agent 将继续处理。';
  }
  let size = Math.min(28, Math.max(18, Number(localStorage.getItem('handover:font')) || 20));
  const apply = () => { document.documentElement.style.setProperty('--handover-font', size + 'px'); localStorage.setItem('handover:font', size); };
  for (const [label, delta] of [['字号 −', -2], ['字号 +', 2]]) {
    const button = document.createElement('button'); button.className = 'handover-size'; button.textContent = label;
    button.onclick = () => { size = Math.min(28, Math.max(18, size + delta)); apply(); };
    document.querySelector('header').append(button);
  }
  apply();
});
