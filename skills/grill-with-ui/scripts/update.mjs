import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repository, branch, skillsDirectory, backupDirectory, validateManifest, installBundle } from './install.mjs';

const exec = promisify(execFile);
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } };
export const publicRemote = `https://github.com/${repository}.git`;
export async function publicGit(args, run = exec) {
  // Ignore local/global rewrites, credential helpers, extra headers and ~/.netrc.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-public-git-'));
  try {
    const env = { PATH: process.env.PATH || '', HOME: directory, USERPROFILE: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'no-config'), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
    for (const key of ['SystemRoot', 'WINDIR', 'SYSTEMDRIVE', 'TMP', 'TEMP']) if (process.env[key]) env[key] = process.env[key];
    return (await run('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.extraHeader=', '-c', 'http.followRedirects=false', ...args], { cwd: directory, encoding: 'utf8', timeout: 12000, maxBuffer: 4096, env })).stdout;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
export async function publicContents(file, version, fetcher = globalThis.fetch) {
  const url = `https://raw.githubusercontent.com/${repository}/${version}/${file.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetcher(url, { headers: { Accept: 'text/plain' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok || !response.body) throw new Error('公开 Skill 文件下载失败');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 262144) throw new Error('公开 Skill 文件过大'); chunks.push(value); } }
  finally { await reader.cancel().catch(()=>{}); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export async function updateSkills({ git = publicGit, contents: download = publicContents, skillsDir = skillsDirectory(), backupsDir = backupDirectory(), lockFile = path.join(process.env.HANDOVER_STATE_DIR || path.join(os.homedir(), '.local/state/handover-ui'), 'skill-update.lock') } = {}) {
  let ownsLock = false, checked = false;
  const lockId = crypto.randomUUID();
  try {
    const head = (await git(['ls-remote', publicRemote, `refs/heads/${branch}`])).trim();
    const match = head.match(new RegExp(`^([0-9a-f]{40})\\trefs/heads/${branch}$`));
    if (!match) throw new Error('公开 Git 远端没有返回唯一合法 main 提交');
    const version = match[1];
    checked = true;
    const installed = read(path.join(skillsDir, 'grill-with-ui/.handover-install.json'));
    if (installed.repository === repository && installed.branch === branch && installed.commit === version) return { ok: true, checked: true, updated: false, version };
    fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
    const previous = read(lockFile);
    if (previous.recoveryNeeded) return { ok: false, checked: true, updated: false, status: 'recovery-needed', backup: previous.backup, note: '上次更新仍需人工恢复，已停止自动安装；请检查备份与更新锁。' };
    if (previous.pid) {
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) return { ok: true, checked: true, updated: false, status: 'updating', version, note: '另一个会话正在更新 Skill，本次保留现有客户端和请求。' };
      return { ok: false, checked: true, updated: false, status: 'stale-lock', version, note: '发现已退出会话的更新锁；为避免并发覆盖，本次保留现有 Skill。请核实没有更新进程后人工恢复。' };
    }
    try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, id: lockId }), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return { ok: true, checked: true, updated: false, status: 'updating', version }; throw error; }
    ownsLock = true;
    const contents = (file) => download(file, version);
    const manifest = validateManifest(JSON.parse(await contents('skills/manifest.json')));
    const entries = await Promise.all(manifest.files.map(async (file) => [file, await contents(file)]));
    const result = installBundle({ manifest, files: Object.fromEntries(entries), version, skillsDir, backupsDir });
    return { ...result, checked: true, updated: true };
  } catch (error) {
    if (error.recoveryNeeded) {
      // Retain the owned lock to prevent a later auto-update overwriting recovery evidence.
      try { if (read(lockFile).id === lockId) fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, id: lockId, recoveryNeeded: true, backup: error.backup }), { mode: 0o600 }); } catch {}
      ownsLock = false;
      return { ok: false, checked, updated: false, status: 'recovery-needed', backup: error.backup, note: '更新未完成且部分恢复失败；原文件保留在备份目录，请先人工恢复，不要重复安装。' };
    }
    return { ok: false, checked, updated: false, status: 'unavailable', note: '无法完成 GitHub 更新检查或安装，已保留现有 Skill。请检查 Git 安装、公开 GitHub 网络访问或本地权限；无需 gh 登录或访问令牌。' };
  } finally {
    // Cleanup must not abort the original handover or remove another updater's lock.
    try { if (ownsLock && read(lockFile).id === lockId) fs.rmSync(lockFile, { force: true }); } catch {}
  }
}
