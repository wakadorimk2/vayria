import { publicUrl } from './paths';
import { useEffect, useRef, useState } from 'react';
import App from '../App';
import { pausePublic, publicExhibition, updatePublicStatus } from './session';
import { hasPendingHandoff, prepareHandoff, completeHandoff } from './exhibitionHandoff';

const pendingHandoff = () => { try { return hasPendingHandoff(sessionStorage); } catch { return false; } };

// Remount the same public app to discard all participant state, including cards and pending input.
export default function PublicApp() {
  const [handoff, setHandoff] = useState(pendingHandoff);
  const [error, setError] = useState(false);
  const [previewDenied, setPreviewDenied] = useState(false);
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
      pausePublic(); setHandoff(true); setError(false); setPreviewDenied(false);
      const resetLocally = () => { setGeneration(n => n + 1); setHandoff(false); setWelcome(true); };
      const statusFetch = () => fetch(publicUrl('/api/session'), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      // The ticket gate blocks every API call until re-entry; the stored request retries on reload.
      const denyForTicket = () => { try { prepareHandoff(sessionStorage, -1); } catch { /* keep the stored intent */ } if (!disposed) { setPreviewDenied(true); setError(true); } };
      try {
        // Enrollment may not be loaded yet at mount; confirm before choosing the reset path.
        let device = publicExhibition();
        if (!device) {
          const statusResponse = await statusFetch();
          const value = await statusResponse.json().catch(() => null);
          if (disposed) return;
          if (value?.code === 'preview_access_required') { denyForTicket(); return; }
          if (statusResponse.ok && value) { updatePublicStatus(value); device = value.exhibition ?? null; }
        }
        if (!device && !hasPendingHandoff(sessionStorage)) { resetLocally(); return; }
        let response: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const request = prepareHandoff(sessionStorage, device?.epoch ?? -1);
          response = await fetch(publicUrl('/api/exhibition/next'), { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          if (response.ok) break;
          const reason = await response.json().catch(() => null);
          if (disposed) return;
          if (reason?.code === 'preview_access_required') { denyForTicket(); return; }
          // A stored request the server can never confirm must not trap the screen.
          if (reason?.code === 'exhibition_required') { completeHandoff(sessionStorage); resetLocally(); return; }
          if (reason?.code !== 'exhibition_stale') throw new Error('Handoff not confirmed');
          completeHandoff(sessionStorage);
          const refreshed = await statusFetch();
          const refreshedValue = await refreshed.json().catch(() => null);
          if (disposed) return;
          if (refreshedValue?.code === 'preview_access_required') { denyForTicket(); return; }
          if (refreshed.ok && refreshedValue) { updatePublicStatus(refreshedValue); device = refreshedValue.exhibition ?? null; }
          if (!device) { resetLocally(); return; }
        }
        if (!response?.ok) throw new Error('Handoff not confirmed');
        const status = await response.json();
        if (disposed) return;
        updatePublicStatus(status);
        completeHandoff(sessionStorage);
        resetLocally();
      } catch { if (!disposed) setError(true); }
      finally { busy = false; }
    };
    const onNext = () => { void next(); };
    retryRef.current = onNext;
    window.addEventListener('vayria-exhibition-next', onNext);
    const params = new URLSearchParams(location.search);
    const handoffRequested = params.has('handoff');
    if (handoffRequested) {
      params.delete('handoff');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
    }
    if (handoffRequested || pendingHandoff()) onNext();
    return () => { disposed = true; controller.abort(); window.removeEventListener('vayria-exhibition-next', onNext); };
  }, []);
  return <div className="public-layout" onPointerDown={() => setWelcome(false)} onKeyDown={() => setWelcome(false)}>
    {handoff ? <main className="public-handoff" aria-live="polite">
      <h1>{error ? '参加者交代を完了できませんでした' : '次の方を迎える準備中です'}</h1>
      <p>{error ? (previewDenied ? '検証用アクセスチケットの期限が切れました。入力し直すと交代を続けます。' : '接続を確認してから、もう一度お試しください。前の会話は再開しません。') : '会話・カード・音声を初期化しています。'}</p>
      {error && (previewDenied ? <a href={publicUrl('/')}>チケットを入力し直す</a> : <button onClick={() => retryRef.current()}>もう一度確認する</button>)}
    </main> : <>{welcome && <p className="public-exhibition-welcome" role="status">次の方もカードからどうぞ</p>}<App key={generation} /></>}
  </div>;
}
