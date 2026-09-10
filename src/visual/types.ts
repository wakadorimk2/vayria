export const VISUAL_EFFECTS = ['grow', 'float', 'rotate', 'pulse', 'sparkle', 'bubbles'] as const;
export type VisualEffect = typeof VISUAL_EFFECTS[number];
export interface VisualIntent {
  type: 'none' | 'prop' | 'background' | 'effect';
  action: 'add' | 'replace' | 'cancel';
  concept: string; modifiers: string[]; targetId: string;
  motion: string; motionEvidence: string; sharing: 'general' | 'private' | 'uncertain';
  regenerate: boolean;
}
export interface VisualAsset {
  id: string; url: string; kind: 'image' | 'video'; composite: 'alpha' | 'green-key' | 'opaque';
  type: 'prop' | 'background'; concept: string; createdAt: number;
  expiresAt: number; scope: string;
}
export const visualIntentSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['none', 'prop', 'background', 'effect'] },
    action: { type: 'string', enum: ['add', 'replace', 'cancel'] },
    concept: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    targetId: { type: 'string' }, motion: { type: 'string' }, motionEvidence: { type: 'string' },
    sharing: { type: 'string', enum: ['general', 'private', 'uncertain'] }, regenerate: { type: 'boolean' },
  }, required: ['type', 'action', 'concept', 'modifiers', 'targetId', 'motion', 'motionEvidence', 'sharing', 'regenerate'],
};
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && ![...v].some(c => c.charCodeAt(0) < 32);
export function readVisualIntent(v: unknown): VisualIntent | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const x = v as VisualIntent;
  if (!['none','prop','background','effect'].includes(x.type) || !['add','replace','cancel'].includes(x.action) ||
      !bounded(x.concept, 160) || !bounded(x.targetId, 80) || !/^[\w-]*$/.test(x.targetId) || !bounded(x.motion, 120) ||
      !bounded(x.motionEvidence, 200) || !['general','private','uncertain'].includes(x.sharing) || typeof x.regenerate !== 'boolean' ||
      !Array.isArray(x.modifiers) || x.modifiers.length > 6 || !x.modifiers.every(m => bounded(m, 80))) return null;
  if (x.type !== 'none' && x.action !== 'cancel' && !x.concept.trim()) return null;
  return { type: x.type, action: x.action, concept: x.concept.trim().normalize('NFKC'), modifiers: [...x.modifiers], targetId: x.targetId,
    motion: x.motion, motionEvidence: x.motionEvidence, sharing: x.sharing, regenerate: x.regenerate };
}
export function assetDescriptionKey(intent: VisualIntent, portrait: boolean) {
  const clean = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify([intent.type, clean(intent.concept), intent.modifiers.map(clean).filter(m => !VISUAL_EFFECTS.includes(m as VisualEffect)).sort(),
    'painted-v1', 'front-three-quarter', clean(intent.motion), intent.type === 'background' ? (portrait ? 'portrait' : 'landscape') : 'square']);
}
export function cacheDecision(asset: VisualAsset | null, now: number, regenerate: boolean): 'miss' | 'reuse' | 'refresh' {
  if (!asset || asset.expiresAt <= now) return 'miss';
  const age = Math.max(0, now - asset.createdAt);
  return age < 86400000 || (age < 7 * 86400000 && !regenerate) ? 'reuse' : 'refresh';
}
export function permitsVideo(intent: VisualIntent, input: string) {
  return intent.type === 'prop' && /^(chicken|鶏)$/i.test(intent.concept) && intent.motionEvidence.trim().length >= 2 &&
    input.includes(intent.motionEvidence.trim()) && ['walk', 'peck', 'flap'].includes(intent.motion);
}
