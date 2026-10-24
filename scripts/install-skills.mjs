#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skills = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(os.homedir(), '.local/share/handover-ui/skill-backups', stamp);
fs.mkdirSync(skills, { recursive: true });
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
const installed = [];
for (const name of ['grill-with-ui', 'remote-handover']) {
  const destination = path.join(skills, name), staging = path.join(backup, name + '.new');
  fs.cpSync(path.join(root, 'skills', name), staging, { recursive: true });
  if (fs.existsSync(destination) || fs.lstatSync(destination, { throwIfNoEntry: false })) fs.renameSync(destination, path.join(backup, name));
  fs.renameSync(staging, destination);
  installed.push(destination);
}
const composite = path.join(skills, 'grill-with-docs-ui', 'SKILL.md');
if (fs.existsSync(composite)) {
  fs.copyFileSync(composite, path.join(backup, 'grill-with-docs-ui.SKILL.md'));
  fs.copyFileSync(path.join(root, 'scripts/grill-with-docs-ui.md'), composite);
}
console.log(JSON.stringify({ ok: true, installed, compositionUpdated: fs.existsSync(composite), backup }));
