import { isPlacementObstacleVisible } from './placementObstacles';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { VrmStageHandle } from '../avatar/VrmStage';
import type { WorldRuntime } from './worldRuntime';
import { clampRect, expandRect, fallbackLayout, type WorldLayout, type WorldRect } from './worldLayout';

export type RegionName = 'body' | 'face' | 'leftHand' | 'rightHand';
type Adjustment = { margin: number; offsets: Partial<Record<RegionName, { x: number; y: number }>> };
const defaults = (): Adjustment => ({ margin: .025, offsets: {} });
function readAdjustment(key: string): Adjustment {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Adjustment;
    if (v && v.margin >= 0 && v.margin <= .15 && v.offsets && Object.entries(v.offsets).every(([name, p]) => ['body', 'face', 'leftHand', 'rightHand'].includes(name) && Number.isFinite(p.x) && Math.abs(p.x) <= 1 && Number.isFinite(p.y) && Math.abs(p.y) <= 1)) return v;
  } catch { /* Invalid local configuration falls back to projected positions. */ }
  return defaults();
}
export function useWorldLayout(root: RefObject<HTMLDivElement | null>, stage: RefObject<VrmStageHandle | null>, runtime: Pick<WorldRuntime, 'setLayout'>) {
  const [layout, setLayout] = useState<WorldLayout>(fallbackLayout);
  const [margin, showMargin] = useState(.025);
  const settings = useRef({ portrait: readAdjustment('world-layout-portrait-v1'), landscape: readAdjustment('world-layout-landscape-v1') });
  const orientation = layout.width > layout.height ? 'landscape' : 'portrait';
  const adjust = (fn: (previous: Adjustment) => Adjustment) => {
    const value = fn(settings.current[orientation]); settings.current[orientation] = value;
    try { localStorage.setItem(`world-layout-${orientation}-v1`, JSON.stringify(value)); } catch { /* Session configuration remains usable. */ }
  };
  useEffect(() => {
    const sample = () => {
      if (!root.current) return;
      const viewport = root.current.getBoundingClientRect();
      if (!viewport.width || !viewport.height) return;
      const config = settings.current[viewport.width > viewport.height ? 'landscape' : 'portrait'];
      showMargin(config.margin);
      const normalize = (r: WorldRect) => clampRect({ x: (r.x - viewport.left) / viewport.width, y: (r.y - viewport.top) / viewport.height, width: r.width / viewport.width, height: r.height / viewport.height });
      const regions = stage.current?.readWorldRegions?.();
      const initial = fallbackLayout();
      const moveRect = (name: 'body' | 'face', rect: WorldRect) => { const d = config.offsets[name]; return expandRect(clampRect({ ...rect, x: rect.x + (d?.x ?? 0), y: rect.y + (d?.y ?? 0) }), name === 'face' ? config.margin : .015); };
      const hand = (name: 'leftHand' | 'rightHand') => {
        const p = stage.current?.readWorldHandAnchor?.(name);
        if (!p) return null;
        const d = config.offsets[name];
        return { x: Math.max(0, Math.min(1, (p.x - viewport.left) / viewport.width + (d?.x ?? 0))), y: Math.max(0, Math.min(1, (p.y - viewport.top) / viewport.height + (d?.y ?? 0))) };
      };
      const obstacles = [...document.querySelectorAll<HTMLElement>('.shared-world-cards, .card-zone, .manifestation-slot, .manifestation-picker, .manifestation-actions, .message-form, .conversation-copy, .subtitle, .subtitle-overlay, .speech-caption, .performer-caption, .public-controls__actions, .public-controls__panel, .public-entry, .public-generation-notice, .conversation-error, .playback-permission, .public-voice-notice')].flatMap(node => {
        if (!isPlacementObstacleVisible(node) || (!node.textContent?.trim()&&!node.querySelector('input,button,iframe,svg'))) return [];
        // The hold message must not itself keep its object held.
        if (node.matches('.public-generation-notice') && node.textContent === 'UIを閉じると小物が戻ります') return [];
        const r = node.getBoundingClientRect();
        if (!r.width || !r.height || r.right <= viewport.left || r.left >= viewport.right || r.bottom <= viewport.top || r.top >= viewport.bottom) return [];
        return [expandRect(normalize({ x: r.left, y: r.top, width: r.width, height: r.height }), .012)];
      }).slice(0, 16);
      const visualViewport=window.visualViewport;
      if(visualViewport){const bottom=(visualViewport.offsetTop+visualViewport.height-viewport.top)/viewport.height;if(bottom<.99)obstacles.push({x:0,y:Math.max(0,bottom),width:1,height:1-Math.max(0,bottom)});}
      const next: WorldLayout = { width: viewport.width, height: viewport.height, body: moveRect('body', regions ? normalize(regions.body) : initial.body), face: moveRect('face', regions ? normalize(regions.face) : initial.face), leftHand: hand('leftHand'), rightHand: hand('rightHand'), leftHandBehind: stage.current?.readWorldHandAnchor?.('leftHand')?.behind, rightHandBehind: stage.current?.readWorldHandAnchor?.('rightHand')?.behind, obstacles };
      runtime.setLayout(next); setLayout(next);
    };
    sample(); const timer = window.setInterval(sample, 100);
    return () => clearInterval(timer);
  }, [root, stage, runtime]);
  return { layout, margin, setMargin: (margin: number) => adjust(v => ({ ...v, margin })), reset: () => adjust(defaults), move: (name: RegionName, dx: number, dy: number) => adjust(v => ({ ...v, offsets: { ...v.offsets, [name]: { x: Math.max(-1, Math.min(1, (v.offsets[name]?.x ?? 0) + dx)), y: Math.max(-1, Math.min(1, (v.offsets[name]?.y ?? 0) + dy)) } } })) };
}
