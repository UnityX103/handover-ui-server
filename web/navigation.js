'use strict';
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'handover:navigate') return;
    try {
      const target = new URL(event.data.url, location.origin);
      if (target.origin !== location.origin || !/^\/grill\/[A-Za-z0-9_-]{8,100}\/$/.test(target.pathname)) return;
      if (location.pathname !== target.pathname) location.replace(target.pathname);
    } catch {}
  });
  const ready = () => navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage({ type: 'handover:ready' })).catch(() => {});
  ready();
  navigator.serviceWorker.addEventListener('controllerchange', ready);
}
