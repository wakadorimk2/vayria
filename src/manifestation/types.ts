export const SLOT_CARDS = ['chicken', 'gigantic', 'sparkle', 'underwater'] as const;
export type SlotCard = typeof SLOT_CARDS[number];
export type ManifestationMode = 'reused-base-video' | 'fresh-image-then-video' | 'fresh-image' | 'static-fallback';
export interface InputEvent {
  eventId: string;
  sessionId: string;
  generation: number;
  clientId: string;
  playerId?: string;
  cardId: SlotCard;
}
export interface GeneratedObject {
  trace?: GenerationTrace;
  replayUrl?: string;
  url: string;
  kind: 'image' | 'video';
  composite: 'alpha' | 'green-key';
  keyColor?: 'green' | 'blue';
  mode: ManifestationMode;
  timings: Record<string, number>;
}
export interface GenerationTrace {
  origin: number;
  browserOrigin?: number;
  server: Record<string, number>;
  browser: Record<string, number>;
  requestIds: string[];
  missing: string[];
  inferenceSeconds?: number;
}
export interface Manifestation extends GeneratedObject {
  id: string;
  insertedAt: number;
  displayedAt: number;
  scale: number;
  effects: SlotCard[];
  visible: boolean;
}
export function isInputEvent(value: unknown): value is InputEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as InputEvent;
  const id = (x: unknown) => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x);
  return id(v.eventId) && id(v.sessionId) && id(v.clientId) && (v.playerId === undefined || id(v.playerId)) && Number.isSafeInteger(v.generation) && v.generation >= 0 && SLOT_CARDS.includes(v.cardId);
}
