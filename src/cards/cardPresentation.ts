import type { CardMotion, CardState } from './cardTypes.js';

export function getVisibleCardStateLabel(
  state: CardState,
  motion: CardMotion,
): string | null {
  if (motion === 'drop-target') return 'ここへ';
  if (motion === 'pending-insertion') return '返答待ち';
  if (motion === 'inserted') return '作用';
  if (state === 'active') return '作用中';
  if (state === 'supporting') return '補助';
  return null;
}
