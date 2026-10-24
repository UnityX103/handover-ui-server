import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installBundle } from '../skills/grill-with-ui/scripts/install.mjs';
import { updateSkills } from '../skills/grill-with-ui/scripts/update.mjs';

const oldVersion = 'a'.repeat(40), latestVersion = 'b'.repeat(40);
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('skills/manifest.json', root), 'utf8'));
const files = Object.fromEntries(manifest.files.map((file) => [file, fs.readFileSync(new URL(file, root), 'utf8')]));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const skillsDir = path.join(dir, 'skills'), backupsDir = path.join(dir, 'backups'), lockFile = path.join(dir, 'state/update.lock');
  fs.mkdirSync(path.join(skillsDir, 'grill-with-docs-ui'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'grill-with-docs-ui/SKILL.md'), 'existing composition');
  installBundle({ manifest, files, version: oldVersion, skillsDir, backupsDir });
  const calls = [];
  const github = async (args) => {
    calls.push(args);
    if (args[1].endsWith('/commits/main')) return latestVersion + '\n';
    const target = new URL('https://api.github.com/' + args.at(-1));
    assert.equal(target.searchParams.get('ref'), latestVersion);
    const file = target.pathname.split('/contents/')[1];
    if (file === 'skills/manifest.json') return JSON.stringify(manifest);
    assert.ok(Object.hasOwn(files, file), file);
    return files[file] + '\n';
  };
  return { dir, skillsDir, backupsDir, lockFile, github, calls };
}

test('Skill 已是 GitHub main 最新版时，仅检查一次且不重复安装', async (t) => {
  const f = fixture(t);
  const result = await updateSkills({ ...f, github: async (args) => { f.calls.push(args); return oldVersion + '\n'; } });
  assert.equal(result.checked, true); assert.equal(result.updated, false); assert.equal(f.calls.length, 1);
  assert.equal(fs.readdirSync(f.backupsDir).length, 1);
  assert.equal(fs.readFileSync(path.join(f.skillsDir, 'grill-with-ui/SKILL.md'), 'utf8'), files['skills/grill-with-ui/SKILL.md']);
});

test('Skill 更新固定到同一提交，备份两份 Skill 并保留凭据和请求状态', async (t) => {
  const f = fixture(t);
  const privateState = path.join(f.dir, 'private-state.json');
  fs.writeFileSync(privateState, 'isolated config and request fixture', { mode: 0o600 });
  const result = await updateSkills(f);
  assert.equal(result.updated, true); assert.equal(result.version, latestVersion);
  assert.equal(f.calls.length, manifest.files.length + 2);
  for (const file of manifest.files.filter((file) => file.startsWith('skills/'))) assert.equal(fs.readFileSync(path.join(f.skillsDir, file.slice(7)), 'utf8'), files[file] + '\n');
  assert.equal(fs.readFileSync(path.join(result.backup, 'remote-handover/SKILL.md'), 'utf8'), files['skills/remote-handover/SKILL.md']);
  assert.equal(fs.readFileSync(path.join(f.skillsDir, 'grill-with-docs-ui/SKILL.md'), 'utf8'), files['scripts/grill-with-docs-ui.md'] + '\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.skillsDir, 'grill-with-ui/.handover-install.json'))).commit, latestVersion);
  assert.equal(fs.readFileSync(privateState, 'utf8'), 'isolated config and request fixture');
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('下载失败时保留当前 Skill 和版本，不留下更新锁', async (t) => {
  const f = fixture(t);
  const result = await updateSkills({ ...f, github: async (args) => {
    if (args.at(-1).includes('/contents/skills/remote-handover/')) throw new Error('isolated network failure');
    return f.github(args);
  } });
  assert.equal(result.ok, false); assert.equal(result.updated, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.skillsDir, 'grill-with-ui/.handover-install.json'))).commit, oldVersion);
  assert.equal(fs.readFileSync(path.join(f.skillsDir, 'remote-handover/SKILL.md'), 'utf8'), files['skills/remote-handover/SKILL.md']);
  assert.equal(fs.existsSync(f.lockFile), false);
  assert.equal(fs.readdirSync(f.backupsDir).length, 1);
});

test('拒绝写入 Skill 范围之外的更新路径', async (t) => {
  const f = fixture(t);
  const result = await updateSkills({ ...f, github: async (args) => {
    if (args.at(-1).includes('/contents/skills/manifest.json?')) return JSON.stringify({ schema: 1, files: [...manifest.files, 'skills/grill-with-ui/../../outside.txt'] });
    return f.github(args);
  } });
  assert.equal(result.ok, false); assert.equal(fs.existsSync(path.join(f.dir, 'outside.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.skillsDir, 'grill-with-ui/.handover-install.json'))).commit, oldVersion);
});

test('多个来源同时检查更新时，不覆盖另一个仍在运行的安装', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.lockFile), { recursive: true });
  const lock = { pid: process.pid, id: 'isolated-owner' };
  fs.writeFileSync(f.lockFile, JSON.stringify(lock));
  const result = await updateSkills(f);
  assert.equal(result.status, 'updating'); assert.equal(result.updated, false); assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.lockFile)), lock);
  assert.equal(fs.readdirSync(f.backupsDir).length, 1);
});
