export interface WorldPoint { x: number; y: number }
export interface WorldRect extends WorldPoint { width: number; height: number }
export interface WorldLayout {
  width: number;
  height: number;
  body: WorldRect;
  face: WorldRect;
  leftHand: WorldPoint | null;
  rightHand: WorldPoint | null;
  leftHandBehind?: boolean;
  rightHandBehind?: boolean;
  obstacles: WorldRect[];
}
export const WORLD_IMAGE_SIZE = { width: 1536, height: 1024 };
export const fallbackLayout = (): WorldLayout => ({ width: 900, height: 1200, body: { x: .15, y: .12, width: .7, height: .83 }, face: { x: .28, y: .15, width: .44, height: .42 }, leftHand: { x: .22, y: .75 }, rightHand: { x: .78, y: .75 }, obstacles: [{ x: .15, y: 0, width: .7, height: .14 }, { x: .15, y: .78, width: .7, height: .22 }] });
export function isWorldLayout(value: unknown): value is WorldLayout {
  if (!value || typeof value !== 'object') return false;
  const v = value as WorldLayout;
  const point = (p: WorldPoint) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  const rect = (r: WorldRect) => point(r) && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 0 && r.height > 0 && r.x + r.width <= 1.001 && r.y + r.height <= 1.001;
  return Number.isFinite(v.width) && v.width >= 1 && v.width <= 16384 && Number.isFinite(v.height) && v.height >= 1 && v.height <= 16384 && rect(v.body) && rect(v.face) && (v.leftHand === null || point(v.leftHand)) && (v.rightHand === null || point(v.rightHand)) && Array.isArray(v.obstacles) && v.obstacles.length <= 16 && v.obstacles.every(rect);
}
export function clampRect(r: WorldRect): WorldRect {
  const x = Math.max(0, Math.min(.999, r.x)); const y = Math.max(0, Math.min(.999, r.y));
  return { x, y, width: Math.max(.001, Math.min(1, r.x + r.width) - x), height: Math.max(.001, Math.min(1, r.y + r.height) - y) };
}
export function expandRect(r: WorldRect, margin: number): WorldRect {
  const x = Math.max(0, r.x - margin), y = Math.max(0, r.y - margin);
  return clampRect({ x, y, width: Math.min(1, r.x + r.width + margin) - x, height: Math.min(1, r.y + r.height + margin) - y });
}
/** Inverse of centered CSS cover, shared by guide and screen rendering. */
export function screenRectToImage(r: WorldRect, viewport: { width: number; height: number }, image = WORLD_IMAGE_SIZE): WorldRect {
  const scale = Math.max(viewport.width / image.width, viewport.height / image.height);
  const cropX = (image.width * scale - viewport.width) / 2;
  const cropY = (image.height * scale - viewport.height) / 2;
  return { x: (r.x * viewport.width + cropX) / scale / image.width, y: (r.y * viewport.height + cropY) / scale / image.height, width: r.width * viewport.width / scale / image.width, height: r.height * viewport.height / scale / image.height };
}
export function imageRectToScreen(r: WorldRect, viewport: { width: number; height: number }, image = WORLD_IMAGE_SIZE): WorldRect {
  const scale = Math.max(viewport.width / image.width, viewport.height / image.height);
  return { x: (r.x * image.width * scale - (image.width * scale - viewport.width) / 2) / viewport.width, y: (r.y * image.height * scale - (image.height * scale - viewport.height) / 2) / viewport.height, width: r.width * image.width * scale / viewport.width, height: r.height * image.height * scale / viewport.height };
}
export const overlaps = (a: WorldRect, b: WorldRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
export interface PropGeometry { bounds: WorldRect; pivot: WorldPoint; aspect: number; displayWidth: number }
export function placeWorldProp(layout: WorldLayout, anchor: WorldPoint, geometry: PropGeometry, scale = 1, occupied: WorldRect[] = []): { rect: WorldRect; visible: WorldRect } | null {
  const blocked = [layout.face, ...layout.obstacles, ...occupied];
  for (const shrink of [1, .8, .6, .45]) {
    const width = Math.min(.3, geometry.displayWidth * scale) * shrink;
    const height = width * layout.width / layout.height / geometry.aspect;
    for (const offset of [{ x: 0, y: 0 }, { x: -.04, y: 0 }, { x: .04, y: 0 }, { x: 0, y: .04 }]) {
      const rect = { x: anchor.x + offset.x - geometry.pivot.x * width, y: anchor.y + offset.y - geometry.pivot.y * height, width, height };
      const visible = { x: rect.x + geometry.bounds.x * width, y: rect.y + geometry.bounds.y * height, width: geometry.bounds.width * width, height: geometry.bounds.height * height };
      if (visible.x < .01 || visible.y < .01 || visible.x + visible.width > .99 || visible.y + visible.height > .99 || blocked.some(r => overlaps(visible, r))) continue;
      return { rect, visible };
    }
  }
  return null;
}
