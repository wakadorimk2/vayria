// Run through Start-VayriaWithOnePassword.ps1. Never print API credentials.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
const account = '7414797104d7aca62f03fbd4faf7e5df';
const domain = 'staging.vayria.me';
if (!process.env.OPENAI_API_KEY || !process.env.AIVIS_CLOUD_API_KEY) throw new Error('Both provider credentials must be supplied by 1Password');
const auth = await readFile(join(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'), 'utf8');
const token = auth.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!token) throw new Error('Wrangler login required');
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`Cloudflare ${method} failed: HTTP ${response.status}`);
  return result.result;
};
const widgets = await api('challenges/widgets');
let widget = widgets.find(value => value.name === 'Vayria staging' && value.domains.includes(domain));
if (!widget) widget = await api('challenges/widgets', 'POST', { name: 'Vayria staging', domains: [domain], mode: 'managed' });
else widget = await api(`challenges/widgets/${widget.sitekey}`);
await mkdir('.wrangler', { recursive: true });
let secrets = {};
try { secrets = JSON.parse(await readFile('.wrangler/public-secrets.json', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const key of ['COOKIE_SECRET', 'IP_SECRET', 'ADMIN_SECRET', 'PREVIEW_SECRET']) secrets[key] ??= randomBytes(32).toString('hex');
Object.assign(secrets, { OPENAI_API_KEY: process.env.OPENAI_API_KEY, AIVIS_API_KEY: process.env.AIVIS_CLOUD_API_KEY, TURNSTILE_SECRET: widget.secret });
await writeFile('.wrangler/public-secrets.json', JSON.stringify(secrets), { mode: 0o600 });
const payload = Buffer.from(JSON.stringify({ purpose: 'preview', exp: Date.now() + 86400000 })).toString('base64url');
await writeFile('.wrangler/public-preview-ticket.txt', payload + '.' + createHmac('sha256', secrets.PREVIEW_SECRET).update(payload).digest('base64url'), { mode: 0o600 });
const config = JSON.parse(await readFile('wrangler.public.jsonc', 'utf8'));
config.vars.TURNSTILE_SITE_KEY = widget.sitekey;
await writeFile('wrangler.public.jsonc', JSON.stringify(config, null, 2) + '\n');
console.log('Staging Turnstile prepared. Secrets and one-day access ticket saved under ignored .wrangler/.');
