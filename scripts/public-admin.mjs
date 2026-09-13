import { createHmac } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { adminCommand } from './public-admin-command.mjs';
import { adminTarget } from './public-admin-target.mjs';
const [action = 'report', argument] = process.argv.slice(2);
const command = adminCommand(action, argument);
const { url, staging } = adminTarget(process.env.VAYRIA_ADMIN_URL);
let secret = process.env.VAYRIA_ADMIN_SECRET;
if (!secret && staging) {
  try { secret = JSON.parse(await readFile('.wrangler/public-secrets.json', 'utf8')).ADMIN_SECRET; } catch { /* Require explicit credentials below. */ }
}
if (!secret || secret.length < 32 || url.hostname === 'invalid.invalid' || url.protocol !== 'https:') throw new Error('Set VAYRIA_ADMIN_URL (HTTPS) and VAYRIA_ADMIN_SECRET');
const payload = Buffer.from(JSON.stringify({ purpose: 'admin', exp: Date.now() + 60000 })).toString('base64url');
const token = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
const response = await fetch(url, { method: 'POST', redirect: 'error', headers: {
  Origin: url.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
}, body: JSON.stringify(command) });
const result = await response.json();
if(response.ok&&action==='world-create'){
  const {default:QRCode}=await import('qrcode');await mkdir('.wrangler',{recursive:true});
  const file=`.wrangler/world-${command.roomId}`;
  await writeFile(file+'.json',JSON.stringify(result,null,2));
  await writeFile(file+'-join.svg',await QRCode.toString(result.joinUrl,{type:'svg',margin:2}));
  console.log(`Room links saved to ${file}.json; participant QR saved to ${file}-join.svg. Keep the host link private.`);
}else console.log(JSON.stringify(result, null, 2));
if (!response.ok) process.exitCode = 1;
