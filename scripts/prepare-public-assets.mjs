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

await mkdir(join(root, 'manifestation'), { recursive: true });
for (const name of ['chicken-1.png', 'chicken-2.png', 'chicken-3.png', 'chicken-source.png']) await copyFile(join('public/manifestation', name), join(root, 'manifestation', name));

for (const name of ['egg', 'feather', 'bat']) await copyFile(join('public/world', name + '-painted.png'), join(root, 'manifestation', name + '.png'));
