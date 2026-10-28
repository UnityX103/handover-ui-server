#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installBundle } from '../skills/grill-with-ui/scripts/install.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'skills/manifest.json'), 'utf8'));
const files = Object.fromEntries(manifest.files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
let version = null, localBase = null;
try {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'skills', 'scripts/install-skills.mjs', 'scripts/grill-with-docs-ui.md'], { encoding: 'utf8' }).trim()) version = head;
  else localBase = head;
} catch {}
console.log(JSON.stringify(installBundle({ manifest, files, version, localBase })));
