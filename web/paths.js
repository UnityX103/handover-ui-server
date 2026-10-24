'use strict';
window.HandoverPaths = (() => {
  const base = document.querySelector('meta[name="handover-base"]')?.content || '/';
  const pathname = (value = location.pathname) => value.startsWith(base) ? '/' + value.slice(base.length) : '';
  return { base, url: (path = '') => base + path.replace(/^\//, ''), pathname, requestId: () => pathname().split('/')[2] };
})();
