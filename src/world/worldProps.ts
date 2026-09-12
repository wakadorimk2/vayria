import type { WorldEntity, WorldObservation, WorldResult, WorldState } from './worldState.js';
import { placeWorldProp, type PropGeometry, type WorldLayout, type WorldRect } from './worldLayout.js';

export const WORLD_ART_STYLE = 'vayria-painted-v1: premium hand-painted anime fantasy prop, soft brushwork, clean silhouettes, subtle lavender bounce light, warm soft upper-left key light';
export interface WorldPropAsset extends PropGeometry {
  url: string;
  key: string;
  orientation: 'left' | 'right' | 'front';
  observation: WorldObservation;
}
export interface WorldPropSpec { subject: string; shape: string; orientation: 'left' | 'right' | 'front' }
export interface PendingWorldProp { entityId: string; placement: WorldEntity['placement']; prominent: boolean; knownAsset?: string }
export interface PropArrival {
  eventId: string;
  sessionGeneration: number;
  backgroundRevision: number;
  entity: WorldEntity;
  scene: NonNullable<WorldState['sceneElements']>[number] | null;
  category: 'props' | 'creatures';
  attempts: number;
}
export type WorldStreamEvent =
  | { type: 'planned'; eventId: string; sessionGeneration: number; baseRevision: number; backgroundRevision: number; pending: PendingWorldProp[]; attempts: number }
  | { type: 'background'; result: WorldResult; pending: PendingWorldProp[] }
  | { type: 'prop'; arrival: PropArrival }
  | { type: 'prop_error'; eventId: string; entityId: string; error: string; attempts: number }
  | { type: 'error'; error: string; attempts: number }
  | { type: 'done'; attempts: number };

const emptyObservation = { available: true, visible: [], uncertain: [], differences: [] };
const painted = (name: string, pivot: { x: number; y: number }, bounds: PropGeometry['bounds'], displayWidth: number): WorldPropAsset => ({ url: `/world/${name}-painted.png`, key: `painted-v1-${name}`, bounds, pivot, aspect: 1, displayWidth, orientation: name === 'chicken' ? 'left' : 'front', observation: { ...emptyObservation, visible: [{ chicken: '白い鶏。赤い鶏冠と黄色い足。', egg: '薄い斑点のある卵。', feather: '白い羽根。', bat: '木製のバット。' }[name] ?? name] } });
export const WORLD_PROP_ASSETS: Record<string, WorldPropAsset> = {
  chicken: painted('chicken', { x: .47, y: .86 }, { x: .15, y: .08, width: .72, height: .86 }, .25),
  egg: painted('egg', { x: .5, y: .86 }, { x: .18, y: .1, width: .65, height: .84 }, .16),
  feather: painted('feather', { x: .36, y: .86 }, { x: .27, y: .045, width: .46, height: .89 }, .21),
  bat: painted('bat', { x: .42, y: .77 }, { x: .34, y: .02, width: .34, height: .95 }, .28),
};
export function propSpec(entity: WorldEntity): WorldPropSpec {
  return entity.propSpec ?? { subject: entity.label, shape: '', orientation: 'front' };
}
/** Remove uncommitted objects from both visible facts and canonical scene references. */
export function omitWorldEntities(world: WorldState, ids: Set<string>): WorldState {
  return { ...world, props: world.props.filter(e => !ids.has(e.id)), creatures: world.creatures.filter(e => !ids.has(e.id)), sceneElements: world.sceneElements?.map(s => ({ ...s, entityIds: s.entityIds.filter(id => !ids.has(id)), entities: s.entities.filter(e => !ids.has(e.id)) })).filter(s => s.entityIds.length || s.slot === 'background'), nextInterest: '', nextInterestTargetId: null };
}
/** Chest first; the face and UI remain hard exclusions. No hand pose is assumed. */
export function chestAnchors(layout: WorldLayout) {
  const x = Math.max(.2, Math.min(.8, layout.body.x + layout.body.width / 2));
  const y = Math.max(.5, Math.min(.8, layout.face.y + layout.face.height + .12));
  return [{ x, y }, { x: x - .16, y }, { x: x + .16, y }, { x: .16, y: .73 }, { x: .84, y: .73 }];
}
/** One placement algorithm for rendering, arrival validation and conversational visibility. */
export function foregroundPlacements(world: WorldState, layout: WorldLayout) {
  const occupied: WorldRect[] = [];
  let paintedCount = 0;
  const main = (e: WorldEntity) => world.sceneElements?.some(s => s.slot === 'main' && s.entityIds.includes(e.id)) ? 1 : 0;
  const eligible = [...world.props, ...world.creatures].filter(e => e.asset !== 'none' && e.placement !== 'background').sort((a, b) => main(b) - main(a));
  const items = eligible.flatMap(entity => {
    const image = entity.image ?? WORLD_PROP_ASSETS[entity.asset] ?? (entity.asset === 'spark' || entity.asset === 'bubble' ? { url: `/world/${entity.asset}.svg`, bounds: { x: 0, y: 0, width: 1, height: 1 }, pivot: { x: .5, y: .5 }, aspect: 1, displayWidth: .07 } : null);
    return image ? [{ entity, image }] : [];
  });
  // Give each subject its first copy before filling spare spaces with a flock.
  return [0, 1, 2].flatMap(copy => items.flatMap(({ entity, image }) => {
    const particle = entity.asset === 'spark' || entity.asset === 'bubble';
    if (copy >= entity.count || (!particle && paintedCount >= 3) || (particle && copy > 0)) return [];
    // Hand poses are not implemented. Legacy hand placements use the same free scene space.
    const anchors = chestAnchors(layout);
    const placed = anchors.filter(a => a !== null).map(anchor => placeWorldProp(layout, { x: anchor.x + copy * .025, y: anchor.y }, image, entity.scale, occupied)).find(p => p !== null);
    if (!placed) return [];
    occupied.push(placed.visible); if (!particle) paintedCount++;
    const behind = false;
    return [{ entity, image, copy, ...placed, behind }];
  }));
}
export function validPropAsset(value: unknown): value is WorldPropAsset {
  if (!value || typeof value !== 'object') return false;
  const a = value as WorldPropAsset;
  const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  return typeof a.url === 'string' && (/^\/world\/(chicken|egg|feather|bat)-painted\.png$/.test(a.url) || /^\/api\/world\/assets\/[a-f0-9]{64}\.png$/.test(a.url)) && typeof a.key === 'string' && a.key.length <= 80 && !!a.bounds && n(a.bounds.x) && n(a.bounds.y) && n(a.bounds.width) && n(a.bounds.height) && a.bounds.width > 0 && a.bounds.height > 0 && a.bounds.x + a.bounds.width <= 1.001 && a.bounds.y + a.bounds.height <= 1.001 && !!a.pivot && n(a.pivot.x) && n(a.pivot.y) && Number.isFinite(a.aspect) && a.aspect > 0 && a.aspect < 10 && n(a.displayWidth) && ['left', 'right', 'front'].includes(a.orientation) && !!a.observation && Array.isArray(a.observation.visible) && a.observation.visible.length <= 12 && a.observation.visible.every(s => typeof s === 'string' && s.length <= 240);
}
