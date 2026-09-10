import { runtimeConfig } from '../runtimeConfig';
import { requestPublicSession } from '../public/session';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { VrmStageHandle } from '../avatar/VrmStage';
import { useWorldLayout } from '../world/useWorldLayout';
import { placeWorldProp, type WorldRect } from '../world/worldLayout';
import { SLOT_CARDS, type Manifestation } from './types';
import type { ManifestationSession, SlotSnapshot } from './session';
import { keyGreen, preparedVideos } from './media';
import './manifestation.css';
import { BenchmarkPanel } from './BenchmarkPanel';

const labels = { chicken: '🐓 鶏', gigantic: '↗ 巨大', sparkle: '✨ きらきら', underwater: '🫧 水中' };
const layoutSink = { setLayout: () => {} };
function VideoObject({ object, onReady }: { object: Manifestation; onReady(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const video = preparedVideos.get(object.url), ctx = canvas.current?.getContext('2d', { willReadFrequently: true });
    if (!video || !ctx) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0, last = 0;
    const draw = (now: number) => {
      if (now - last >= 40 || reduced) {
        ctx.drawImage(video, 0, 0, 256, 256);
        const pixels = ctx.getImageData(0, 0, 256, 256); keyGreen(pixels.data); ctx.putImageData(pixels, 0, 0); last = now;
        if (object.trace && object.trace.browser.firstFrameDraw === undefined) object.trace.browser.firstFrameDraw = performance.now() - (object.trace.browserOrigin ?? performance.now());
        onReady();
      }
      if (!reduced) frame = requestAnimationFrame(draw);
    };
    if (!reduced) void video.play().catch(() => {});
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); video.pause(); };
  }, [object.url, object.trace, onReady]);
  return <canvas ref={canvas} width={256} height={256} role="img" aria-label="生成された鶏" />;
}
function ObjectView({ object, rect, runtime, age }: { age: number; object: Manifestation; rect: WorldRect | null; runtime: ManifestationSession }) {
  const [ready, setReady] = useState(false);
  const placed = Boolean(rect);
  const onReady = useCallback(() => setReady(true), []);
  useEffect(() => { runtime.markVisible(object.id, placed && ready); }, [runtime, object.id, placed, ready]);
  if (!rect) return null;
  return <div className={`manifestation-object ${object.effects.includes('sparkle') ? 'manifestation-object--sparkle' : ''} ${object.effects.includes('underwater') ? 'manifestation-object--bubbles' : ''}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, opacity: age >= 30000 ? .4 : age >= 15000 ? .75 : 1 }}>
    {object.kind === 'video' ? <VideoObject object={object} onReady={onReady} /> : <img src={object.url} alt="鶏の小物" onLoad={() => setReady(true)} onError={() => setReady(false)} />}
  </div>;
}
export function ManifestationStage({ runtime, snapshot, stage, onSelection, onReset, onNewExperiment, brain }: { runtime: ManifestationSession; snapshot: SlotSnapshot; stage: RefObject<VrmStageHandle | null>; onSelection(open: boolean): void; onReset(): void; onNewExperiment(): void; brain: string[] }) {
  const root = useRef<HTMLDivElement>(null);
  const { layout } = useWorldLayout(root, stage, layoutSink);
  const [open, setOpen] = useState(false);
  const [clientId] = useState(() => crypto.randomUUID());
  const occupied: WorldRect[] = [];
  const objects = [...snapshot.objects].sort((a, b) => b.insertedAt - a.insertedAt).map((object, i) => {
    const age = snapshot.now - object.displayedAt;
    const scale = object.scale * (i === 0 ? 1 : i === 1 ? .8 : .65) * (age >= 30000 ? .6 : age >= 15000 ? .8 : 1);
    let placement: ReturnType<typeof placeWorldProp> = null;
    for (const anchor of [{ x: .83, y: .60 }, { x: .17, y: .60 }, { x: .85, y: .35 }, { x: .15, y: .35 }, { x: .83, y: .76 }, { x: .17, y: .76 }]) {
      placement = placeWorldProp(layout, anchor, { bounds: { x: 0, y: 0, width: 1, height: 1 }, pivot: { x: .5, y: .5 }, aspect: 1, displayWidth: .22 }, scale, occupied);
      if (placement) break;
    }
    if (placement) occupied.push(placement.visible);
    return <ObjectView age={age} key={object.id} object={object} rect={placement?.rect ?? null} runtime={runtime} />;
  });
  const select = (value: boolean) => { setOpen(value); onSelection(value); if (!value) requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('.manifestation-slot__entry')?.focus()); };
  return <div className="manifestation-stage" ref={root}>
    {objects}
    {snapshot.pending > 0 && <div className="manifestation-summon" role="status" aria-label="何かが生まれそう">✧</div>}
    {runtimeConfig.mode !== 'public' && <><div className="manifestation-slot">
      <button key={snapshot.sequence} className={snapshot.sequence ? 'manifestation-slot__entry manifestation-slot__entry--pulse' : 'manifestation-slot__entry'} aria-expanded={open} aria-controls="manifestation-picker" onClick={() => select(!open)}>＋<span>一枚、どうぞ</span></button>
      {open && <div id="manifestation-picker" className="manifestation-picker" role="group" aria-label="入れるカード" onKeyDown={e => { if (e.key === 'Escape') select(false); }}>
        {SLOT_CARDS.map(card => <button key={card} onClick={async () => { if (!await requestPublicSession()) return; select(false); runtime.dispatch({ eventId: crypto.randomUUID(), sessionId: runtime.id, generation: snapshot.generation, clientId, cardId: card }); }}>{labels[card]}</button>)}
        <button onClick={() => select(false)}>閉じる</button>
      </div>}
    </div>
    <details className="manifestation-debug"><summary>開発情報</summary><p>脳内: {brain.join(' / ')}</p><p>世代 {snapshot.generation}・待機 {snapshot.pending}</p><pre>{JSON.stringify(snapshot.telemetry, null, 2)}</pre><button onClick={() => { select(false); onReset(); }}>セッションをリセット</button><button onClick={() => { select(false); onNewExperiment(); }}>新しい実験（総予算は維持）</button><button disabled={!snapshot.pending} onClick={() => runtime.cancelPending()}>生成待ちを取り消す</button><button onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot.telemetry, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'manifestation-play-latency.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}>通常操作の計測を保存</button><BenchmarkPanel /></details></>}
  </div>;
}
