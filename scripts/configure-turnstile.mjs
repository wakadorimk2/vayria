// Configure only Turnstile. Never print or write secret keys to tracked files.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const account = '7414797104d7aca62f03fbd4faf7e5df';
const auth = await readFile(join(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'), 'utf8');
const token = auth.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!token) throw new Error('Wrangler login required');
async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok || !value.success) throw new Error(`Cloudflare ${method} failed: HTTP ${response.status}`);
  return value.result;
}
const widgets = await api('challenges/widgets');
for (const target of [
  { name: 'Vayria staging', domain: 'vayria.me', worker: 'vayria-public-staging', config: 'wrangler.public.jsonc' },
  { name: 'Vayria production', domain: 'vayria.me', worker: 'vayria-web', config: 'wrangler.production.jsonc' },
]) {
  if (process.argv.includes('--staging') && target.worker !== 'vayria-public-staging') continue;
  const config = JSON.parse(await readFile(target.config, 'utf8'));
  let widget = widgets.find(w => w.name === target.name);
  if (config.vars.TURNSTILE_SITE_KEY && widget?.sitekey !== config.vars.TURNSTILE_SITE_KEY) throw new Error(`Configured widget mismatch for ${target.name}`);
  if (widget) {
    widget = await api(`challenges/widgets/${widget.sitekey}`);
    if (target.worker === 'vayria-public-staging' && !widget.domains.includes(target.domain) && widget.mode === 'managed') {
      widget = await api(`challenges/widgets/${widget.sitekey}`, 'PUT', {
        name: widget.name, domains: [...widget.domains, target.domain], mode: widget.mode,
      });
    }
    if (!widget.domains.includes(target.domain) || widget.mode !== 'managed' ||
        (target.worker === 'vayria-web' && widget.domains.length !== 1)) {
      throw new Error(`Review existing widget settings for ${target.name}`);
    }
  } else {
    widget = await api('challenges/widgets', 'POST', { name: target.name, domains: [target.domain], mode: 'managed' });
  }
  await api(`workers/scripts/${target.worker}/secrets`, 'PUT', { name: 'TURNSTILE_SECRET', text: widget.secret, type: 'secret_text' });
  config.vars.TURNSTILE_SITE_KEY = widget.sitekey;
  await writeFile(target.config, JSON.stringify(config, null, 2) + '\n');
  const verified = await api(`challenges/widgets/${widget.sitekey}`);
  const secrets = await api(`workers/scripts/${target.worker}/secrets`);
  if (!secrets.some(s => s.name === 'TURNSTILE_SECRET')) throw new Error('Worker secret registration failed');
  console.log(JSON.stringify({ worker: target.worker, domain: verified.domains, mode: verified.mode, siteKey: verified.sitekey, secretRegistered: true }));
}
