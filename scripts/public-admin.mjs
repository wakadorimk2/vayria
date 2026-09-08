import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const [action = 'report', argument] = process.argv.slice(2);
const url = new URL(process.env.VAYRIA_ADMIN_URL ?? 'https://invalid.invalid');
let secret = process.env.VAYRIA_ADMIN_SECRET;
if (!secret && url.hostname === 'staging.vayria.me') {
  try { secret = JSON.parse(await readFile('.wrangler/public-secrets.json', 'utf8')).ADMIN_SECRET; } catch { /* Require explicit credentials below. */ }
}
if (!secret || secret.length < 32 || url.hostname === 'invalid.invalid' || url.protocol !== 'https:') throw new Error('Set VAYRIA_ADMIN_URL (HTTPS) and VAYRIA_ADMIN_SECRET');
let command;
if (action === 'report') command = { op: 'report' };
else if (action === 'stop' || action === 'resume') command = { op: 'configure', stopped: action === 'stop' };
else if (action === 'configure' && argument) command = { op: 'configure', patch: JSON.parse(argument) };
else throw new Error('Usage: public-admin.mjs report|stop|resume|configure JSON');
const payload = Buffer.from(JSON.stringify({ purpose: 'admin', exp: Date.now() + 60000 })).toString('base64url');
const token = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
const response = await fetch(new URL('/api/admin', url), { method: 'POST', headers: {
  Origin: url.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
}, body: JSON.stringify(command) });
const result = await response.json(); console.log(JSON.stringify(result, null, 2));
if (!response.ok) process.exitCode = 1;
