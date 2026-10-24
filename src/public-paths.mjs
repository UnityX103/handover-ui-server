export function publicEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(url.pathname)) throw new Error('站点地址只能包含普通路径，不能包含凭据、查询或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('公网入口必须使用 HTTPS');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

// Match only configured hosts and complete path boundaries. The loopback root
// remains available for the release executor's private health check.
export function requestMount(req, endpoints, loopbackOrigin) {
  const local = new URL(loopbackOrigin);
  const allowed = endpoints.filter((url) => url.host === req.headers.host);
  if (req.headers.host === local.host) {
    for (const pathname of new Set(['/', ...endpoints.map((url) => url.pathname)])) allowed.push(new URL(pathname, local));
  }
  if (!allowed.length) throw Object.assign(new Error('Host 不匹配'), { status: 403 });
  const url = new URL(req.url, allowed[0].origin);
  if (url.origin !== allowed[0].origin) throw Object.assign(new Error('请求地址不合法'), { status: 400 });
  const mount = allowed.sort((a, b) => b.pathname.length - a.pathname.length).find((base) => url.pathname.startsWith(base.pathname) || url.pathname === base.pathname.slice(0, -1));
  if (!mount) throw Object.assign(new Error('未找到'), { status: 404 });
  return { url, origin: mount.origin, basePath: mount.pathname, path: url.pathname.slice(mount.pathname.length - 1) || '/', redirect: url.pathname === mount.pathname.slice(0, -1) };
}

// Only render our public shells; never rewrite a Skill's sandboxed HTML or JSON.
export function shellHtml(html, basePath) {
  return html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${basePath}`)
    .replace('<head>', `<head><meta name="handover-base" content="${basePath}"><script src="${basePath}paths.js"></script>`);
}
