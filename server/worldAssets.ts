import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { screenRectToImage, WORLD_IMAGE_SIZE, type WorldLayout } from '../src/world/worldLayout.js';
import { WORLD_ART_STYLE, validPropAsset, type WorldPropAsset, type WorldPropSpec } from '../src/world/worldProps.js';

export async function createWorldGuide(layout: WorldLayout): Promise<Buffer> {
  const box = (rect: WorldLayout['body'], fill: string) => {
    const r = screenRectToImage(rect, layout);
    return `<rect x="${r.x * 1536}" y="${r.y * 1024}" width="${r.width * 1536}" height="${r.height * 1024}" fill="${fill}"/>`;
  };
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WORLD_IMAGE_SIZE.width}" height="${WORLD_IMAGE_SIZE.height}"><rect width="100%" height="100%" fill="#555555"/>${box({ x: 0, y: 0, width: 1, height: 1 }, '#eeeeee')}${box(layout.body, '#aabbdd')}${box(layout.face, '#dd99aa')}${layout.obstacles.map(r => box(r, '#ddcc88')).join('')}</svg>`)).png().toBuffer();
}
/** Read pixels only. Never conceal clipped or opaque output by modifying it. */
export async function inspectPropPng(bytes: Buffer) {
  const source = sharp(bytes, { limitInputPixels: 4096 * 4096 });
  const meta = await source.metadata();
  if (meta.format !== 'png' || !meta.hasAlpha) throw new Error('小物画像に透過がありません。');
  const { data, info } = await source.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1, transparent = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const alpha = data[(y * info.width + x) * info.channels + info.channels - 1];
    if (alpha < 8) transparent++;
    if (alpha > 32) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  if (transparent / (info.width * info.height) < .15 || right < left) throw new Error('小物の透過範囲が不適切です。');
  if (left < 2 || top < 2 || right >= info.width - 2 || bottom >= info.height - 2) throw new Error('小物の輪郭が画像端で切れています。');
  return { bounds: { x: left / info.width, y: top / info.height, width: (right - left + 1) / info.width, height: (bottom - top + 1) / info.height }, aspect: info.width / info.height };
}
export const propCacheKey = (spec: WorldPropSpec) => createHash('sha256').update(JSON.stringify([spec.subject.trim().toLowerCase(), spec.shape.trim().toLowerCase(), WORLD_ART_STYLE, spec.orientation])).digest('hex');
export class WorldAssetCache {
  constructor(private root: string) {}
  read(spec: WorldPropSpec): WorldPropAsset | null {
    const key = propCacheKey(spec);
    try {
      const value: unknown = JSON.parse(readFileSync(join(this.root, `${key}.json`), 'utf8'));
      if (!validPropAsset(value) || value.key !== key) return null;
      readFileSync(join(this.root, `${key}.png`));
      return value;
    } catch { return null; }
  }
  async save(spec: WorldPropSpec, image: string, observation: WorldPropAsset['observation']): Promise<WorldPropAsset> {
    if (!image.startsWith('data:image/png;base64,') || image.length > 24_000_000) throw new Error('小物画像が不正です。');
    const bytes = Buffer.from(image.slice('data:image/png;base64,'.length), 'base64');
    const geometry = await inspectPropPng(bytes);
    const key = propCacheKey(spec);
    const asset: WorldPropAsset = { ...geometry, key, url: `/api/world/assets/${key}.png`, pivot: { x: geometry.bounds.x + geometry.bounds.width / 2, y: geometry.bounds.y + geometry.bounds.height * .85 }, displayWidth: .25, orientation: spec.orientation, observation };
    if (!validPropAsset(asset) || !observation.available) throw new Error('小物の検査を完了できませんでした。');
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, `${key}.png`), bytes);
    writeFileSync(join(this.root, `${key}.json`), JSON.stringify(asset));
    return asset;
  }
}
