import { hash } from './store.mjs';

export const customLimits = Object.freeze({ version: 1, maxHtmlBytes: 4 * 1024 * 1024, maxFeedbackBytes: 512 * 1024 });
const invalid = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
export function customPage(value) {
  if (value === undefined) return undefined;
  if (!value || value.version !== 1 || typeof value.html !== 'string' || !value.html.trim() || Buffer.byteLength(value.html) > customLimits.maxHtmlBytes) invalid('自定义页面版本或大小无效');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value.feedbackType || '') || typeof value.documentId !== 'string' || !value.documentId.trim() || value.documentId.length > 200) invalid('需要反馈类型与文档身份');
  return { version: 1, html: value.html, feedbackType: value.feedbackType, documentId: value.documentId, pageHash: hash(value.html) };
}
export const pageInfo = (r) => r.page ? { version: 1, feedbackType: r.page.feedbackType, documentId: r.page.documentId, pageHash: r.page.pageHash } : undefined;
export function validateFeedback(data, r) {
  if (!r.page || data.feedbackType !== r.page.feedbackType || data.pageHash !== r.page.pageHash) invalid('反馈类型或页面版本不匹配');
  if (!data.payload || typeof data.payload !== 'object' || Buffer.byteLength(JSON.stringify(data.payload)) > customLimits.maxFeedbackBytes) invalid('反馈应为大小受限的 JSON 对象或数组');
}
export const customCsp = "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
export function customContent(html, sdk, origin) {
  const config = JSON.stringify({ origin }).replaceAll('<', '\\u003c');
  const injection = `<script>window.__HANDOVER_BRIDGE__=${config};\n${sdk}</script>`;
  const head = /<head(?:\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (tag) => tag + injection) : injection + html;
}
