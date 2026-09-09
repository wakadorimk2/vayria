import { useEffect, useRef, useState, type RefObject } from 'react';
import type { VrmStageHandle } from '../avatar/VrmStage';
import type { WorldRuntime, WorldSnapshot } from './worldRuntime';
import './world.css';
import { chestAnchors, foregroundPlacements } from './worldProps';
import { placeWorldProp, type WorldRect } from './worldLayout';
import { useWorldLayout, type RegionName } from './useWorldLayout';
export function WorldStage({ snapshot, stage, runtime }: { snapshot: WorldSnapshot; stage: RefObject<VrmStageHandle | null>; runtime: WorldRuntime }) {
  const foreground = useRef<HTMLDivElement>(null);
  const { layout, margin, setMargin, reset, move } = useWorldLayout(foreground, stage, runtime);
  const [now, setNow] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 100); return () => clearInterval(timer); }, []);
  const drag = useRef<{ name: RegionName; x: number; y: number } | null>(null);
  const placements = foregroundPlacements(snapshot.world, layout);
  const occupied: WorldRect[] = placements.map(p => p.visible);
  const objects = placements.map(({ entity, image, rect: r, copy, behind }) => <img key={entity.id + ':' + copy} className={'world-object world-object--' + entity.asset} alt="" src={image.url} style={{ left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.width * 100 + '%', height: r.height * 100 + '%', zIndex: behind ? 1 : 3 }} />);
  const elapsed = snapshot.displayedAt === null ? -1 : now - snapshot.displayedAt;
  useEffect(() => {
    if (snapshot.phase === 'idle' && snapshot.pendingProps.some(p => elapsed >= (p.prominent ? 0 : 300))) runtime.markPresenceShown();
  }, [elapsed, snapshot.phase, snapshot.pendingProps, runtime]);
  return <>
    {snapshot.phase === 'error' && <div className="world-conversion-error" aria-hidden="true" />}
    {snapshot.imageUrl && <div className="world-background" key={snapshot.imageUrl.slice(-80)} aria-hidden="true" style={{ backgroundImage: 'url(' + snapshot.imageUrl + ')' }} />}
    <div className="world-foreground" ref={foreground} aria-hidden="true">
      {objects}
      {snapshot.phase === 'idle' && snapshot.pendingProps.map(p => {
        if (elapsed < (p.prominent ? 0 : 300)) return null;
        const placed = chestAnchors(layout).map(anchor => placeWorldProp(layout, anchor, { bounds: { x: 0, y: 0, width: 1, height: 1 }, pivot: { x: .5, y: .8 }, aspect: 1, displayWidth: .08 }, 1, occupied)).find(p => p !== null);
        if (!placed) return null;
        return <i key={p.entityId} className={'world-presence' + (elapsed >= 1200 ? ' world-presence--waiting' : '')} style={{ left: (placed.rect.x + placed.rect.width / 2) * 100 + '%', top: (placed.rect.y + placed.rect.height / 2) * 100 + '%' }} />;
      })}
      {snapshot.world.environment.some(e => /水|海|underwater|sea/i.test(e)) && <div className="world-bubbles"><i /><i /><i /><i /></div>}
    </div>
    {snapshot.editLayout && <div className="world-layout-editor">
      {(['body', 'face'] as const).map(name => {
        const r = layout[name]; if (!r) return null;
        return <div key={name} className={'world-region world-region--' + name} style={{ left: r.x * 100 + '%', top: r.y * 100 + '%', width: ('width' in r ? r.width * 100 : 3) + '%', height: ('height' in r ? r.height * 100 : 3) + '%' }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { name, x: e.clientX, y: e.clientY }; }} onPointerMove={e => { const d = drag.current; if (!d || d.name !== name) return; move(name, (e.clientX - d.x) / layout.width, (e.clientY - d.y) / layout.height); drag.current = { name, x: e.clientX, y: e.clientY }; }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>{name}</div>;
      })}
      {layout.obstacles.map((r, i) => <div key={i} className="world-region world-region--blocked" style={{ left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.width * 100 + '%', height: r.height * 100 + '%' }}>操作・字幕</div>)}
      <div className="world-layout-settings"><label>顔の余白 <input aria-label="顔の余白" type="range" min="0" max="0.15" step="0.005" value={margin} onChange={e => setMargin(Number(e.target.value))} /></label><button type="button" onClick={reset}>領域を初期値へ</button><button type="button" onClick={runtime.toggleLayout}>調整を閉じる</button><p>{layout.width > layout.height ? '横長' : '縦長'}用 · 枠をドラッグして調整</p></div>
    </div>}
  </>;
}
export function WorldControls({ snapshot, runtime, onNewExperiment, onReset, isMuted, onMute, microphoneOn, onMicrophone, onText }: { snapshot: WorldSnapshot; runtime: WorldRuntime; onNewExperiment(): void; onReset(): void; isMuted: boolean; onMute(): void; microphoneOn: boolean; onMicrophone(): void; onText(): void }) {
  const waiting = snapshot.phase === 'pending' || snapshot.phase === 'ready';
  return <><aside className="public-controls" aria-label="会話の操作"><div className="public-controls__actions">
    <button type="button" className="public-controls__text" aria-label="文字で話す" title="文字で話す" onClick={onText}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h6" /></svg></button>
    <button type="button" aria-label="マイク入力" title="マイク入力" aria-pressed={microphoneOn} onClick={onMicrophone}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg></button>
    <button type="button" aria-label={isMuted ? '音声をオンにする' : '音声をミュートする'} title="音声" aria-pressed={isMuted} onClick={onMute}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4Z" />{isMuted ? <path d="m16 9 5 6m0-6-5 6" /> : <path d="M15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16" />}</svg></button>
    <button type="button" aria-label="会話と世界をリセット" title="会話と世界をリセット" onClick={onReset}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 1 8M3 4v6h6" /></svg></button>
  </div></aside><section className="world-controls" aria-label="世界改変実験">
    <div className="world-status" role="status">
      {waiting ? 'なにか起きそう……' : snapshot.phase === 'error' ? '世界変換エラー' : snapshot.error ? '小物は届かなかった。背景はそのまま。' : snapshot.pendingProps.length ? 'なにか近づいている……' : snapshot.world.revision ? 'さて、この世界でどうしよう？' : '脳内のカードが、世界にも漏れ出す。'}
      {snapshot.error && <button type="button" onClick={() => void runtime.retry()} disabled={snapshot.attempts >= 20}>再試行</button>}
      {(waiting || snapshot.pendingProps.length > 0) && <button type="button" onClick={runtime.cancel}>取り消す</button>}
    </div>

    <details><summary>実験の状態</summary>
    {snapshot.error && <p className="world-error">{snapshot.error} <button type="button" onClick={() => void runtime.retry()} disabled={snapshot.attempts >= 20}>再試行</button></p>}
      <button type="button" onClick={runtime.toggleLayout}>本人の領域を調整</button>
      <p>処理 {snapshot.phase} · 画像生成 {snapshot.attempts} / 20 · 世界 {snapshot.world.revision}</p>
      <button type="button" onClick={onNewExperiment}>新しい実験</button>
      <p>新しい実験は会話と世界を戻し、生成上限を20回に戻します。</p>
      {snapshot.drive && <p>行動欲求 {snapshot.drive.score.toFixed(2)} / しきい値 {snapshot.drive.threshold.toFixed(2)}</p>}
      {snapshot.sceneDiagnostics && <pre>{JSON.stringify({ displayedScene: snapshot.sceneDiagnostics }, null, 2)}</pre>}
      {snapshot.lastResult && <pre>{JSON.stringify({ timing: snapshot.lastResult.timing, displayedAt: snapshot.displayedAt, presenceShownAt: snapshot.presenceShownAt, reactionStartedAt: snapshot.reactionStartedAt, propDisplayedAt: snapshot.propDisplayedAt, propReactionStartedAt: snapshot.propReactionStartedAt, foregroundEntities: [...snapshot.world.props, ...snapshot.world.creatures].map(e => ({ id: e.id, asset: e.asset, placement: e.placement, scale: e.scale, image: e.image?.key })), pendingProps: snapshot.pendingProps.length, readyProps: snapshot.readyProps, observation: snapshot.observation, propObservation: snapshot.propObservation }, null, 2)}</pre>}
    </details>
  </section></>;
}
