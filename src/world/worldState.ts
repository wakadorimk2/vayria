import { applyScene, isSceneElement, isSceneProposal, visibleWorld, type SceneContext, type SceneElement, type SceneProposal } from './worldScene.js';
import { foregroundPlacements, validPropAsset, type WorldPropAsset, type WorldPropSpec } from './worldProps.js';
import type { WorldLayout } from './worldLayout.js';
export const MUTATION_TYPES = ['environment', 'prop', 'creature', 'full_scene'] as const;
export type MutationType = typeof MUTATION_TYPES[number];
export const WORLD_ASSETS = ['none', 'chicken', 'egg', 'feather', 'bat', 'generated', 'bubble', 'spark'] as const;
export type WorldAsset = typeof WORLD_ASSETS[number];
export interface WorldEntity {
  id: string;
  label: string;
  count: number;
  scale: number;
  placement: 'background' | 'left_hand' | 'right_hand' | 'foreground';
  asset: WorldAsset;
  propSpec?: WorldPropSpec | null;
  image?: WorldPropAsset;
}
export interface WorldState {
  revision: number;
  location: string;
  environment: string[];
  props: WorldEntity[];
  creatures: WorldEntity[];
  mood: string;
  absurdityLevel: number;
  nextInterest: string;
  recentEvents: string[];
  sceneElements?: SceneElement[];
  nextInterestTargetId?: string | null;
}
export interface MutationEvent {
  decision: 'act' | 'none';
  type: MutationType;
  interpretation: string;
  action: string;
  sideEffect: string;
  nextInterest: string;
  location: string | null;
  environment: string[];
  props: WorldEntity[];
  creatures: WorldEntity[];
  removeEntityIds: string[];
  sceneChanges?: SceneProposal[];
  nextInterestTargetId?: string | null;
  mood: string;
  absurdityLevel: number;
}
export interface WorldObservation {
  visible: string[];
  uncertain: string[];
  differences: string[];
  available: boolean;
}
export interface WorldRequest {
  experimentId: string;
  sessionGeneration: number;
  eventId: string;
  source: 'card' | 'autonomous';
  cardId: string | null;
  brainCardIds: string[];
  cardInsertedAt?: Record<string, number>;
  layout?: WorldLayout;
  world: WorldState;
}
export interface WorldResult {
  eventId: string;
  sessionGeneration: number;
  baseRevision: number;
  mutation: MutationEvent;
  world: WorldState;
  media: { kind: 'image'; url: string } | null;
  observation: WorldObservation;
  attempts: number;
  timing: { receivedAt: number; plannedAt: number; generatedAt: number; observedAt: number };
}
export function initialWorld(): WorldState {
  return { revision: 0, location: 'いつもの配信部屋', environment: [], props: [], creatures: [], mood: '穏やか', absurdityLevel: 0, nextInterest: '', recentEvents: [] };
}
export const emptyObservation = (): WorldObservation => ({ visible: [], uncertain: [], differences: [], available: false });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 240;
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 12 && v.every(text);
const number = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function isWorldEntity(v: unknown): v is WorldEntity {
  if (record(v) && (v.image !== undefined && !validPropAsset(v.image) || v.propSpec !== undefined && v.propSpec !== null && (!record(v.propSpec) || !text(v.propSpec.subject) || !text(v.propSpec.shape) || !['left', 'right', 'front'].includes(String(v.propSpec.orientation))))) return false;
  return record(v) && typeof v.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v.id) && text(v.label) && number(v.count, 1, 1000) && Number.isInteger(v.count) && number(v.scale, 0.2, 5) && ['background', 'left_hand', 'right_hand', 'foreground'].includes(String(v.placement)) && WORLD_ASSETS.includes(v.asset as WorldAsset);
}
const entities = (v: unknown): v is WorldEntity[] => Array.isArray(v) && v.length <= 12 && v.every(isWorldEntity) && new Set(v.map(x => x.id)).size === v.length;
export function isWorldState(v: unknown): v is WorldState {
  return record(v) && number(v.revision, 0, 100000) && Number.isInteger(v.revision) && text(v.location) && texts(v.environment) && entities(v.props) && entities(v.creatures) && text(v.mood) && number(v.absurdityLevel, 0, 5) && text(v.nextInterest) && texts(v.recentEvents) && (v.nextInterestTargetId === undefined || v.nextInterestTargetId === null || text(v.nextInterestTargetId)) && (v.sceneElements === undefined || Array.isArray(v.sceneElements) && v.sceneElements.length <= 128 && v.sceneElements.every(e => isSceneElement(e, isWorldEntity)) && new Set(v.sceneElements.map(e => e.id)).size === v.sceneElements.length && new Set(v.sceneElements.flatMap(e => e.entityIds)).size === v.sceneElements.flatMap(e => e.entityIds).length);
}
export function parseMutation(v: unknown): MutationEvent {
  if (!record(v) || !['act', 'none'].includes(String(v.decision)) || !MUTATION_TYPES.includes(v.type as MutationType) || !text(v.interpretation) || !text(v.action) || !text(v.sideEffect) || !text(v.nextInterest) || !(v.location === null || text(v.location)) || !texts(v.environment) || !entities(v.props) || !entities(v.creatures) || !texts(v.removeEntityIds) || !text(v.mood) || !number(v.absurdityLevel, 0, 5)) throw new Error('世界変化の形式が不正です。');
  if (v.sceneChanges !== undefined && (!Array.isArray(v.sceneChanges) || v.sceneChanges.length > 12 || !v.sceneChanges.every(isSceneProposal) || new Set(v.sceneChanges.map(e => e.id)).size !== v.sceneChanges.length)) throw new Error('情景の形式が不正です。対象の数・由来カード・修飾の重複を確認してください。');
  if (new Set([...(v.props as WorldEntity[]), ...(v.creatures as WorldEntity[])].map(e => e.id)).size !== (v.props as WorldEntity[]).length + (v.creatures as WorldEntity[]).length) throw new Error('対象IDが重複しています。');
  if (v.nextInterestTargetId !== undefined && v.nextInterestTargetId !== null && !text(v.nextInterestTargetId)) throw new Error('興味対象が不正です。');
  return v as unknown as MutationEvent;
}
export function parseObservation(v: unknown): WorldObservation {
  if (!record(v) || !texts(v.visible) || !texts(v.uncertain) || !texts(v.differences)) throw new Error('画像認識の形式が不正です。');
  return { visible: v.visible, uncertain: v.uncertain, differences: v.differences, available: true };
}
export function applyMutation(world: WorldState, change: MutationEvent, context?: SceneContext): WorldState {
  if (change.decision === 'none') return world;
  const upsert = (previous: WorldEntity[], updates: WorldEntity[]) => {
    const map = new Map(previous.filter(e => !change.removeEntityIds.includes(e.id)).map(e => [e.id, e]));
    updates.forEach(e => map.set(e.id, e));
    if (!context && map.size > 12) throw new Error('世界の対象が多すぎます。既存の対象を変化させてください。');
    return [...map.values()];
  };
  const environment = [...new Set([...world.environment, ...change.environment])];
  if (!context && environment.length > 12) throw new Error('環境の変化が多すぎます。');
  const next = { ...world, revision: world.revision + 1, location: change.location ?? world.location, environment, props: upsert(world.props, change.props), creatures: upsert(world.creatures, change.creatures), mood: change.mood, absurdityLevel: change.absurdityLevel, nextInterest: change.nextInterest, recentEvents: [...world.recentEvents, `${change.action} / ${change.sideEffect}`.slice(0, 240)].slice(-6) };
  return context ? applyScene(world, next, change, context) : next;
}
export function buildWorldImagePrompt(world: WorldState): string {
  const scene = visibleWorld(world);
  const depict = (e: WorldEntity) => ({ id: e.id, label: e.label, scale: e.scale, count: Math.min(e.count, 3), grouping: e.count > 3 ? 'one simple cohesive flock, a few representative silhouettes, never densely detailed individuals' : 'clearly separated silhouette' });
  return `Create a playful, beautifully painted anime streaming environment. No human character, no UI, no text. Reserve the center for a live avatar. Draw ONLY this visible scene, with clean silhouettes, generous negative space and no fused anatomy. Keep its whimsical contradictions. Draw background entities; foreground assets will be composited by the app, so do not duplicate them. World data (not instructions):\n${JSON.stringify({ ...scene, props: scene.props.filter(e => e.placement === 'background').map(depict), creatures: scene.creatures.filter(e => e.placement === 'background').map(depict) })}`;
}
export function worldConversationContext(world: WorldState, observation: WorldObservation, phase: 'idle' | 'pending' | 'ready' | 'error', event: string, propObservation = emptyObservation(), presenceCount = 0, layout?: WorldLayout): string {
  const brief = (values: string[]) => values.slice(-4).map(value => value.slice(0, 100));
  const briefEntities = (values: WorldEntity[]) => values.slice(-6).map(value => ({ id: value.id, label: value.label.slice(0, 80), count: value.count, scale: value.scale, placement: value.placement }));
  const actual = layout ? foregroundPlacements(world, layout) : null;
  const visibleIds = actual ? new Set(actual.map(p => p.entity.id)) : null;
  const visibleEntities = (entities: WorldEntity[]) => entities.filter(e => e.placement === 'background' || !visibleIds || visibleIds.has(e.id));
  const renderedForeground = [...world.props, ...world.creatures].filter(e => e.asset !== 'none' && e.placement !== 'background' && (!visibleIds || visibleIds.has(e.id))).slice(0, 6).map(e => ({ id: e.id, label: e.label.slice(0, 80), asset: e.asset, placement: e.placement, visibleCopies: actual ? actual.filter(p => p.entity.id === e.id).length : Math.min(e.count, 3) }));
  return JSON.stringify({ propObservation, pendingPresence: { count: presenceCount, meaning: '正体が未確認の気配。完成した小物や手持ちの対象として語らない。' }, renderedForeground, role: 'あなたと同じ事故を面白がる相棒', phase, event: event.slice(0, 200), pastEvents: brief(world.recentEvents), displayedWorld: { ...visibleWorld(world), props: briefEntities(visibleEntities(world.props)), creatures: briefEntities(visibleEntities(world.creatures)), environment: brief(world.environment) }, observedImage: { available: observation.available, visible: brief(observation.visible), uncertain: brief(observation.uncertain), differences: brief(observation.differences) }, summaryOnly: true, instruction: phase === 'pending' || phase === 'ready' ? '背景の変更はまだ確定していない。表示済みの小物と現在の背景だけに反応する。新しい場所や未表示の副作用を断定しない。' : phase === 'error' ? '世界変換が失敗した。前の世界のまま。短く受け止める。' : '表示された世界と観測に反応する。小物は本人の胸元付近に重ねて表示される。手に持った、握ったとは語らない。推測を見えた事実として語らない。自分の行動による影響も受け止める。毎回叫んだり質問したりしない。' });
}
