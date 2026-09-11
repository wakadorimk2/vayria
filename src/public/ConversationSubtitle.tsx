import { useEffect, useRef, useState } from 'react';
import type { LiveCaption } from '../live/liveConversation';
import { fitsSubtitle, SubtitleDisplay } from './subtitleDisplay';

export default function ConversationSubtitle({ captions, speaking, active, reply }: {
  captions?: readonly LiveCaption[]; speaking: boolean; active: boolean; reply?: string;
}) {
  const element = useRef<HTMLParagraphElement>(null);
  const current = useRef({ captions, speaking, active, reply });
  const [text, setText] = useState('');
  useEffect(() => { current.current = { captions, speaking, active, reply }; }, [captions, speaking, active, reply]);
  useEffect(() => {
    const display = new SubtitleDisplay();
    const context = document.createElement('canvas').getContext('2d');
    let legacyReply = '', legacyAt = -Infinity;
    const clear = () => { display.reset(current.current.captions); legacyReply = current.current.reply ?? ''; legacyAt = -Infinity; setText(''); };
    const hidden = () => { if (document.hidden) clear(); };
    const timer = window.setInterval(() => {
      const value = current.current;
      if (!value.active || document.hidden) { clear(); return; }
      const node = element.current;
      if (!node || !context) return;
      const style = getComputedStyle(node);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const width = Math.max(1, node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2);
      const fits = (candidate: string) => fitsSubtitle(candidate, width, part => context.measureText(part).width);
      const now = performance.now();
      if (!value.captions) {
        if (value.reply !== legacyReply) { legacyReply = value.reply ?? ''; legacyAt = now; }
        if (value.speaking) legacyAt = now;
        setText(now - legacyAt < 2000 ? legacyReply : '');
      } else setText(display.update(value.captions, value.speaking, now, fits));
    }, 50);
    document.addEventListener('visibilitychange', hidden);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  return <p ref={element} className="reply conversation-subtitle" style={{ visibility: text && active ? 'visible' : 'hidden' }}>{text || '\u00a0'}</p>;
}
