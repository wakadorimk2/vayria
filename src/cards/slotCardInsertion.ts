import { cardPool } from './cardPool.js';
import type { WildcardCardData } from './cardTypes.js';
export function chooseSlotCard(brain: WildcardCardData[], cardId: string, reinforced: Record<string, number>) {
  const card = cardPool.find(c => c.id === cardId);
  if (!card || !brain.length) return null;
  const existing = brain.findIndex(c => c.id === cardId);
  const index = existing >= 0 ? existing : brain.reduce((best, c, i) => (reinforced[c.id] ?? 0) < (reinforced[brain[best].id] ?? 0) ? i : best, 0);
  const next = [...brain]; next[index] = card;
  return { brain: next, inserted: card, ejected: brain[index], reinforced: existing >= 0 };
}
