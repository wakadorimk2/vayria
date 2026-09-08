import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { activatePublic, pausePublic, publicActive, publicSessionId, subscribePublic, type PublicStatus } from './session';
type Turnstile = { render(element: HTMLElement, options: object): string; remove(id: string): void; reset(id: string): void };
declare global { interface Window { turnstile?: Turnstile } }
export default function PublicControls() {
  const active = useSyncExternalStore(subscribePublic, publicActive);
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [message, setMessage] = useState('接続を確認しています。');
  const [token, setToken] = useState(''); const [pending, setPending] = useState(false);
  const [manual, setManual] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const challenge = useRef<HTMLDivElement>(null); const widget = useRef<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      let response = await fetch('/api/session'); let value = await response.json();
      if (response.ok && !value.cookieReady) { response = await fetch('/api/session'); value = await response.json(); }
      if (disposed) return;
      if (!response.ok) { setMessage('現在は準備中です。'); return; }
      setStatus(value); setMessage(!value.enabled ? '会話機能は準備中です。カード操作を試せます。' : value.cookieReady ? 'カードを選んで、会話を始めてください。' : '会話には匿名Cookieを有効にしてください。');
    })().catch(() => { if (!disposed) setMessage('接続できませんでした。'); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!expanded || active || !status?.enabled || !status.siteKey || !challenge.current) return;
    let disposed = false;
    const render = () => { if (!disposed && challenge.current && window.turnstile) widget.current = window.turnstile.render(challenge.current, {
      sitekey: status.siteKey, action: 'session', callback: setToken, 'expired-callback': () => setToken(''), 'error-callback': () => setToken(''),
    }); };
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.onload = render;
    if (window.turnstile) render(); else document.head.append(script);
    return () => { disposed = true; if (widget.current) window.turnstile?.remove(widget.current); widget.current = null; script.remove(); };
  }, [status?.siteKey, status?.enabled, expanded, active]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) { pausePublic(); setMessage('録音を停止しました。再開は会話を始めるから行えます。'); } };
    const timer = window.setInterval(() => { if (active && status?.session && status.session.expires <= Date.now()) { pausePublic(); setMessage('体験が終了しました。'); } }, 500);
    const error = (event: Event) => {
      const reason = (event as CustomEvent).detail;
      const messages: Record<string, string> = { visitor_day_limit: '今日はここまで。', visitor_month_limit: '今月の体験回数に達しました。', busy: '混雑しています。少し待ってください。', generation_stopped: '現在は会話を休止しています。' };
      setExpanded(true);
      setMessage((messages[reason.code] ?? '利用枠または接続状態を確認してください。') + (reason.retryAt ? ` 再開可能: ${new Date(reason.retryAt).toLocaleString('ja-JP')}` : ''));
    };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('vayria-public-error', error);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('vayria-public-error', error); };
  }, [active, status]);
  const start = async () => {
    window.dispatchEvent(new Event('vayria-public-prepare'));
    setPending(true);
    try {
      const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const value = await response.json();
      if (!response.ok) { window.dispatchEvent(new CustomEvent('vayria-public-error', { detail: value })); return; }
      setStatus(s => ({ ...s, ...value })); activatePublic(value.session); setExpanded(false); setMessage('会話中です。マイクボタンで音声入力を開始できます。');
    } catch { setMessage('接続できませんでした。もう一度お試しください。');
    } finally { setPending(false); setToken(''); if (widget.current) window.turnstile?.reset(widget.current); }
  };
  const end = async () => {
    const id = publicSessionId(); pausePublic();
    const response = await fetch('/api/session', { method: 'DELETE', headers: { 'X-Vayria-Session': id } });
    if (response.ok) { const value = await response.json(); setStatus(s => ({ ...s, ...value })); }
    setMessage('会話を終了しました。カード操作は続けられます。');
  };
  return <aside className="public-controls" aria-label="公開版の利用案内">
    <button className="public-controls__disclosure" aria-expanded={expanded} aria-controls="public-session-panel" onClick={() => setExpanded(value => !value)}>{active ? '会話の設定' : '会話を始める'}</button>
    {active && <button onClick={() => { pausePublic(); setExpanded(true); setMessage('録音と再生を停止しました。会話を始めるで再開できます。'); }}>停止</button>}
    <button onClick={() => window.dispatchEvent(new Event('vayria-public-text-input'))}>文字入力</button>
    <div id="public-session-panel" className="public-controls__panel" hidden={!expanded}>
    <p aria-live="polite">{message} {status && `残り: 本日${status.remainingDay}回・今月${status.remainingMonth}回`}</p>
    <button disabled={pending || !status?.cookieReady || !status.enabled || (!active && !status.session && !token)} onClick={() => void (active ? end() : start())}>{active ? '会話を終了' : '会話を始める'}</button>
    {active && <button onClick={() => { pausePublic(); setMessage('録音と再生を停止しました。会話を始めるで再開できます。'); }}>録音・再生を停止</button>}
    <label><input type="checkbox" checked={manual} onChange={event => { setManual(event.target.checked); window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: event.target.checked, pressed: false } })); }} />押して話す（オフで自動検出）</label>
    {manual && <button disabled={!active} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: true } })); }} onPointerUp={() => window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: false } }))} onPointerCancel={() => window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: false } }))}>押している間に話す</button>}
    <div ref={challenge} hidden={active} />
    <details><summary>送信先・利用条件</summary>音声認識と文章生成はOpenAI、音声合成はAivis Cloudへ送信します。匿名Cookieを90日間保存し、利用回数を管理します。会話本文と音声はアプリの永続ログへ保存しません。<br />アバター作者: わかどり。このアプリでの表示を許可しています。第三者への再利用許諾ではありません。<br />音声: zonoko / zgock（配布元の表示: CC0）。<a href="https://hub.aivis-project.com/aivm-models/7fc08a41-b64d-456d-8b22-8e1284674775" target="_blank" rel="noreferrer">モデル情報</a></details>
    </div>
  </aside>;
}
