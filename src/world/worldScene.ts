import type { WorldEntity, WorldRequest, WorldState, MutationEvent } from './worldState.js';

export const SCENE_SLOTS = ['background', 'main', 'creature', 'prop', 'effect'] as const;
export const SCENE_STAGES = ['detailed', 'simple', 'distant', 'retired'] as const;
export type SceneStage = typeof SCENE_STAGES[number];
export interface SceneProposal {
  id: string;
  slot: typeof SCENE_SLOTS[number];
  entityIds: string[];
  sourceCardIds: string[];
  baseDescription: string;
  distantDescription: string;
  modifiers: { cardId: string; description: string; scale: number | null }[];
}
export interface SceneElement extends SceneProposal {
  entities: WorldEntity[];
  lastReinforcedAt: number;
  stage: SceneStage;
  retirementReason: string;
  removedModifierCardIds: string[];
}
export interface SceneContext {
  now: number;
  source: WorldRequest['source'];
  cardId: string | null;
  brainCardIds: string[];
  cardInsertedAt: Record<string, number>;
}
export const SCENE_BUDGET = { background: 1, main: 2, creature: 1, prop: 1, effect: 2 } as const;
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 12 && v.every(x => typeof x === 'string' && /^[\w-]{1,64}$/.test(x)) && new Set(v).size === v.length;
const description = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240;
export function isSceneProposal(v: unknown): v is SceneProposal {
  if (!v || typeof v !== 'object') return false;
  const p = v as SceneProposal;
  return ids([p.id]) && SCENE_SLOTS.includes(p.slot) && ids(p.entityIds) && p.entityIds.length <= (p.slot === 'background' ? 0 : ['prop', 'effect'].includes(p.slot) ? 1 : 3) && ids(p.sourceCardIds) && description(p.baseDescription) && description(p.distantDescription) && Array.isArray(p.modifiers) && p.modifiers.length <= 5 && p.modifiers.every(m => m && typeof m === 'object' && ids([m.cardId]) && description(m.description) && (m.scale === null || Number.isFinite(m.scale) && m.scale >= .2 && m.scale <= 5)) && new Set(p.modifiers.map(m => m.cardId)).size === p.modifiers.length;
}
export function isSceneElement(v: unknown, validEntity: (e: unknown) => boolean): v is SceneElement {
  if (!isSceneProposal(v)) return false;
  const e = v as SceneElement;
  return Number.isFinite(e.lastReinforcedAt) && e.lastReinforcedAt >= 0 && SCENE_STAGES.includes(e.stage) && typeof e.retirementReason === 'string' && e.retirementReason.length <= 240 && ids(e.removedModifierCardIds) && e.removedModifierCardIds.every(id => e.modifiers.some(m => m.cardId === id)) && Array.isArray(e.entities) && e.entities.length === e.entityIds.length && e.entities.every(validEntity) && e.entities.every((entity, i) => entity.id === e.entityIds[i]);
}
function cardFreshness(id: string, context: SceneContext): number {
  const time = context.cardInsertedAt[id];
  return context.brainCardIds.includes(id) && Number.isFinite(time) ? Math.pow(.5, Math.max(0, context.now - time) / 180000) : 0;
}
export function sceneFreshness(element: SceneElement, all: SceneElement[], context: SceneContext): number {
  const sources = [...new Set([...element.sourceCardIds, ...element.modifiers.map(m => m.cardId)])];
  const support = sources.length ? sources.reduce((n, id) => n + cardFreshness(id, context), 0) / sources.length : 0;
  // One bounded pass: relationships cannot recursively sustain each other.
  const linked = all.some(other => other.id !== element.id && other.stage !== 'retired' && other.sourceCardIds.some(id => sources.includes(id)) && Math.pow(.5, Math.max(0, context.now - other.lastReinforcedAt) / 180000) > .65);
  return Math.pow(.5, Math.max(0, context.now - element.lastReinforcedAt) / 180000) * (.7 + .2 * support + (linked ? .1 : 0));
}
export function sceneDiagnostics(world: WorldState, context: SceneContext) {
  return (world.sceneElements ?? []).map(e => ({ id: e.id, description: e.baseDescription, sourceCardIds: [...e.sourceCardIds, ...e.modifiers.map(m => m.cardId)], stage: e.stage, freshness: sceneFreshness(e, world.sceneElements ?? [], context), retirementReason: e.retirementReason }));
}
function provisional(world: WorldState, now: number): SceneElement[] {
  const make = (p: SceneProposal, entities: WorldEntity[] = []): SceneElement => ({ ...p, entities, lastReinforcedAt: now, stage: 'detailed', retirementReason: '', removedModifierCardIds: [] });
  return [make({ id: 'legacy_background', slot: 'background', entityIds: [], sourceCardIds: [], modifiers: [], baseDescription: world.location || 'いつもの配信部屋', distantDescription: '穏やかな背景' }),
    ...[...world.props, ...world.creatures].map(e => make({ id: `legacy_${e.id}`.slice(0, 64), slot: world.creatures.some(c => c.id === e.id) ? 'creature' : 'prop', entityIds: [e.id], sourceCardIds: [], modifiers: [], baseDescription: e.label || e.id, distantDescription: `${e.label || e.id}の遠景の影`.slice(0, 240) }, [e])),
    ...world.environment.map((e, i) => make({ id: `legacy_effect_${i}`, slot: 'effect', entityIds: [], sourceCardIds: [], modifiers: [], baseDescription: e || '環境', distantDescription: `遠くに残る${e}`.slice(0, 240) }))];
}
export function normalizeSceneWorld(world: WorldState, now: number): WorldState {
  return world.sceneElements ? world : { ...world, sceneElements: provisional(world, now) };
}
export function applyScene(world: WorldState, next: WorldState, change: MutationEvent, context: SceneContext): WorldState {
  const previous = structuredClone(world.sceneElements ?? provisional(world, context.now));
  const proposals = change.sceneChanges ?? [];
  const entities = new Map([...previous.flatMap(e => e.entities), ...next.props, ...next.creatures].map(e => [e.id, e]));
  const currentIds = new Set([...next.props, ...next.creatures].map(e => e.id));
  const knownCards = new Set([...context.brainCardIds, ...Object.keys(context.cardInsertedAt), ...previous.flatMap(e => [...e.sourceCardIds, ...e.modifiers.map(m => m.cardId)])]);
  const used = new Set<string>();
  for (const p of proposals) {
    if (!isSceneProposal(p)) throw new Error('情景の形式が不正です。');
    if (p.entityIds.some(id => !entities.has(id))) throw new Error(`情景の参照が不正です。未登録の対象: ${p.entityIds.filter(id => !entities.has(id)).join(', ')}`);
    if (p.entityIds.some(id => used.has(id))) throw new Error(`情景の参照が不正です。対象の重複: ${p.entityIds.filter(id => used.has(id)).join(', ')}`);
    const unknownCards = [...p.sourceCardIds, ...p.modifiers.map(m => m.cardId)].filter(id => !knownCards.has(id));
    if (unknownCards.length) throw new Error(`情景の参照が不正です。由来不明のカード: ${unknownCards.join(', ')}`);
    p.entityIds.forEach(id => used.add(id));
  }
  if (change.sceneChanges !== undefined && [...change.props, ...change.creatures].some(e => !used.has(e.id))) throw new Error('変更した対象の情景がありません。');
  const byId = new Map(previous.map(e => [e.id, structuredClone(e)]));
  const touched = new Set([...change.props, ...change.creatures].map(e => e.id));
  for (const p of proposals) {
    const old = byId.get(p.id);
    // A proposal must reuse the owning scene rather than duplicate an existing creature.
    if (previous.some(e => e.id !== p.id && e.entityIds.some(id => p.entityIds.includes(id)))) throw new Error('既存の対象には同じ情景IDを使ってください。');
    const actualChange = !old || p.entityIds.some(id => touched.has(id) && JSON.stringify(entities.get(id)) !== JSON.stringify([...world.props, ...world.creatures].find(e => e.id === id)) && JSON.stringify(entities.get(id)) !== JSON.stringify(old.entities.find(e => e.id === id))) || (['slot', 'baseDescription', 'distantDescription', 'modifiers', 'entityIds'] as const).some(key => JSON.stringify(old[key]) !== JSON.stringify(p[key]));
    const insertedSupports = context.source === 'card' && context.cardId !== null && [...p.sourceCardIds, ...p.modifiers.map(m => m.cardId)].includes(context.cardId);
    const reinforced = insertedSupports || context.source === 'autonomous' && actualChange;
    if (old?.stage === 'retired' && !insertedSupports) throw new Error('退場済みの対象はカードによる再登場が必要です。');
    const strengthenedAt = insertedSupports ? Math.min(context.now, context.cardInsertedAt[context.cardId!] ?? context.now) : context.now;
    byId.set(p.id, { ...p, entities: p.entityIds.map(id => entities.get(id)!), lastReinforcedAt: reinforced || !old ? strengthenedAt : old.lastReinforcedAt, stage: reinforced ? 'detailed' : old?.stage ?? 'detailed', retirementReason: '', removedModifierCardIds: reinforced ? [] : (old?.removedModifierCardIds ?? []).filter(id => p.modifiers.some(m => m.cardId === id)) });
  }
  // Legacy clients/providers still receive bounded scenes without invented provenance.
  const claimed = new Set([...byId.values()].flatMap(e => e.entityIds));
  const additions = provisional({ ...next, props: next.props.filter(e => !claimed.has(e.id)), creatures: next.creatures.filter(e => !claimed.has(e.id)), environment: change.environment.filter(e => ![...byId.values()].some(s => s.baseDescription === e)) }, context.now);
  for (const e of additions) {
    if (e.slot === 'background' && (proposals.some(p => p.slot === 'background') || !change.location)) continue;
    let id = e.id;
    while (byId.has(id) && e.slot !== 'background') id = `${id.slice(0, 55)}_${byId.size}`;
    byId.set(id, { ...e, id });
  }
  const all = [...byId.values()];
  for (const e of all) {
    if (e.entityIds.some(id => change.removeEntityIds.includes(id))) { e.stage = 'retired'; e.retirementReason = '出来事による退場'; continue; }
    if (e.stage === 'retired') continue;
    const score = sceneFreshness(e, all, context);
    const desired = score >= .65 ? 0 : score >= .35 ? 1 : score >= .15 ? 2 : 3;
    const index = SCENE_STAGES.indexOf(e.stage);
    e.stage = SCENE_STAGES[Math.max(index, Math.min(index + 1, desired))];
    if (e.stage !== 'detailed') {
      const weakest = [...e.modifiers].filter(m => !e.removedModifierCardIds.includes(m.cardId)).sort((a, b) => cardFreshness(a.cardId, context) - cardFreshness(b.cardId, context) || a.cardId.localeCompare(b.cardId))[0];
      if (weakest) e.removedModifierCardIds.push(weakest.cardId);
    }
    if (e.stage === 'retired') e.retirementReason = '鮮度が低下したため画面外へ';
  }
  for (const slot of SCENE_SLOTS) {
    const candidates = all.filter(e => e.slot === slot && e.stage !== 'retired').sort((a, b) => sceneFreshness(b, all, context) - sceneFreshness(a, all, context) || b.lastReinforcedAt - a.lastReinforcedAt || a.id.localeCompare(b.id));
    for (const e of candidates.slice(SCENE_BUDGET[slot])) { e.stage = 'retired'; e.retirementReason = '表示枠を新しい情景へ譲った'; }
  }
  const active = all.filter(e => e.stage !== 'retired');
  const display = (e: SceneElement) => e.stage === 'distant' ? e.distantDescription : [e.baseDescription, ...e.modifiers.filter(m => !e.removedModifierCardIds.includes(m.cardId)).map(m => m.description)].join('、').slice(0, 240);
  const visibleEntities = active.flatMap(e => e.entities.map(entity => {
    const scale = e.modifiers.filter(m => !e.removedModifierCardIds.includes(m.cardId)).find(m => m.scale !== null)?.scale;
    return { ...entity, label: display(e), ...(e.stage === 'distant' ? { scale: .3, count: 1, asset: 'none' as const, placement: 'background' as const } : { scale: scale ?? (e.removedModifierCardIds.some(id => e.modifiers.some(m => m.cardId === id && m.scale !== null)) ? 1 : entity.scale) }) };
  }));
  const creatureIds = new Set([...world.creatures, ...next.creatures].map(e => e.id));
  const retiredNow = all.filter(e => e.stage === 'retired' && previous.find(p => p.id === e.id)?.stage !== 'retired');
  const target = change.nextInterestTargetId ?? null;
  const targetVisible = target !== null && (active.some(e => e.id === target) || visibleEntities.some(e => e.id === target));
  // Missing target IDs on old responses cannot safely retain a free-text interest after retirement.
  const keepLegacyInterest = target === null && retiredNow.length === 0 && currentIds.size > 0 && change.sceneChanges === undefined;
  return { ...next, location: active.find(e => e.slot === 'background') ? display(active.find(e => e.slot === 'background')!) : '余白のある穏やかな配信空間', environment: active.filter(e => e.slot === 'effect').map(display), props: visibleEntities.filter(e => !creatureIds.has(e.id)), creatures: visibleEntities.filter(e => creatureIds.has(e.id)), sceneElements: [...active, ...all.filter(e => e.stage === 'retired').sort((a, b) => b.lastReinforcedAt - a.lastReinforcedAt).slice(0, 12)], nextInterest: targetVisible || keepLegacyInterest ? next.nextInterest : '', nextInterestTargetId: targetVisible ? target : null, recentEvents: [...next.recentEvents, ...retiredNow.map(e => `${e.baseDescription}は画面外になった。${e.retirementReason}`.slice(0, 240))].slice(-6) };
}

/** Only presently visible data crosses the image/vision boundary. */
export function visibleWorld(world: WorldState) {
  return { location: world.location, environment: world.environment, props: world.props, creatures: world.creatures, mood: world.mood, absurdityLevel: world.absurdityLevel };
}
