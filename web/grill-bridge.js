// Included inside the upstream page's script; each send keeps its identity on retry.
function handoverSubmissionId(actions) {
  const key = 'handover:submission:' + location.pathname;
  const digest = JSON.stringify(actions);
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
  if (!saved || saved.digest !== digest || (saved.seq && (S?.agent?.handled || 0) >= saved.seq)) {
    saved = { id: crypto.randomUUID(), digest };
    localStorage.setItem(key, JSON.stringify(saved));
  }
  return saved.id;
}
function handoverSubmissionReceived(result) {
  if (!result?.ok || !result.seq) return;
  const key = 'handover:submission:' + location.pathname;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved) { saved.seq = result.seq; localStorage.setItem(key, JSON.stringify(saved)); }
  } catch {}
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('DOMContentLoaded', () => {
  let size = Math.min(28, Math.max(18, Number(localStorage.getItem('handover:font')) || 20));
  const apply = () => { document.documentElement.style.setProperty('--handover-font', size + 'px'); localStorage.setItem('handover:font', size); };
  for (const [label, delta] of [['字号 −', -2], ['字号 +', 2]]) {
    const button = document.createElement('button'); button.className = 'handover-size'; button.textContent = label;
    button.onclick = () => { size = Math.min(28, Math.max(18, size + delta)); apply(); };
    document.querySelector('header').append(button);
  }
  apply();
});
