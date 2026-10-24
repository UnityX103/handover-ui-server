import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
export const token = () => crypto.randomBytes(32).toString('base64url');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export const now = () => new Date().toISOString();
export const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(id);
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.rmSync(tmp, { force: true }); }
}
export function read(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.dir('requests'), { recursive: true, mode: 0o700 });
  }
  dir(...parts) { return path.join(this.root, ...parts); }
  file(id) { if (!validId(id)) throw new Error('无效请求 ID'); return this.dir('requests', `${id}.json`); }
  get(id) { return read(this.file(id)); }
  put(request) { atomic(this.file(request.id), request); }
  list() {
    return fs.readdirSync(this.dir('requests')).filter((x) => /^[a-zA-Z0-9_-]+\.json$/.test(x))
      .map((x) => read(this.dir('requests', x))).filter(Boolean).sort((a, b) => b.created.localeCompare(a.created));
  }
  all(name) { return read(this.dir(`${name}.json`), {}); }
  save(name, value) { atomic(this.dir(`${name}.json`), value); }
}
