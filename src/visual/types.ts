export const VISUAL_EFFECTS = ['grow', 'float', 'rotate', 'pulse', 'sparkle', 'bubbles', 'sway', 'bob', 'slide'] as const;
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
  expiresAt: number; scope: string; width?: number; height?: number; keyColor?: 'green' | 'blue'; source?: VisualAsset;
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
export function legacyAssetDescriptionKey(intent: VisualIntent, portrait: boolean) {
  const clean = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify([intent.type, clean(intent.concept), intent.modifiers.map(clean).filter(m => !VISUAL_EFFECTS.includes(m as VisualEffect)).sort(),
    'painted-v1', 'front-three-quarter', clean(intent.motion), intent.type === 'background' ? (portrait ? 'portrait' : 'landscape') : 'square']);
}
const cleanVisual = (s:string)=>s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
const subjects:Record<string,string>={'鶏':'chicken','にわとり':'chicken','ニワトリ':'chicken','卵':'egg','羽根':'feather','バット':'bat','カニ':'crab','エビ':'shrimp','プリン':'pudding','みかん':'mandarin orange','ボール':'ball','肉':'meat'};
const motions:Record<string,string>={walking:'walk','歩く':'walk','歩いて':'walk',running:'run','走る':'run',dancing:'dance','踊る':'dance','ダンスする':'dance',dribbling:'dribble','ドリブルする':'dribble',floating:'float','浮遊':'float','浮かぶ':'float','漂う':'float','ふわふわ':'float',rotating:'rotate','回転':'rotate',swaying:'sway','揺れる':'sway','揺らす':'sway',bobbing:'bob','小さく上下する':'bob',sliding:'slide','スライド':'slide'};
export function normalizeVisualIntent(intent:VisualIntent):VisualIntent {
 const concept=cleanVisual(intent.concept),motion=motions[cleanVisual(intent.motion)]??cleanVisual(intent.motion);
 const light=VISUAL_EFFECTS.includes(motion as VisualEffect);
 return {...intent,concept:intent.type==='effect'?(motions[concept]??concept):(subjects[concept]??concept),motion:light?'':motion,
 modifiers:[...new Set([...intent.modifiers,...(light?[motion]:[])])],motionEvidence:light?'':intent.motionEvidence};
}
export function assetDescriptionKey(intent:VisualIntent,portrait:boolean){return legacyAssetDescriptionKey(normalizeVisualIntent(intent),portrait);}
export function cacheDecision(asset: VisualAsset | null, now: number, regenerate: boolean): 'miss' | 'reuse' | 'refresh' {
  if (!asset || asset.expiresAt <= now) return 'miss';
  return regenerate ? 'refresh' : 'reuse';
}
export function permitsVideo(intent: VisualIntent, input: string) {
  if (intent.type !== 'prop' || intent.action === 'cancel' || !intent.motion.trim() ||
      intent.motionEvidence.trim().length < 2 || !input.includes(intent.motionEvidence.trim())) return false;
  if (/「|」|『|』|["“”]|しない|さない|せない|ないで|なくて|不要|昨日|以前|だった|したら|ならば|if |don't|do not|yesterday/i.test(input)) return false;
  return normalizeVisualIntent(intent).motion.length>0;
}

export function legacyVisualIntents(intent:VisualIntent):VisualIntent[]{
 const normal=normalizeVisualIntent(intent);
 const concepts=[normal.concept,...Object.keys(subjects).filter(k=>subjects[k]===normal.concept)];
 const actions=[normal.motion,...Object.keys(motions).filter(k=>motions[k]===normal.motion)];
 return [intent,...concepts.flatMap(concept=>actions.map(motion=>({...intent,concept,motion})))];
}
