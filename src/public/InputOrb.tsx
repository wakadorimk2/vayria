import { useEffect, useRef } from 'react';
import type { AvatarScreenBounds } from '../avatar/screenBounds';
import type { MicrophoneState } from './microphoneState';
import { inputOrbPosition, smoothInputLevel } from './inputOrbLayout';

export default function InputOrb({ state, level, anchor }: { state: MicrophoneState; level: number | null; anchor: AvatarScreenBounds | null }) {
  const element = useRef<HTMLDivElement>(null);
  const path = useRef<SVGPathElement>(null);
  const current = useRef({ state, level, anchor });
  const active = !['off', 'stopping', 'error'].includes(state);
  useEffect(() => { current.current = { state, level, anchor }; }, [state, level, anchor]);
  useEffect(() => {
    if (!active || !element.current) return;
    const node = element.current;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, previous = 0, smoothed = 0, lastLayout = -Infinity;
    const animate = (time: number) => {
      if (document.hidden) { node.style.visibility = 'hidden'; previous = 0; frame = requestAnimationFrame(animate); return; }
      const elapsed = previous ? time - previous : 33;
      if (elapsed < 32) { frame = requestAnimationFrame(animate); return; }
      previous = time;
      const value = current.current;
      const accepting = value.state === 'listening' || value.state === 'speaking';
      smoothed = smoothInputLevel(smoothed, accepting ? value.level : 0, Math.min(elapsed, 100));
      if (!accepting) smoothed = 0;
      const amplitude = smoothed < .005 ? 0 : smoothed;
      const points = Array.from({ length: 32 }, (_, i) => {
        const angle = i * Math.PI / 16;
        const radius = 17 + (reduced.matches ? 0 : amplitude * (2 + 2 * Math.sin(3 * angle + time / 370) + 1.4 * Math.cos(5 * angle - time / 510)));
        return [24 + radius * Math.cos(angle), 24 + radius * Math.sin(angle)];
      });
      path.current?.setAttribute('d', points.map((point, i) => `${i ? 'L' : 'M'}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(' ') + ' Z');
      node.style.opacity = String(accepting ? .55 + amplitude * .45 : .35);
      if (time - lastLayout > 200) {
        lastLayout = time;
        const obstacles = Array.from(document.querySelectorAll<HTMLElement>('.public-controls__actions, .card-zone, .conversation-copy > *, .public-entry, .public-settings-panel, .public-controls__panel'))
          .filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden')
          .map(item => item.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
        const toolbar = document.querySelector('.public-controls__actions')?.getBoundingClientRect();
        const position = inputOrbPosition(innerWidth, innerHeight, value.anchor, obstacles, toolbar?.top ?? innerHeight - 80);
        node.style.visibility = position ? 'visible' : 'hidden';
        if (position) { node.style.left = `${position.x}px`; node.style.top = `${position.y}px`; }
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  const label = state === 'starting' ? 'マイク接続準備中' : state === 'recovering' ? '音声入力の再開待ち' : state === 'recognizing' ? '音声認識中' : 'マイク入力受付中';
  return active ? <div ref={element} className="public-input-orb" role="status" aria-label={label}>
    <svg viewBox="0 0 48 48" aria-hidden="true"><path ref={path} /></svg>
  </div> : null;
}
