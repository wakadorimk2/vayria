import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const { code } = await transform(await readFile('src/public/theme.ts', 'utf8'), { loader: 'ts', format: 'esm' });
let fixtureId = 0;
async function fixture(saved = null, dark = false, unavailable = false) {
  const media = new EventTarget(); media.matches = dark;
  const storage = new Map(saved === null ? [] : [['vayria-public-theme', saved]]);
  globalThis.localStorage = { getItem: k => { if (unavailable) throw Error('blocked'); return storage.get(k); }, setItem: (k,v) => { if (unavailable) throw Error('blocked'); storage.set(k,v); } };
  globalThis.window = { matchMedia: () => media };
  const root = { dataset: {}, style: {} }; let meta;
  globalThis.document = { documentElement: root, querySelector: () => ({ setAttribute: (_,value) => { meta = value; } }) };
  const theme = await import('data:text/javascript,' + encodeURIComponent(code) + '#' + fixtureId++);
  theme.initializePublicTheme();
  return { theme, media, storage, root, meta: () => meta, system: value => { media.matches = value; media.dispatchEvent(new Event('change')); } };
}
test('auto follows system changes and updates browser appearance', async () => {
  const f = await fixture(null, true); assert.equal(f.theme.readThemePreference(), 'auto'); assert.equal(f.root.dataset.publicTheme, 'dark'); assert.equal(f.meta(), '#292331');
  f.system(false); assert.equal(f.theme.readResolvedTheme(), 'light'); assert.equal(f.root.style.colorScheme, 'light');
});
test('manual selection overrides system and is restored on reload', async () => {
  const f = await fixture(); f.theme.setThemePreference('dark'); f.system(false); assert.equal(f.theme.readResolvedTheme(), 'dark');
  const g = await fixture(f.storage.get('vayria-public-theme')); assert.equal(g.theme.readThemePreference(), 'dark');
  g.theme.setThemePreference('auto'); assert.equal(g.theme.readResolvedTheme(), 'light'); g.system(true); assert.equal(g.theme.readResolvedTheme(), 'dark');
});
test('invalid saved preference falls back to auto', async () => { const f = await fixture('invalid', true); assert.equal(f.theme.readThemePreference(), 'auto'); assert.equal(f.theme.readResolvedTheme(), 'dark'); });
test('blocked storage permits in-page switching and subscriptions', async () => {
  const f = await fixture(null, false, true); let updates = 0; const stop = f.theme.subscribeTheme(() => updates++);
  f.theme.setThemePreference('dark'); assert.equal(f.theme.readResolvedTheme(), 'dark'); assert.equal(updates, 1); stop(); f.theme.setThemePreference('light'); assert.equal(updates, 1);
});
