import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const repository = 'UnityX103/handover-ui-server';
export const branch = 'main';
export const names = ['grill-with-ui', 'remote-handover'];
export const composition = 'scripts/grill-with-docs-ui.md';
export const skillsDirectory = () => path.resolve(process.env.HANDOVER_SKILLS_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills'));
export const backupDirectory = () => process.env.HANDOVER_SKILL_BACKUP_DIR || path.join(os.homedir(), '.local/share/handover-ui/skill-backups');

export function validateManifest(manifest) {
  if (manifest?.schema !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 50 || new Set(manifest.files).size !== manifest.files.length) throw new Error('Skill 更新清单格式不合法');
  for (const file of manifest.files) {
    if (typeof file !== 'string' || file.includes('\\') || file.split('/').some((part) => !part || part === '.' || part === '..') || (file !== composition && !names.some((name) => file.startsWith(`skills/${name}/`)))) throw new Error('Skill 更新清单包含范围外路径');
  }
  for (const required of ['skills/grill-with-ui/SKILL.md', 'skills/grill-with-ui/scripts/handover.mjs', 'skills/grill-with-ui/scripts/update.mjs', 'skills/grill-with-ui/scripts/install.mjs', 'skills/remote-handover/SKILL.md', composition]) {
    if (!manifest.files.includes(required)) throw new Error('Skill 更新清单缺少必要文件');
  }
  return manifest;
}

export function installBundle({ manifest, files, version, localBase = null, skillsDir = skillsDirectory(), backupsDir = backupDirectory() }) {
  validateManifest(manifest);
  if (version !== null && !/^[0-9a-f]{40}$/.test(version)) throw new Error('Skill 版本必须是完整提交 SHA');
  if (localBase !== null && (version !== null || !/^[0-9a-f]{40}$/.test(localBase))) throw new Error('本机修改基线必须是完整提交 SHA，且不能冒充已发布版本');
  let size = 0;
  for (const file of manifest.files) {
    if (typeof files[file] !== 'string' || Buffer.byteLength(files[file]) > 262144) throw new Error('Skill 文件缺失或过大');
    size += Buffer.byteLength(files[file]);
  }
  if (size > 2097152) throw new Error('Skill 更新总量过大');
  const backup = path.join(backupsDir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const file of manifest.files.filter((file) => file.startsWith('skills/'))) {
    const [name, ...parts] = file.slice(7).split('/');
    const target = path.join(backup, name + '.new', ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, files[file], { mode: 0o600, flag: 'wx' });
  }
  const metadata = { schema: 1, repository, branch, commit: version, ...(localBase ? {localBase} : {}), installed: new Date().toISOString() };
  fs.writeFileSync(path.join(backup, 'grill-with-ui.new/.handover-install.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  const composite = path.join(skillsDir, 'grill-with-docs-ui/SKILL.md');
  const compositionUpdated = fs.existsSync(composite);
  const compositeStage = path.join(backup, 'grill-with-docs-ui.new.md');
  if (compositionUpdated) {
    fs.copyFileSync(composite, path.join(backup, 'grill-with-docs-ui.SKILL.md'));
    fs.writeFileSync(compositeStage, files[composition], { mode: 0o600 });
  }
  const moved = [];
  try {
    for (const name of names) {
      const destination = path.join(skillsDir, name), previous = path.join(backup, name);
      const item = { destination, previous, existed: !!fs.lstatSync(destination, { throwIfNoEntry: false }), installed: false };
      if (item.existed) fs.renameSync(destination, previous);
      moved.push(item);
      fs.renameSync(path.join(backup, name + '.new'), destination); item.installed = true;
    }
    if (compositionUpdated) fs.renameSync(compositeStage, composite);
  } catch (error) {
    const recoveryErrors = [];
    for (const item of moved.reverse()) {
      try {
        if (item.installed) fs.rmSync(item.destination, { recursive: true, force: true });
        if (item.existed) fs.renameSync(item.previous, item.destination);
      } catch (recoveryError) { recoveryErrors.push(recoveryError); }
    }
    if (recoveryErrors.length) throw Object.assign(new Error('Skill 更新失败且部分恢复未完成；原文件保留在备份中'), { recoveryNeeded: true, backup });
    throw error;
  }
  return { ok: true, installed: names.map((name) => path.join(skillsDir, name)), compositionUpdated, backup, version, ...(localBase ? {localBase} : {}), entrypoint: path.join(skillsDir, 'grill-with-ui/scripts/handover.mjs') };
}
