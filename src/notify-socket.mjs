import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const notificationRoute = '/v1/handover-notifications';
const problem = (code) => Object.assign(new Error(code), {code});

// A Unix socket is the only transport. The receiver authenticates SO_PEERCRED;
// this side checks the configured socket owner and never follows redirects.
export function socketRequest({socketPath, socketUid, method, eventId, payload, timeoutMs = 3000, signal}) {
  if (!path.isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > 100) return Promise.reject(problem('INVALID_SOCKET_PATH'));
  try {
    const socket = fs.lstatSync(socketPath);
    if (!socket.isSocket() || socket.uid !== socketUid) throw problem('UNTRUSTED_SOCKET');
  } catch (error) { return Promise.reject(error); }
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  if (body && Buffer.byteLength(body) > 8192) return Promise.reject(problem('NOTIFICATION_TOO_LARGE'));
  return new Promise((resolve, reject) => {
    let timer;
    const request = http.request({socketPath, method, path:notificationRoute + (method === 'GET' ? '/' + encodeURIComponent(eventId) : ''), agent:false, signal,
      headers:{Host:'localhost', ...(body ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} : {})}}, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 4096) response.destroy(problem('RECEIPT_TOO_LARGE')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(problem('INVALID_RECEIPT')); return; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) { reject(problem('INVALID_RECEIPT')); return; }
        resolve({status:response.statusCode, data, retryAfter:response.headers['retry-after']});
      });
    });
    timer = setTimeout(() => request.destroy(problem('NOTIFY_TIMEOUT')), timeoutMs); timer.unref();
    request.once('close', () => clearTimeout(timer)); request.once('error', reject);
    request.end(body);
  });
}
