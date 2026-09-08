import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import App from '../App';
import { pausePublic, publicExhibition, subscribePublic, updatePublicStatus } from './session';
import { hasPendingHandoff, prepareHandoff, completeHandoff } from './exhibitionHandoff';

const pendingHandoff = () => { try { return hasPendingHandoff(sessionStorage); } catch { return false; } };

// Remount the same public app to discard all participant state, including cards and pending input.
export default function PublicApp() {
  const exhibition = useSyncExternalStore(subscribePublic, publicExhibition);
  const [handoff, setHandoff] = useState(pendingHandoff);
  const [error, setError] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [welcome, setWelcome] = useState(false);
  const retryRef = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false;
    let busy = false;
    const controller = new AbortController();
    const next = async () => {
      if (busy) return;
      busy = true;
      pausePublic(); setHandoff(true); setError(false);
      try {
        const request = prepareHandoff(sessionStorage, publicExhibition()?.epoch ?? -1);
        const response = await fetch('/api/exhibition/next', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error('Handoff not confirmed');
        const status = await response.json();
        if (disposed) return;
        updatePublicStatus(status);
        completeHandoff(sessionStorage);
        setGeneration(n => n + 1); setHandoff(false); setWelcome(true);
      } catch { if (!disposed) setError(true); }
      finally { busy = false; }
    };
    const onNext = () => { void next(); };
    retryRef.current = onNext;
    window.addEventListener('vayria-exhibition-next', onNext);
    if (pendingHandoff()) onNext();
    return () => { disposed = true; controller.abort(); window.removeEventListener('vayria-exhibition-next', onNext); };
  }, []);
  return <div className="public-layout" data-exhibition={!!exhibition} onPointerDown={() => setWelcome(false)} onKeyDown={() => setWelcome(false)}>
    {handoff ? <main className="public-handoff" aria-live="polite">
      <h1>{error ? '参加者交代を完了できませんでした' : '次の方を迎える準備中です'}</h1>
      <p>{error ? '接続を確認してから、もう一度お試しください。前の会話は再開しません。' : '会話・カード・音声を初期化しています。'}</p>
      {error && <button onClick={() => retryRef.current()}>もう一度確認する</button>}
    </main> : <>{welcome && <p className="public-exhibition-welcome" role="status">次の方もカードからどうぞ</p>}<App key={generation} /></>}
  </div>;
}
