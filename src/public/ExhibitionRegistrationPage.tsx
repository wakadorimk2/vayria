import { useEffect, useRef, useState } from 'react';
import ExhibitionControls from './ExhibitionControls';
import { publicErrorMessage } from './errors';
import { hasPendingHandoff } from './exhibitionHandoff';
import { finishRegistration, readRegistrationStatus } from './exhibitionRegistration';
import type { PublicStatus } from './session';

export default function ExhibitionRegistrationPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(true);
  const [message, setMessage] = useState('登録状態を確認しています…');
  const [needsReset, setNeedsReset] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    document.title = '展示端末の登録 | Vayria';
    void readRegistrationStatus(abort.signal).then(value => {
      if (abort.signal.aborted) return;
      const resetPending = hasPendingHandoff(sessionStorage);
      setStatus(value); setNeedsReset(resetPending);
      setMessage(resetPending ? '参加者の初期化が未完了です。再試行してください。' : value.cookieReady ? '' : '端末登録にはCookieを有効にしてください。');
    }).catch(() => {
      if (!abort.signal.aborted) setMessage('登録状態を確認できませんでした。もう一度確認してください。');
    }).finally(() => { if (!abort.signal.aborted) setPending(false); });
    return () => abort.abort();
  }, []);

  const reset = async (value: PublicStatus, signal: AbortSignal) => {
    setNeedsReset(true); setMessage('体験画面へ戻る準備をしています…');
    try {
      await finishRegistration(value.exhibition?.epoch ?? -1, signal);
      if (!signal.aborted) window.location.replace('/');
    } catch {
      if (!signal.aborted) setMessage('参加者の初期化を完了できませんでした。接続を確認して再試行してください。');
    }
  };
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (busy.current || !controller.current) return;
    busy.current = true; setPending(true);
    const signal = controller.current.signal;
    try { await action(signal); }
    finally { busy.current = false; if (!signal.aborted) setPending(false); }
  };
  const check = () => run(async signal => {
    try {
      const value = await readRegistrationStatus(signal);
      if (signal.aborted) return;
      setStatus(value); setUncertain(false); setNeedsReset(hasPendingHandoff(sessionStorage));
      setMessage(value.cookieReady ? '現在の登録状態を取得しました。' : '端末登録にはCookieを有効にしてください。');
    } catch { if (!signal.aborted) setMessage('登録状態を確認できませんでした。もう一度確認してください。'); }
  });
  const enroll = () => run(async signal => {
    setMessage('登録しています…');
    try {
      const response = await fetch('/api/exhibition/enroll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim() }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      const value = await response.json();
      if (signal.aborted) return;
      if (response.status >= 500) throw new Error('Registration result uncertain');
      if (!response.ok) { setMessage(publicErrorMessage(value)); return; }
      setCode(''); setStatus(value);
      await reset(value, signal);
    } catch {
      if (signal.aborted) return;
      setCode(''); setUncertain(true);
      // A one-use code may have been consumed. Never resend automatically.
      try {
        const value = await readRegistrationStatus(signal);
        if (signal.aborted) return;
        setStatus(value); setUncertain(false);
        setMessage('登録の応答を確認できませんでした。現在の登録状態を取得しました。');
        if (value.exhibition && !value.exhibition.revoked && value.exhibition.id !== status?.exhibition?.id) await reset(value, signal);
      } catch { if (!signal.aborted) setMessage('登録結果を確認できませんでした。「登録状態を確認」で確認してください。'); }
    }
  });
  const form = <form onSubmit={event => { event.preventDefault(); void enroll(); }}>
    <label htmlFor="exhibition-code">端末登録コード</label>
    <input id="exhibition-code" type="password" value={code} onChange={event => setCode(event.target.value)}
      autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32} required disabled={pending || !status?.cookieReady || uncertain || needsReset} />
    <button type="submit" disabled={pending || !status?.cookieReady || !code.trim() || uncertain || needsReset}>この端末を登録</button>
  </form>;
  return <div className="public-layout public-registration-layout"><main className="public-registration">
    <h1>展示端末の登録</h1>
    <p>運営から受け取ったコードで、このブラウザを展示端末として登録します。</p>
    <ExhibitionControls exhibition={status?.exhibition} />
    {status?.exhibition && !status.exhibition.revoked
      ? <><p>このブラウザは展示端末として登録済みです。</p>
        {!needsReset && <button disabled={pending || uncertain} onClick={() => void run(signal => reset(status, signal))}>体験画面へ戻る</button>}
        <details><summary>別のコードで登録する</summary>{form}</details></>
      : form}
    <p role="status">{message}</p>
    {needsReset && status && <button disabled={pending} onClick={() => void run(signal => reset(status, signal))}>初期化を再試行</button>}
    <button disabled={pending} onClick={() => void check()}>登録状態を確認</button>
    {!needsReset && !status?.exhibition && <a href="/">体験画面へ戻る</a>}
  </main></div>;
}
