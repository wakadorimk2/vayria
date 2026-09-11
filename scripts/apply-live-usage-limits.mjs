import { readFile, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminTarget } from './public-admin-target.mjs';

export async function applyLiveUsageLimits({ environment, secret, recordPath, fetchImpl = fetch }) {
  if (!['staging', 'production'].includes(environment) || !secret || secret.length < 32 || !recordPath) throw new Error('Environment, admin credential and new record path are required.');
  const profiles = JSON.parse(await readFile(new URL('../deploy/live-usage-limits.json', import.meta.url), 'utf8'));
  const patch = profiles[environment];
  const { url } = adminTarget(environment === 'staging' ? 'https://vayria.me/staging' : 'https://vayria.me');
  const request = async command => {
    const payload = Buffer.from(JSON.stringify({ purpose: 'admin', exp: Date.now() + 60000 })).toString('base64url');
    const token = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Origin: url.origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    if (!response.ok) throw new Error(`Management API returned ${response.status}.`);
    return response.json();
  };
  const snapshot = report => ({ limits: report.limits, stopped: report.stopped, dayYen: report.dayYen, monthApiYen: report.monthApiYen, activeJobs: report.activeJobs });
  const before = snapshot(await request({ op: 'report' }));
  const record = { environment, capturedAt: new Date().toISOString(), before, patch };
  // A new file must exist before any mutation. No credentials or visitor IDs are written.
  await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  const expected = { ...before.limits, ...patch };
  await request({ op: 'configure', patch });
  const after = snapshot(await request({ op: 'report' }));
  record.after = after; record.verifiedAt = new Date().toISOString();
  await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n');
  if (JSON.stringify(Object.entries(after.limits).sort()) !== JSON.stringify(Object.entries(expected).sort()) || after.stopped !== before.stopped) throw new Error('Readback differs from the requested limits; inspect the saved record.');
  return { environment, limits: after.limits, recordPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyLiveUsageLimits({ environment: process.argv[2], recordPath: process.argv[3], secret: process.env.VAYRIA_ADMIN_SECRET })
    .then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
