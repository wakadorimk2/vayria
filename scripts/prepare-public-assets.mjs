import { mkdir, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
const root = resolve('.public-assets');
if (root !== join(process.cwd(), '.public-assets')) throw new Error('Unexpected output path');
await rm(root, { recursive: true, force: true });
await mkdir(join(root, 'avatar/motions'), { recursive: true });
const source = process.env.VAYRIA_PUBLIC_VRM || join(homedir(), '.vayria/avatar/model.vrm');
const vrm = await readFile(source);
if (vrm.length > 25 * 1024 * 1024) throw new Error('VRM exceeds the Static Assets file limit');
await copyFile(source, join(root, 'avatar/model.vrm'));
const manifest = JSON.parse(await readFile('public/avatar/motions/manifest.json', 'utf8'));
for (const asset of manifest.assets) {
  if (basename(asset.file) !== asset.file) throw new Error('Invalid motion filename');
  const bytes = await readFile(join('public/avatar/motions', asset.file));
  if (createHash('sha256').update(bytes).digest('hex') !== asset.contentSha256) throw new Error(`Motion hash mismatch: ${asset.assetId}`);
  await copyFile(join('public/avatar/motions', asset.file), join(root, 'avatar/motions', asset.file));
}
await writeFile(join(root, 'avatar/motions/manifest.json'), JSON.stringify(manifest));
await copyFile('public/vayria-icon.png', join(root, 'vayria-icon.png'));
console.log(`Public assets: VRM ${(vrm.length / 1048576).toFixed(1)} MiB; ${manifest.assets.length} registered motions.`);

// Camera attention remains opt-in, but its local inference assets must be deployable.
for (const file of ['face_landmarker.task', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm',
  'wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.wasm',
  'wasm/vision_wasm_module_internal.js', 'wasm/vision_wasm_module_internal.wasm']) {
  const destination = join(root, 'attention', file);
  await mkdir(join(root, 'attention', file.startsWith('wasm/') ? 'wasm' : ''), { recursive: true });
  await copyFile(join('public/attention', file), destination);
}
