import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateTarget, validateVrm, validateRevision } from './staging-cd.mjs';
const config = JSON.parse(await readFile('wrangler.public.jsonc', 'utf8'));
test('staging target guard rejects production and extra routes', () => {
  validateTarget(config);
  for (const patch of [{ name: 'vayria-web' }, { routes: [{ pattern: 'vayria.me', custom_domain: true }] },
    { routes: [...config.routes, { pattern: 'vayria.me' }] }, { workers_dev: true }, { vars: { ...config.vars, REQUIRE_PREVIEW_ACCESS: 'false' } }])
    assert.throws(() => validateTarget({ ...config, ...patch }));
});
test('only the current successful main push revision can pass', () => {
  const sha = 'a'.repeat(40); const other = 'b'.repeat(40);
  validateRevision('push', 'refs/heads/main', sha, sha, sha);
  for (const args of [['pull_request', 'refs/heads/main', sha, sha, sha], ['push', 'refs/heads/topic', sha, sha, sha],
    ['push', 'refs/heads/main', sha, other, sha], ['push', 'refs/heads/main', sha, sha, other]]) assert.throws(() => validateRevision(...args));
});
test('VRM guard refuses substitutions, missing bytes and the CI fixture', () => {
  const bytes = Buffer.from('pinned original');
  const manifest = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  validateVrm(bytes, manifest);
  for (const bad of [Buffer.alloc(0), Buffer.from('CI BUILD FIXTURE - NOT AN AVATAR'), Buffer.from('pinned changed!')]) assert.throws(() => validateVrm(bad, manifest));
  assert.throws(() => validateVrm(bytes, { ...manifest, bytes: bytes.length + 1 }));
});
