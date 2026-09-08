import { publicErrorMessage } from './errors';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { activatePublic, pausePublic, publicActive, publicSessionId, registerPublicSessionRequest, subscribePublic, type PublicStatus } from './session';
type Turnstile = { render(element: HTMLElement, options: object): string; remove(id: string): void; reset(id: string): void };
declare global { interface Window { turnstile?: Turnstile } }
export default function PublicControls() {
  const active = useSyncExternalStore(subscribePublic, publicActive);
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [message, setMessage] = useState('接続を確認しています。');
  const [token, setToken] = useState(''); const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [microphoneOn, setMicrophoneOn] = useState(false);
  const request = useRef<{ promise: Promise<boolean>; resolve: (value: boolean) => void } | null>(null);
  const startAbort = useRef<AbortController | null>(null);
  const finishRequest = useCallback((success: boolean) => { request.current?.resolve(success); request.current = null; setRequested(false); }, []);
  const cancelRequest = useCallback(() => { startAbort.current?.abort(); startAbort.current = null; setPending(false); finishRequest(false); }, [finishRequest]);
  const [manual, setManual] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const challenge = useRef<HTMLDivElement>(null); const widget = useRef<string | null>(null);
  useEffect(() => registerPublicSessionRequest(() => {
    if (request.current) return request.current.promise;
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    request.current = { promise, resolve };
    setMessage('確認が終わると、そのまま返答を始めます。マイクの許可は音声入力を選んだときだけ求めます。');
    setRequested(true); setExpanded(true);
    return promise;
  }), []);
  useEffect(() => () => { startAbort.current?.abort(); request.current?.resolve(false); }, []);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      let response = await fetch('/api/session'); let value = await response.json();
      if (response.ok && !value.cookieReady) { response = await fetch('/api/session'); value = await response.json(); }
      if (disposed) return;
      if (!response.ok) { setMessage('接続できませんでした。再読み込みしてください。'); finishRequest(false); return; }
      setStatus(value); if (!request.current) setMessage(!value.enabled ? '会話機能は準備中です。カード操作を試せます。' : value.cookieReady ? 'カード交換や文字送信から始められます。' : '会話には匿名Cookieを有効にしてください。');
    })().catch(() => { if (!disposed) { setMessage('接続できませんでした。再読み込みしてください。'); finishRequest(false); } });
    return () => { disposed = true; };
  }, [finishRequest]);
  useEffect(() => {
    if (!expanded || active || !status?.enabled || !status.siteKey || !challenge.current) return;
    let disposed = false;
    const render = () => { if (!disposed && challenge.current && window.turnstile) widget.current = window.turnstile.render(challenge.current, {
      sitekey: status.siteKey, action: 'session', callback: setToken, 'expired-callback': () => setToken(''), 'error-callback': () => { setToken(''); setMessage('確認を完了できませんでした。閉じてからもう一度操作してください。'); finishRequest(false); },
    }); };
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.onload = render;
    script.onerror = () => { if (!disposed) { setMessage('確認画面を読み込めませんでした。閉じてからもう一度操作してください。'); finishRequest(false); } };
    if (window.turnstile) render(); else document.head.append(script);
    return () => { disposed = true; if (widget.current) window.turnstile?.remove(widget.current); widget.current = null; script.remove(); };
  }, [status?.siteKey, status?.enabled, expanded, active, finishRequest]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) { cancelRequest(); pausePublic(); setMessage('カード交換・文字送信・マイク操作から再開できます。'); } };
    const timer = window.setInterval(() => { if (active && status?.session && status.session.expires <= Date.now()) { pausePublic(); setMessage('体験が終了しました。'); } }, 500);
    const error = (event: Event) => {
      const reason = (event as CustomEvent).detail;
      finishRequest(false); setExpanded(true);
      setMessage(publicErrorMessage(reason));
    };
    const voice = (event: Event) => {
      const value = (event as CustomEvent).detail; setMicrophoneOn(value.enabled);
      if (value.error) { setMessage('マイクを開始できませんでした。文字やカードでも会話できます。'); setExpanded(true); }
    };
    window.addEventListener('vayria-public-voice-state', voice);
    document.addEventListener('visibilitychange', hidden); window.addEventListener('vayria-public-error', error);
    return () => { window.removeEventListener('vayria-public-voice-state', voice); clearInterval(timer); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('vayria-public-error', error); };
  }, [active, status, cancelRequest, finishRequest]);
  useEffect(() => {
    if (!requested || pending || !status) return;
    if (!status.enabled || !status.cookieReady || status.stopped) {
      // Admission follows an external session response, not a derived visual state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessage(!status.cookieReady ? '会話には匿名Cookieを有効にしてください。' : '現在は会話を休止しています。'); finishRequest(false); return;
    }
    if (!token && !(status.session && status.session.expires > Date.now())) return;
    const controller = new AbortController(); startAbort.current = controller; setPending(true);
    void (async () => {
      try {
        const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: controller.signal });
        const value = await response.json();
        if (controller.signal.aborted || document.hidden) return;
        if (!response.ok) { window.dispatchEvent(new CustomEvent('vayria-public-error', { detail: value })); return; }
        setStatus(s => ({ ...s, ...value })); activatePublic(value.session); finishRequest(true); setExpanded(false);
        setMessage('会話中です。マイクは「マイクで話す」を押したときだけ使います。');
      } catch { if (!controller.signal.aborted) { setMessage('接続できませんでした。もう一度操作してください。'); finishRequest(false); }
      } finally { if (startAbort.current === controller) { startAbort.current = null; setPending(false); setToken(''); if (widget.current) window.turnstile?.reset(widget.current); } }
    })();
  }, [requested, pending, status, token, finishRequest]);
  const end = async () => {
    const id = publicSessionId(); cancelRequest(); pausePublic();
    try {
      const response = await fetch('/api/session', { method: 'DELETE', headers: { 'X-Vayria-Session': id } });
      if (!response.ok) throw new Error('Session end failed');
      const value = await response.json(); setStatus(s => ({ ...s, ...value }));
      setMessage('会話を終了しました。カード操作は続けられます。');
    } catch { setMessage('再生と録音を停止しました。終了の通信を確認できませんでした。'); }
  };
  return <aside className="public-controls" aria-label="会話の操作">
    <p className="public-controls__hint">{active ? 'カード・文字・マイクで話せます' : 'カードを入れ替えると、声で反応します'}</p>
    <div className="public-controls__actions">
      <button onClick={() => { window.dispatchEvent(new Event('vayria-public-prepare')); window.dispatchEvent(new Event('vayria-public-text-input')); }}>文字で話す</button>
      <button aria-pressed={microphoneOn} onClick={() => window.dispatchEvent(new Event('vayria-public-voice-toggle'))}>{microphoneOn ? 'マイクを止める' : 'マイクで話す'}</button>
      <button className="public-controls__disclosure" aria-expanded={expanded} aria-controls="public-session-panel" onClick={() => { if (expanded) cancelRequest(); setExpanded(value => !value); }}>利用状況</button>
    </div>
    <div id="public-session-panel" className="public-controls__panel" hidden={!expanded}>
    <button className="public-controls__close" onClick={() => { cancelRequest(); setExpanded(false); }}>閉じる</button>
    <p aria-live="polite">{message} {status && `残り: 本日${status.remainingDay}回・今月${status.remainingMonth}回`}</p>
    {requested && <p>{pending ? '接続しています…' : '確認を完了すると、操作した内容への返答を始めます。'}</p>}
    {active && <button onClick={() => void end()}>会話を終了</button>}
    {microphoneOn && <>
    <label><input type="checkbox" checked={manual} onChange={event => { setManual(event.target.checked); window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: event.target.checked, pressed: false } })); }} />押して話す（オフで自動検出）</label>
    {manual && <button disabled={!active} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: true } })); }} onPointerUp={() => window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: false } }))} onPointerCancel={() => window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: false } }))}>押している間に話す</button>}
    </>}
    <div ref={challenge} hidden={active} />
    <details><summary>送信先・利用条件</summary>音声認識と文章生成はOpenAI、音声合成はAivis Cloudへ送信します。匿名Cookieを90日間保存し、利用回数を管理します。会話本文と音声はアプリの永続ログへ保存しません。<br />アバター作者: わかどり。このアプリでの表示を許可しています。第三者への再利用許諾ではありません。<br />音声: zonoko / zgock（配布元の表示: CC0）。<a href="https://hub.aivis-project.com/aivm-models/7fc08a41-b64d-456d-8b22-8e1284674775" target="_blank" rel="noreferrer">モデル情報</a></details>
    </div>
  </aside>;
}
