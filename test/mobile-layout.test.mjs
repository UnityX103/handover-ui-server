import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../page.html', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../web/grill-bridge.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/grill.css', import.meta.url), 'utf8');

// Minimal DOM for behavior, not a browser/layout emulator. Existing nodes and handlers
// must survive movement into/out of the native mobile disclosure.
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.className = ''; this.parentNode = null; this._html = ''; this.listeners = {}; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { for (const node of this.children) node.parentNode = null; this.children = []; this._html = value; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  detach() { if (this.parentNode) { const a = this.parentNode.children; a.splice(a.indexOf(this), 1); this.parentNode = null; } }
  append(...nodes) { for (const node of nodes) { node.detach(); node.parentNode = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  before(node) { const parent = this.parentNode; node.detach(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this), 0, node); }
  after(node) { const parent = this.parentNode; node.detach(); node.parentNode = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => this.className.split(/\s+/).includes(name));
    return this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selectors) { const tests = selectors.split(','); const found = []; for (const node of this.children) { if (tests.some(s => node.matches(s))) found.push(node); found.push(...node.querySelectorAll(selectors)); } return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  click() { this.onclick?.(); for (const listener of this.listeners.click || []) listener(); }
  focus(options) { this.focused = options || true; }
  scrollIntoView(options) { this.scrolled = options; }
  insertAdjacentHTML(where, html) { this._html += html; }
}

function navigationFixture() {
  const nav = new Element('nav');
  const questions = Array.from({ length: 12 }, (_, i) => ({ id: `q${i + 1}`, title: `完整问题 ${i + 1}：${'很长的题目 '.repeat(12)}`, round: i < 6 ? 1 : 2, status: i < 3 ? 'answered' : 'open' }));
  const context = {
    document: { createElement: tag => new Element(tag) }, $: () => nav,
    S: {}, local: { staged: {} }, selected: 'q4',
    rounds: () => [[1, questions.slice(0, 6)], [2, questions.slice(6)]], curRound: () => 2,
    levelOf: () => null, pendingActions: () => [], esc: String, CHECK: 'check', keyLabel: () => '',
  };
  vm.createContext(context);
  vm.runInContext(page.slice(page.indexOf('function renderNav()'), page.indexOf('function renderMain()')), context);
  context.render = () => context.renderNav();
  return { nav, questions, context };
}

test('mobile question navigation keeps full accessible labels, progress and current identity across renders', () => {
  const { nav, questions, context } = navigationFixture();
  context.renderNav();
  assert.equal(nav.querySelector('.nav-progress').textContent, '第 4 / 12 题 · 已答 3');
  const first = nav.querySelectorAll('.item'); assert.equal(first.length, 12);
  assert.equal(first[3].attrs['aria-current'], 'step');
  assert.equal(first[0].attrs.role, 'button'); assert.equal(first[0].tabIndex, 0);
  assert.ok(first[0].attrs['aria-label'].includes(questions[0].title));
  assert.match(first[11].innerHTML, /class="nav-number" aria-hidden="true">12</);
  assert.match(first[0].innerHTML, /class="t">完整问题 1/); // Desktop still has full labels.
  questions[3].status = 'answered'; context.selected = 'q12';
  for (let i = 0; i < 3; i++) context.renderNav();
  assert.equal(nav.querySelectorAll('.nav-progress').length, 1);
  assert.equal(nav.querySelectorAll('.nav-items').length, 1);
  assert.equal(nav.querySelectorAll('.item').length, 12);
  assert.equal(nav.querySelectorAll('.item.selected').length, 1);
  assert.equal(nav.querySelector('.item.selected').dataset.q, 'q12');
  assert.equal(nav.querySelector('.nav-progress').textContent, '第 12 / 12 题 · 已答 4');
  assert.deepEqual(JSON.parse(JSON.stringify(nav.querySelector('.item.selected').scrolled)), { block: 'nearest', inline: 'nearest' });
});

test('question chips support Enter and Space, restore focus after render and ignore other keys', () => {
  const { nav, context } = navigationFixture(); context.renderNav();
  let prevented = 0;
  nav.querySelectorAll('.item')[1].onkeydown({ key: 'Enter', preventDefault() { prevented++; } });
  assert.equal(context.selected, 'q2'); assert.equal(nav.querySelector('.item.selected').focused.preventScroll, true);
  nav.querySelectorAll('.item')[8].onkeydown({ key: ' ', preventDefault() { prevented++; } });
  assert.equal(context.selected, 'q9'); assert.equal(prevented, 2);
  nav.querySelectorAll('.item')[0].onkeydown({ key: 'ArrowRight', preventDefault() { prevented++; } });
  assert.equal(context.selected, 'q9'); assert.equal(prevented, 2);
});

function toolbarFixture(initialMobile) {
  const root = new Element('html'), header = new Element('header'), footer = new Element('footer'); root.append(header, footer);
  const home = new Element('a'); home.className = 'home-link'; header.append(home);
  const controls = ['terms-toggle', 'visualize', 'theme-toggle', 'levels-toggle', 'doc-path'].map(id => { const node = new Element(id.includes('toggle') || id === 'visualize' ? 'button' : 'span'); node.id = id; header.append(node); return node; });
  const kind = new Element('span'); kind.className = 'request-kind'; header.append(kind); controls.push(kind);
  let activations = 0; controls[0].onclick = () => { activations++; };
  const values = new Map(), styles = new Map(), listeners = {};
  const media = { matches: initialMobile, addEventListener(type, listener) { listeners[type] = listener; } };
  let ready;
  const context = {
    document: { querySelector: selector => root.querySelector(selector), createElement: tag => new Element(tag), createComment: () => new Element('comment'), documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } }, addEventListener(type, fn) { if (type === 'DOMContentLoaded') ready = fn; } },
    window: { matchMedia: query => { assert.equal(query, '(max-width:640px)'); return media; } },
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, String(value)) },
    sessionStorage: { getItem: () => null }, handoverHome: '/', handoverScope: '/grill/test/', S: {}, handoverReturnWhenAcknowledged() {},
  };
  vm.runInNewContext(bridge.slice(bridge.indexOf("document.addEventListener('DOMContentLoaded'")), context); ready();
  return { header, footer, controls, media, resize(value) { media.matches = value; listeners.change(); }, styles, values, activations: () => activations };
}

