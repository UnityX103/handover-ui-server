function handoverRequireUsername() {
  const target = new URLSearchParams(location.search).get('username');
  if (target === null) return;
  let current; try { current = localStorage.getItem('handover:username'); } catch {}
  if (current !== target) { location.replace('/?' + new URLSearchParams({username:target,request:location.pathname.split('/')[2]})); throw new Error('请先登录匹配的用户名'); }
}
handoverRequireUsername();
const handoverUsername = new URLSearchParams(location.search).get('username');
const handoverScope = location.pathname + (handoverUsername === null ? '' : '?' + new URLSearchParams({username:handoverUsername}));
const handoverHome = handoverUsername === null ? '/?mode=legacy' : '/?' + new URLSearchParams({username:handoverUsername});
const handoverIdentityEpoch=localStorage.getItem('handover:identity-epoch')||'0';
const handoverSessionActive = () => { if (handoverUsername === null) return true; try { return localStorage.getItem('handover:username') === handoverUsername && (localStorage.getItem('handover:identity-epoch')||'0')===handoverIdentityEpoch; } catch { return false; } };
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
function handoverSubmissionReceived(result, actions) {
  if (!handoverSessionActive()) return;
  if (!result?.ok || !result.seq) return;
  const key = 'handover:submission:' + handoverScope;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved) { saved.seq = result.seq; localStorage.setItem(key, JSON.stringify(saved)); }
  } catch {}
  if (actions.some((action) => !['visualize', 'explore'].includes(action.type))) {
    sessionStorage.setItem('handover:return:' + handoverScope, String(result.seq));
    const receipt = document.getElementById('handover-receipt');
    if (receipt) { receipt.hidden = false; receipt.textContent = '答复已保存，等待来源 Agent 确认；收到后自动返回主界面。'; }
    setTimeout(() => handoverReturnWhenAcknowledged(S), 0);
  }
}
function handoverReturnWhenAcknowledged(state) {
  if (!handoverSessionActive()) return;
  const key = 'handover:return:' + handoverScope;
  const seq = Number(sessionStorage.getItem(key));
  if (!seq || (state?.agent?.handled || 0) < seq) return;
  sessionStorage.removeItem(key);
  // Never leave newly typed or staged work behind when an earlier send is acknowledged.
  if (stagedCount() || typedAnswers().length) return;
  location.replace(handoverHome);
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('DOMContentLoaded', () => {
  const home = document.querySelector('.home-link'); if (home) home.href = handoverHome;
  const receipt = document.createElement('span'); receipt.id = 'handover-receipt'; receipt.hidden = true; receipt.setAttribute('role', 'status');
  document.querySelector('header').append(receipt);
  if (sessionStorage.getItem('handover:return:' + handoverScope)) {
    receipt.hidden = false; receipt.textContent = '答复已保存，等待来源 Agent 确认；收到后自动返回主界面。';
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
