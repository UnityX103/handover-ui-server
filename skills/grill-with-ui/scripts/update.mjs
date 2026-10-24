import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repository, branch, skillsDirectory, backupDirectory, validateManifest, installBundle } from './install.mjs';

const exec = promisify(execFile);
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } };
const githubCli = async (args) => (await exec('gh', args, { encoding: 'utf8', timeout: 12000, maxBuffer: 524288, env: { ...process.env, GH_PROMPT_DISABLED: '1' } })).stdout;

export async function updateSkills({ github = githubCli, skillsDir = skillsDirectory(), backupsDir = backupDirectory(), lockFile = path.join(process.env.HANDOVER_STATE_DIR || path.join(os.homedir(), '.local/state/handover-ui'), 'skill-update.lock') } = {}) {
  let ownsLock = false, checked = false;
  const lockId = crypto.randomUUID();
  try {
    const version = (await github(['api', `repos/${repository}/commits/${branch}`, '--jq', '.sha'])).trim();
    if (!/^[0-9a-f]{40}$/.test(version)) throw new Error('GitHub 没有返回合法提交版本');
    checked = true;
    const installed = read(path.join(skillsDir, 'grill-with-ui/.handover-install.json'));
    if (installed.repository === repository && installed.branch === branch && installed.commit === version) return { ok: true, checked: true, updated: false, version };
    fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
    const previous = read(lockFile);
    if (previous.pid) {
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) return { ok: true, checked: true, updated: false, status: 'updating', version, note: '另一个会话正在更新 Skill，本次保留现有客户端和请求。' };
      fs.rmSync(lockFile, { force: true });
    }
    try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, id: lockId }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return { ok: true, checked: true, updated: false, status: 'updating', version }; throw error; }
    ownsLock = true;
    const contents = (file) => github(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repository}/contents/${file}?ref=${version}`]);
    const manifest = validateManifest(JSON.parse(await contents('skills/manifest.json')));
    const entries = await Promise.all(manifest.files.map(async (file) => [file, await contents(file)]));
    const result = installBundle({ manifest, files: Object.fromEntries(entries), version, skillsDir, backupsDir });
    return { ...result, checked: true, updated: true };
  } catch {
    return { ok: false, checked, updated: false, status: 'unavailable', note: '无法完成 GitHub 更新检查或安装，已保留现有 Skill。请检查 GitHub 访问、gh 登录状态或本地权限。' };
  } finally {
    if (ownsLock && read(lockFile).id === lockId) fs.rmSync(lockFile, { force: true });
  }
}