for (const initialMobile of [false, true]) test(`responsive More preserves control nodes and font handlers (initial mobile=${initialMobile})`, () => {
  const f = toolbarFixture(initialMobile), details = f.header.querySelector('.handover-more'), panel = details.querySelector('.handover-more-panel');
  assert.equal(details.tagName, 'DETAILS'); assert.equal(details.querySelector('summary').textContent, '更多');
  assert.equal(details.hidden, !initialMobile);
  for (const node of f.controls) assert.equal(node.parentNode, initialMobile ? panel : f.header);
  assert.equal(f.footer.querySelector('#handover-cancel').parentNode, f.footer);
  const fonts = f.header.querySelectorAll('.handover-size'); assert.equal(fonts.length, 2);
  const plus = fonts.find(node => node.textContent === '字号 +'), minus = fonts.find(node => node.textContent === '字号 −');
  assert.equal(f.styles.get('--handover-font'), '20px'); plus.click(); assert.equal(f.styles.get('--handover-font'), '22px');
  f.resize(true); assert.equal(details.hidden, false); f.controls[0].click(); assert.equal(f.activations(), 1);
  details.open = true; f.controls[0].click(); assert.equal(details.open, false); assert.equal(f.activations(), 2);
  details.open = true; f.controls.find(node => node.id === 'levels-toggle').click(); assert.equal(details.open, false);
  details.open = true; f.resize(false); assert.equal(details.hidden, true); assert.equal(details.open, false);
  for (const node of f.controls) assert.equal(node.parentNode, f.header);
  const order = f.header.children.filter(node => f.controls.includes(node)); assert.deepEqual(order, f.controls);
  details.open = true; f.controls[0].click(); assert.equal(details.open, true); assert.equal(f.activations(), 3);
  minus.click(); assert.equal(f.styles.get('--handover-font'), '20px');
  for (let i = 0; i < 3; i++) { f.resize(true); f.resize(false); }
  assert.equal(f.header.querySelectorAll('.handover-more').length, 1);
  assert.equal(f.header.querySelectorAll('.handover-size').length, 2);
  assert.equal(f.footer.querySelectorAll('#handover-cancel').length, 1);
  assert.equal(f.values.get('handover:font'), '20');
});

