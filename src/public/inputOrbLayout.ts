import type { AvatarScreenBounds } from '../avatar/screenBounds';
export interface OrbRect { left: number; top: number; right: number; bottom: number }
export function inputOrbPosition(width: number, height: number, anchor: AvatarScreenBounds | null, obstacles: OrbRect[], toolbarTop: number) {
  const radius = 24, margin = 16, gap = 12;
  const face = anchor?.headX !== undefined && anchor.headY !== undefined && anchor.headRadius !== undefined
    ? { x: anchor.headX, y: anchor.headY, radius: Math.max(28, anchor.headRadius) } : null;
  const blocked = [...obstacles, ...(face ? [{ left: face.x - face.radius, right: face.x + face.radius,
    top: face.y - face.radius, bottom: face.y + face.radius }] : [])];
  const fits = (x: number, y: number) => x >= margin + radius && x <= width - margin - radius &&
    y >= margin + radius && y <= height - margin - radius && blocked.every(r =>
      x + radius + gap <= r.left || x - radius - gap >= r.right || y + radius + gap <= r.top || y - radius - gap >= r.bottom);
  if (face) for (const direction of [1, -1]) {
    const x = face.x + direction * (face.radius + radius + gap);
    if (fits(x, face.y)) return { x, y: face.y };
  }
  // Search free space above the toolbar, without covering cards or the face.
  for (let y = Math.min(toolbarTop - radius - gap, height - margin - radius); y >= margin + radius; y -= 60) {
    for (let x = width - margin - radius; x >= margin + radius; x -= 60) if (fits(x, y)) return { x, y };
  }
  return null;
}

export function smoothInputLevel(previous: number, level: number | null, milliseconds: number) {
  const target = level !== null && Number.isFinite(level) ? Math.min(1, Math.max(0, level - .025) / .975) : 0;
  return previous + (target - previous) * (1 - Math.exp(-milliseconds / (target > previous ? 70 : 220)));
}
