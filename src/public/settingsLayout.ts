import type { AvatarScreenBounds } from '../avatar/screenBounds';
export type { AvatarScreenBounds } from '../avatar/screenBounds';

export interface SettingsLayout {
  mode: 'panel' | 'sidebar';
  width: number;
  avatarOffset: number;
}

export function calculateSettingsLayout(bounds: AvatarScreenBounds | null): SettingsLayout {
  const fallback: SettingsLayout = { mode: 'panel', width: 0, avatarOffset: 0 };
  if (!bounds || !Object.values(bounds).every(Number.isFinite) || bounds.viewportWidth < 768 || bounds.left >= bounds.right) return fallback;
  const { viewportWidth, left, right } = bounds;
  const freeWidth = viewportWidth - 16 - 24 - right;
  if (freeWidth >= 280) return { mode: 'sidebar', width: Math.min(480, freeWidth), avatarOffset: 0 };
  const shift = 280 - freeWidth;
  if (left - shift < 16) return fallback;
  return { mode: 'sidebar', width: 280, avatarOffset: shift };
}