test('mobile CSS keeps desktop labels, adjustable option type and minimum touch actions', () => {
  assert.match(page, /\.nav-progress,\s*\.nav-number\s*\{\s*display:\s*none;?\s*\}/);
  assert.match(page, /\.nav-items\s*\{\s*display:\s*contents;?\s*\}/);
  assert.match(css, /@media\(max-width:640px\)/);
  assert.match(css, /header\{position:relative;display:grid;grid-template-columns:44px/);
  assert.match(css, /#main \.body,#main \.why,#main \.opt,#main \.rec\{font-size:calc\(var\(--handover-font\) \* \.9\)/);
  assert.match(css, /footer #finish-area button,footer #send,footer #handover-cancel\{min-height:44px/);
  assert.match(css, /\.handover-more:not\(\[open\]\) \.handover-more-panel\{display:none\}/);
  assert.match(page, /list\.classList\.toggle\("is-empty", !locked\(\) && !n && !sent && !note\)/);
});


test('navigation accessible status follows staged then pending then answered precedence', () => {
  const { nav, context } = navigationFixture();
  context.local.staged.q1 = { answer: { kind: 'text', text: 'draft' } };
  context.pendingActions = id => ['q1', 'q2'].includes(id) ? [{ type: 'answer' }] : id === 'q3' ? [{ type: 'explore' }] : [];
  context.renderNav();
  const items = nav.querySelectorAll('.item');
  assert.match(items[0].attrs['aria-label'], /（已暂存）$/);
  assert.match(items[1].attrs['aria-label'], /（已发送，等待回复）$/);
  assert.match(items[2].attrs['aria-label'], /（已回答）$/);
  assert.match(items[3].attrs['aria-label'], /（open）$/);
});


test('request context is full body text before each question, never HTML or a tool', () => {
  const main = new Element('main'); main.prepend = node => { node.parentNode = main; main.children.unshift(node); };
  const context = { S: { intent: '  Synthetic request context\n' + 'Detailed background. '.repeat(40) + '<img src=x onerror=alert(1)>  ' }, document: {getElementById: id => id === 'main' ? main : null, createElement: tag => new Element(tag)} };
  let selected = 'q1', renders = 0;
  context.renderMain = () => { renders++; main.innerHTML = ''; const card = new Element('section'); card.className = 'card'; card.textContent = selected; main.append(card); return selected; };
  const start = bridge.indexOf('// Request context belongs');
  const end = bridge.indexOf('// The upstream post function', start);
  vm.runInNewContext(bridge.slice(start,end), context);
  assert.equal(context.renderMain(), 'q1');
  assert.equal(main.children[0].className, 'handover-request-context');
  assert.equal(main.children[0].attrs['aria-label'], '请求背景');
  assert.equal(main.children[0].textContent, context.S.intent.trim());
  assert.equal(main.children[0].innerHTML, ''); // textContent, not parsed untrusted markup
  assert.equal(main.children[1].textContent, 'q1');
  selected = 'q2'; context.S.intent = 'Changed background\nsecond line';
  for (let i=0;i<4;i++) context.renderMain();
  assert.equal(main.querySelectorAll('.handover-request-context').length, 1);
  assert.equal(main.children[0].textContent, context.S.intent);
  assert.equal(main.children[1].textContent, 'q2');
  for (const empty of ['', '   ', null, 42]) { context.S.intent = empty; context.renderMain(); assert.equal(main.querySelectorAll('.handover-request-context').length, 0); }
  assert.equal(renders, 9);
  assert.match(css, /header #intent\{display:none!important\}/);
  assert.match(css, /white-space:pre-wrap;overflow:visible;overflow-wrap:anywhere;text-overflow:clip;max-height:none/);
  assert.match(css, /margin:0 0 32px;padding:4px 0 20px/);
  assert.match(css, /@media\(max-width:640px\)\{#main \.handover-request-context/);
  assert.doesNotMatch(bridge.match(/header\.querySelectorAll\(([^\n]+)/)[1], /#intent/);
});
