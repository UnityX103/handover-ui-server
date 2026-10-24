'use strict';
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'handover:navigate') return;
    try {
      const target = new URL(event.data.url, location.origin);
      if (target.origin !== location.origin || !/^\/grill\/[A-Za-z0-9_-]{8,100}\/$/.test(target.pathname)) return;
      const username = target.searchParams.get('username');
      if (username !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(username)) return;
      const destination = target.pathname + (username === null ? '' : '?' + new URLSearchParams({username}));
      if (location.pathname + location.search !== destination) location.replace(destination);
    } catch {}
  });
  const ready = () => navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage({ type: 'handover:ready' })).catch(() => {});
  ready();
  navigator.serviceWorker.addEventListener('controllerchange', ready);
}
// This per-tab username session is a deliberate UI choice, not authentication.
if (/^\/grill\/[A-Za-z0-9_-]{8,100}\/$/.test(location.pathname)) {
  const target = new URLSearchParams(location.search).get('username');
  if (target !== null) {
    const check = () => {
      let name; try { name = sessionStorage.getItem('handover:username'); } catch {}
      if (name === target) { document.documentElement.hidden = false; return true; }
      document.documentElement.hidden = true;
      location.replace('/?' + new URLSearchParams({username:target,request:location.pathname.split('/')[2]})); return false;
    };
    window.addEventListener('pageshow',check);
    if (check()) {
      const button = document.createElement('button'); button.id = 'username-logout'; button.type = 'button'; button.textContent = '退出用户名';
      button.onclick = () => { if (!window.confirm('退出当前用户名？未提交的编辑可能丢失；已保存的草稿会保留。')) return; try { sessionStorage.removeItem('handover:username'); } catch { return; } document.documentElement.hidden = true; location.replace('/'); };
      document.querySelector('header')?.append(button);
    }
  }
}
