// Isolated synthetic handovers only. Does not start Unity or modify real test records.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { createHandoverServer } from '../src/server.mjs';

const root = path.resolve(process.env.MIDA_PROJECT_ROOT || '');
assert.ok(process.env.MIDA_PROJECT_ROOT, 'Set MIDA_PROJECT_ROOT to exercise the project Skill adapters');
const python = process.env.PYTHON || 'python3', exec = promisify(execFile);
const helper = path.join(root, '.agents/skills/mida-segment-autotest/scripts/review_handover.py');
const cli = path.resolve('cli.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-browser-'));
const output = fs.mkdtempSync(path.join(fs.mkdirSync(path.join(root, 'TestTemp/SegmentFlow/BridgeIntegration'), { recursive: true }) || path.join(root, 'TestTemp/SegmentFlow/BridgeIntegration'), 'case-'));
const app = createHandoverServer({ dataDir: path.join(dir, 'server'), agentToken: undefined, adminToken: crypto.randomBytes(32).toString('hex'), publicUrl: 'http://127.0.0.1:0', port: 0, disablePush: true });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const environment = { ...process.env, CODEX_THREAD_ID: 'isolated-mida-bridge-source', CLAUDE_SESSION_ID: '', HANDOVER_SKIP_UPDATE: '1', HANDOVER_NO_OPEN: '1', HANDOVER_STATE_DIR: path.join(dir, 'client-state'), HANDOVER_CONFIG: path.join(dir, 'absent-config.json'), HANDOVER_SERVER_URL: base, HANDOVER_USERNAME: 'Xpy', HANDOVER_AGENT_TOKEN: '' };
const run = async (argv, env = environment, project = root) => {
  try { const result = await exec(python, [helper, ...argv, '--root', project], { env, maxBuffer: 2 * 1024 * 1024 }); return JSON.parse(result.stdout.trim()); }
  catch (error) { throw new Error(`${argv[0]} failed: ${error.stdout || error.message}`); }
};
const { chromium } = await import(process.env.PLAYWRIGHT_PKG || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await context.newPage(), errors = [];
let downloads = 0;
page.on('download', () => downloads++);
page.on('pageerror', (error) => errors.push(error.message));
let resourceRoot;
const scoped = async (receipt, suffix, body) => {
  const h = JSON.parse(fs.readFileSync(receipt.handle));
  assert.equal(h.schema, 2); assert.equal(h.username, 'Xpy'); assert.equal(h.requestToken, undefined);
  const response = await fetch(base + `/api/requests/${h.id}${suffix}`, { method: body ? 'POST' : 'GET', headers: { 'X-Handover-Username': h.username, 'X-Handover-Source': h.source.session, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok); return response.json();
};
const fit = async () => {
  const dims = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth]);
  assert.ok(dims[1] <= dims[0] + 1, `outer overflow: ${dims}`);
  const inner = await page.frameLocator('#page').locator('body').evaluate(() => [innerWidth, document.documentElement.scrollWidth]);
  assert.ok(inner[1] <= inner[0] + 1, `inner overflow: ${inner}`);
};
try {
  const receipts = [];
  for (const skill of ['mida-segment-testing', 'mida-segment-autotest']) {
    const input = path.join(output, skill + '.json'), destination = path.join(output, skill);
    fs.writeFileSync(input, JSON.stringify({ topic: '合成数据 · ' + skill, context: '仅验证桥接，不是人工批准或业务结果', fields: [{ id: 'decision', label: '合成选择', type: 'choice', options: [{ id: 'defer', label: '合成暂缓' }] }, { id: 'details', label: '自定义 JSON', type: 'json', required: false }], feedbackMetadata: { fixture: true, ownContract: skill } }));
    const generated = await run(['prepare', '--skill', skill, '--input', input, '--out', destination]);
    const local = await run(['publish', '--manifest', generated.manifest, '--html', generated.html, '--client', path.join(dir, 'missing-client.mjs'), '--no-open']);
    assert.equal(local.transport, 'local'); assert.equal(app.store.list().length, receipts.length);
    // A server that lacks the capability must also fall back without creating a request.
    const legacy = http.createServer((req, res) => { assert.notEqual(req.method, 'POST'); res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); });
    await new Promise((resolve) => legacy.listen(0, '127.0.0.1', resolve));
    try {
      const result = await run(['publish', '--manifest', generated.manifest, '--html', generated.html, '--receipt', path.join(destination, 'legacy-handover.json'), '--client', cli, '--no-open'], { ...environment, HANDOVER_SERVER_URL: `http://127.0.0.1:${legacy.address().port}` });
      assert.equal(result.transport, 'local');
    } finally { legacy.closeAllConnections(); await new Promise((resolve) => legacy.close(resolve)); }
    const remote = await run(['publish', '--manifest', generated.manifest, '--html', generated.html, '--client', cli, '--no-open']);
    assert.equal(remote.transport, 'remote'); assert.equal(remote.status, 'waiting');
    const duplicate = await run(['publish', '--manifest', generated.manifest, '--html', generated.html, '--client', cli, '--no-open']);
    assert.equal(duplicate.requestId, remote.requestId); assert.equal(duplicate.reused, true);
    receipts.push({ ...remote, generated });
  }
  // An unknown creation result is durable and never becomes another new request.
  const unknownClient = path.join(dir, 'unknown-client.mjs'), counter = path.join(dir, 'unknown-counter');
  fs.writeFileSync(unknownClient, `import fs from 'node:fs';const command=process.argv[2];if(command==='probe')console.log(JSON.stringify({available:true,customPage:{version:1,maxHtmlBytes:4194304}}));else{fs.appendFileSync(${JSON.stringify(counter)},'new\\n');console.log(JSON.stringify({ok:false,note:'synthetic unknown result'}));process.exitCode=1;}`);
  const unknownArgs = [helper,'publish','--manifest',receipts[0].generated.manifest,'--html',receipts[0].generated.html,'--receipt',path.join(output,'unknown-handover.json'),'--client',unknownClient,'--no-open','--root',root];
  for(let attempt=0;attempt<2;attempt++){
    let response;try{await exec(python,unknownArgs,{env:environment});assert.fail('unknown must not report success');}catch(error){response=JSON.parse(error.stdout);}
    assert.equal(response.status,'unknown');if(attempt)assert.equal(response.reused,true);
  }
  assert.equal(fs.readFileSync(counter,'utf8').trim(),'new');
  // Reuse the resource Skill's explicit synthetic fixture and its original validator.
  const synthetic = `import sys,json\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1])/'.agents/skills/mida-resource-packaging/scripts'))\nfrom test_resource_review import ResourceReviewTests\nimport resource_review as rr\nt=ResourceReviewTests();t.setUp();t.temp._finalizer.detach()\nm=rr.make_review(t.root,'scope.json',['report.json'],'plans.json')\nout=t.root/rr.OUTPUT_ROOT/'bridge-page';out.mkdir(parents=True)\n(out/'review.json').write_text(json.dumps(m));(out/'review.html').write_text(rr.render(m))\nprint(json.dumps({'root':str(t.root),'manifest':str(out/'review.json'),'html':str(out/'review.html')}))\n`;
  const resourceFixture = JSON.parse((await exec(python, ['-B', '-c', synthetic, root], { env: environment })).stdout);
  resourceRoot = resourceFixture.root;
  const vmRegression=await exec(process.execPath,[path.join(root,'.agents/skills/mida-resource-packaging/scripts/test_review_ui.cjs'),resourceFixture.manifest]);assert.match(vmRegression.stdout,/PASS/);
  const resourceReceipt = await run(['publish', '--manifest', resourceFixture.manifest, '--html', resourceFixture.html, '--client', cli, '--no-open'], environment, resourceRoot);
  assert.equal(resourceReceipt.transport, 'remote'); receipts.push({ ...resourceReceipt, resource: true });
  for (const [index, receipt] of receipts.entries()) {
    assert.equal(new URL(receipt.url).searchParams.get('username'), 'Xpy');
    const target = new URL(receipt.url);
    await page.goto(base + target.pathname + target.search);
    if (index === 0) {
      await page.locator('#username').waitFor();
      assert.equal(await page.locator('#username').inputValue(), '');
      await page.locator('#username').fill('Xpy');
      await page.locator('#username-form button[type="submit"]').click();
      await page.waitForURL(base + target.pathname + target.search);
    }
    const frame = page.frameLocator('#page');
    if (receipt.resource) {
      await frame.locator('input[value="keep"]').first().waitFor();
      for (const input of await frame.locator('input[value="keep"]').all()) await input.check();
      if (await frame.locator('#normal-confirm').isEnabled()) await frame.locator('#normal-confirm').check();
    } else {
      await frame.locator('select').first().selectOption('defer');
      await frame.getByRole('textbox', { name: '自定义 JSON' }).fill('{"custom":[1,2],"fixture":true}');
    }
    await fit();
    await frame.locator('#export').click();
    await frame.locator('#export-json').waitFor({ timeout: 2000 });
    const exportedPath = path.join(receipt.resource ? resourceRoot : output, 'TestTemp/SegmentFlow', `remote-feedback-${index}.json`);
    fs.mkdirSync(path.dirname(exportedPath), {recursive:true});
    fs.writeFileSync(exportedPath, await frame.locator('#export-json').inputValue());
    assert.equal((await run(['validate', '--manifest', receipt.manifest, '--decisions', exportedPath], environment, receipt.resource ? resourceRoot : root)).selectionValid, true);
    // Clipboard branches use a local stub so this test never overwrites the user's clipboard.
    await frame.locator('body').evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.isolatedCopiedJSON = text; } } }));
    await frame.locator('#copy-json').click();
    assert.equal(await frame.locator('body').evaluate(() => window.isolatedCopiedJSON), await frame.locator('#export-json').inputValue());
    await frame.locator('body').evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('isolated permission denial'); }; });
    await frame.locator('#copy-json').click();
    assert.match(await frame.locator('#export-hint').textContent(), /请使用系统复制/);
    assert.equal(await frame.locator('#export-json').evaluate((node) => node.selectionEnd - node.selectionStart), (await frame.locator('#export-json').inputValue()).length);
    await fit();
    const isolated = await frame.locator('body').evaluate(() => { try { return document.cookie; } catch (error) { return error.name; } });
    assert.equal(isolated, 'SecurityError');
    const send = receipt.resource ? frame.locator('#send-remote') : frame.locator('#remote');
    if (index === 0) await page.route('**/feedback?username=Xpy', (route) => route.abort());
    await send.click();
    if (index === 0) {
      await page.locator('#retry').waitFor({ state: 'visible' });
      assert.equal((await scoped(receipt, '/wait?timeout=0')).events.length, 0);
      await page.unroute('**/feedback?username=Xpy'); await page.locator('#retry').click();
    }
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('等待来源'));
    const before = await scoped(receipt, '/wait?timeout=0');
    assert.equal(before.events.length, 1); assert.equal(before.handled, 0);
    assert.equal(before.username, 'Xpy'); assert.equal(before.events[0].username, 'Xpy');
    const collected = await run(['collect', '--receipt', receipt.receipt, '--out', path.join(receipt.resource ? resourceRoot : output, 'TestTemp/SegmentFlow/received-' + index), '--timeout', '0'], environment, receipt.resource ? resourceRoot : root);
    assert.equal(collected.ackRequired, true); assert.equal(collected.received.length, 1);
    const returned = JSON.parse(fs.readFileSync(collected.received[0].json));
    assert.equal(returned.executionAuthorized, false);
    if (!receipt.resource) assert.deepEqual(returned.answers.details.custom, [1, 2]);
    assert.equal((await scoped(receipt, '/wait?timeout=0')).events.length, 1, 'collect must not acknowledge');
    if (index === 1) {
      await frame.locator('#comment').fill('确认后应保留的合成新草稿');
      await page.waitForTimeout(100);
      await scoped(receipt, '/ack', { seq: 1 });
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('保留你新写入'));
      assert.equal(new URL(page.url()).pathname, `/grill/${receipt.requestId}/`);
    } else {
      await page.reload(); await page.frameLocator('#page').locator('body').waitFor();
      await scoped(receipt, '/ack', { seq: 1 }); await page.waitForURL(base + '/?username=Xpy');
    }
  }
  // Offline pages retain the same JSON export contract with no remote SDK.
  const localPage = await context.newPage();
  localPage.on('download', () => downloads++);
  await localPage.goto('file://' + receipts[0].generated.html);
  await localPage.locator('select').selectOption('defer');
  assert.equal(await localPage.locator('#remote').isVisible(), false);
  await localPage.locator('#export').click();
  const destination = path.join(output, 'offline-feedback.json');
  fs.writeFileSync(destination, await localPage.locator('#export-json').inputValue());
  assert.equal((await run(['validate', '--manifest', receipts[0].generated.manifest, '--decisions', destination])).selectionValid, true);
  await localPage.close();
  await scoped(receipts[1], '/cancel', {});
  const cancelledCollection = await run(['collect', '--receipt', receipts[1].receipt, '--out', path.join(output, 'cancelled-received'), '--timeout', '0']);
  assert.equal(cancelledCollection.status, 'cancelled');
  assert.equal(cancelledCollection.ackRequired, false); assert.deepEqual(cancelledCollection.received, []);
  assert.equal((await context.cookies()).length, 0, '用户名页面不需要登录或 Cookie');
  assert.equal(Object.keys(app.store.all('tickets')).length, 0);
  assert.equal(Object.keys(app.store.all('sessions')).length, 0);
  assert.equal(downloads, 0, '复制 JSON 不触发文件下载');
  assert.deepEqual(errors, []);
  console.log('PASS: 三份 Skill 用户名直达、自有页面、JSON 复制与拒绝分支（隔离替身）、无文件下载、离线回退、取消状态、隔离、重试幂等、原样回传、手动确认及新草稿保护，无 token、登录票据或 Cookie');
} finally {
  await browser.close(); app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(output, { recursive: true, force: true });
  if (resourceRoot) fs.rmSync(resourceRoot, { recursive: true, force: true });
}
