import { publicUrl } from './paths';
import type { SettingsLayout } from './settingsLayout';
import { publicErrorMessage } from './errors';
import type { ThemePreference, ResolvedTheme } from './theme';
import PublicSettingsPanel from './PublicSettingsPanel';
import { microphoneStateLabels, normalizeMicrophoneLevel, type MicrophoneState } from './microphoneState';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { activatePublic, cancelPublicAction, pausePublic, publicActive, publicExhibition, publicSessionId, registerPublicSessionRequest, subscribePublic, updatePublicStatus, type PublicStatus } from './session';
import ExhibitionControls from './ExhibitionControls';
type Turnstile = { render(element: HTMLElement, options: object): string; remove(id: string): void; reset(id: string): void };
declare global { interface Window { turnstile?: Turnstile } }
export default function PublicControls({ settingsLayout, onSettingsOpenChange, cardsOpen, textOpen, onCardsToggle, greetingComplete, greetingBusy, onGreeting, themePreference, resolvedTheme, onThemeChange, isMuted, onMuteToggle, microphoneOn, microphoneState, microphoneLevel, onMicrophoneToggle }: {
  settingsLayout: SettingsLayout;
  onSettingsOpenChange: (open: boolean) => void;
  cardsOpen: boolean;
  textOpen: boolean;
  onCardsToggle: () => void;
  greetingComplete: boolean;
  greetingBusy: boolean;
  onGreeting: () => void;
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  onThemeChange: (theme: ThemePreference) => void;
  isMuted: boolean;
  onMuteToggle: () => void;
  microphoneOn: boolean;
  microphoneState: MicrophoneState;
  microphoneLevel: number | null;
  onMicrophoneToggle: () => void;
}) {
  const active = useSyncExternalStore(subscribePublic, publicActive);
  const exhibition = useSyncExternalStore(subscribePublic, publicExhibition);
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [statusStale, setStatusStale] = useState(false);
  const exhibitionId = exhibition?.id;
  const [statusRefresh, setStatusRefresh] = useState(0);
  const [message, setMessage] = useState('接続を確認しています。');
  const [token, setToken] = useState(''); const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const microphoneLabel = microphoneStateLabels[microphoneState];
  const microphoneAction = microphoneOn ? 'マイクを止める' : 'マイクで話す';
  const microphonePending = microphoneState === 'starting' || microphoneState === 'stopping';
  const level = normalizeMicrophoneLevel(microphoneLevel);
  const request = useRef<{ promise: Promise<boolean>; resolve: (value: boolean) => void } | null>(null);
  const startAbort = useRef<AbortController | null>(null);
  const finishRequest = useCallback((success: boolean) => { request.current?.resolve(success); request.current = null; setRequested(false); }, []);
  const cancelRequest = useCallback(() => { cancelPublicAction(); startAbort.current?.abort(); startAbort.current = null; setPending(false); setToken(''); finishRequest(false); }, [finishRequest]);
  const [manual, setManual] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { onSettingsOpenChange(expanded); }, [expanded, onSettingsOpenChange]);
  const closeSettings = useCallback(() => {
    cancelRequest(); setExpanded(false);
    document.querySelector<HTMLElement>('.public-controls__disclosure')?.focus();
  }, [cancelRequest]);
  const challenge = useRef<HTMLDivElement>(null); const widget = useRef<string | null>(null);
  useEffect(() => registerPublicSessionRequest(() => {
    if (request.current) return request.current.promise;
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    request.current = { promise, resolve };
    setMessage('確認が終わると、選んだ操作を続けます。マイクの許可は音声入力を選んだときだけ求めます。');
    setStatus(null); setToken(''); setStatusRefresh(value => value + 1);
    setRequested(true); setNoticeOpen(true);
    return promise;
  }), []);
  useEffect(() => () => { startAbort.current?.abort(); request.current?.resolve(false); }, []);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      let response = await fetch(publicUrl('/api/session')); let value = await response.json();
      if (response.ok && !value.cookieReady) { response = await fetch(publicUrl('/api/session')); value = await response.json(); }
      if (disposed) return;
      if (!response.ok) { setMessage('接続できませんでした。再読み込みしてください。'); finishRequest(false); return; }
      setStatus(value); updatePublicStatus(value); if (!request.current) setMessage(!value.enabled ? '会話機能は準備中です。カード操作を試せます。' : value.cookieReady ? 'カード交換や文字送信から始められます。' : '会話には匿名Cookieを有効にしてください。');
    })().catch(() => { if (!disposed) { setMessage('接続できませんでした。再読み込みしてください。'); finishRequest(false); } });
    return () => { disposed = true; };
  }, [finishRequest, statusRefresh]);
  useEffect(() => {
    if (!exhibitionId) return;
    let disposed = false;
    const refresh = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch(publicUrl('/api/session'), { signal: AbortSignal.timeout(10000) });
        if (disposed) return;
        if (!response.ok) throw new Error('Status refresh failed');
        const value: PublicStatus = await response.json();
        if (disposed) return;
        setStatus(value); updatePublicStatus(value); setStatusStale(false);
        if (!value.exhibition?.available || value.stopped || !value.enabled) pausePublic();
      } catch { if (!disposed) setStatusStale(true); }
    };
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    return () => { disposed = true; clearInterval(timer); };
  }, [exhibitionId]);
  useEffect(() => {
    if (!noticeOpen || active || !status?.enabled || status.exhibition || !status.siteKey || !challenge.current) return;
    let disposed = false;
    const render = () => { if (!disposed && challenge.current && window.turnstile) widget.current = window.turnstile.render(challenge.current, {
      sitekey: status.siteKey, action: 'session', callback: (value: string) => { if (!disposed) setToken(value); }, 'expired-callback': () => { if (!disposed) setToken(''); }, 'error-callback': () => { if (disposed) return; setToken(''); setMessage('確認を完了できませんでした。閉じてからもう一度操作してください。'); finishRequest(false); },
    }); };
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.onload = render;
    script.onerror = () => { if (!disposed) { setMessage('確認画面を読み込めませんでした。閉じてからもう一度操作してください。'); finishRequest(false); } };
    if (window.turnstile) render(); else document.head.append(script);
    return () => { disposed = true; if (widget.current) window.turnstile?.remove(widget.current); widget.current = null; script.remove(); };
  }, [status?.siteKey, status?.enabled, status?.exhibition, noticeOpen, active, finishRequest]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) { cancelRequest(); pausePublic(); setMessage('カード交換・文字送信・マイク操作から再開できます。'); } };
    const timer = window.setInterval(() => { if (active && status?.session && status.session.expires <= Date.now()) { pausePublic(); setMessage('体験が終了しました。'); } }, 500);
    const error = (event: Event) => {
      const reason = (event as CustomEvent).detail;
      finishRequest(false); setNoticeOpen(true);
      setMessage(publicErrorMessage(reason));
    };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('vayria-public-error', error);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('vayria-public-error', error); };
  }, [active, status, cancelRequest, finishRequest]);
  useEffect(() => {
    if (!requested || pending || !status) return;
    if (!status.enabled || !status.cookieReady || status.stopped) {
      // Admission follows an external session response, not a derived visual state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessage(!status.cookieReady ? '会話には匿名Cookieを有効にしてください。' : '現在は会話を休止しています。'); finishRequest(false); return;
    }
    if (status.exhibition && !status.exhibition.available) {
      setMessage('展示枠が利用できません。運営設定で期間・予算・端末登録を確認してください。'); finishRequest(false); return;
    }
    if (!status.exhibition && !token && !(status.session && status.session.expires > Date.now())) return;
    const controller = new AbortController(); startAbort.current = controller; setPending(true);
    void (async () => {
      try {
        const response = await fetch(publicUrl('/api/session'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, epoch: status.exhibition?.epoch }), signal: controller.signal });
        const value = await response.json();
        if (controller.signal.aborted || document.hidden) return;
        if (!response.ok) { window.dispatchEvent(new CustomEvent('vayria-public-error', { detail: value })); return; }
        setStatus(s => ({ ...s, ...value })); updatePublicStatus(value); setStatusStale(false); activatePublic(value.session); finishRequest(true); setNoticeOpen(false);
        setMessage('会話中です。マイクは「マイクで話す」を押したときだけ使います。');
      } catch { if (!controller.signal.aborted) { setMessage('接続できませんでした。もう一度操作してください。'); finishRequest(false); }
      } finally { if (startAbort.current === controller) { startAbort.current = null; setPending(false); setToken(''); if (widget.current) window.turnstile?.reset(widget.current); } }
    })();
  }, [requested, pending, status, token, finishRequest]);
  const end = async () => {
    const id = publicSessionId(); cancelRequest(); pausePublic(); setExpanded(false); setNoticeOpen(true);
    try {
      const response = await fetch(publicUrl('/api/session'), { method: 'DELETE', headers: { 'X-Vayria-Session': id } });
      if (!response.ok) throw new Error('Session end failed');
      const value = await response.json(); setStatus(s => ({ ...s, ...value })); updatePublicStatus(value); setStatusStale(false);
      setMessage('会話を終了しました。カード操作は続けられます。');
    } catch { setMessage('再生と録音を停止しました。終了の通信を確認できませんでした。'); }
  };
  return <aside className="public-controls" aria-label="会話の操作">
    {exhibition && <div className="public-exhibition-handoff">
      <button onClick={() => { cancelRequest(); window.dispatchEvent(new Event('vayria-exhibition-next')); }}>体験を終える</button>
      {(!exhibition.available || status?.stopped || status?.enabled === false) && <span className="public-exhibition-paused" role="status">展示を休止しています。設定を確認してください。</span>}
    </div>}
    {!noticeOpen && !cardsOpen && !textOpen && !expanded && <div className="public-entry" aria-label="Vayriaとの会話を始める">
      {!greetingComplete ? <>
        <p className="public-entry__title">Vayriaに、ひとこと。</p>
        <button className="public-entry__greeting" disabled={greetingBusy} onClick={onGreeting}>{greetingBusy ? '返答を待っています…' : '挨拶してみる'}</button>
        <p>{isMuted ? '字幕で返事します' : '声と字幕で返事します'}</p>
      </> : <p className="public-entry__continue">文字・マイク・カードから続けられます</p>}
    </div>}
    {noticeOpen && <section className="public-entry public-entry--notice" aria-label="会話の接続と案内">
      <p role="status">{message}</p>
      {requested && <p>{pending ? '接続しています…' : '確認が終わると、選んだ操作を続けます。'}</p>}
      <div ref={challenge} hidden={active} />
      <button onClick={() => { cancelRequest(); setNoticeOpen(false); }}>{requested ? 'キャンセル' : '操作を選び直す'}</button>
    </section>}
    <div className="public-controls__actions">
      <button className="public-controls__cards" aria-label="カードで遊ぶ" title="カードで遊ぶ" aria-expanded={cardsOpen} aria-controls="public-card-panel" onClick={() => { setExpanded(false); if (!expanded || !cardsOpen) onCardsToggle(); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="7" y="3" width="13" height="18" rx="2" /><path d="m4 6-2 1 3 14M13.5 8l3 4-3 4-3-4Z" /></svg>
      </button>
      <button className="public-controls__text" aria-expanded={textOpen} aria-controls="public-text-panel" aria-label="文字で話す" title="文字で話す" onClick={() => { setExpanded(false); window.dispatchEvent(new Event('vayria-public-prepare')); if (!expanded || !textOpen) window.dispatchEvent(new Event('vayria-public-text-input')); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h6" /></svg>
      </button>
      <button className="public-controls__microphone" data-state={microphoneState} aria-label={`${microphoneAction}。${microphoneLabel || 'オフ'}`} title={`${microphoneAction}。${microphoneLabel || 'オフ'}`} aria-pressed={microphoneOn} disabled={microphonePending} onClick={onMicrophoneToggle}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="2" width="6" height="12" rx="3" fill={microphoneOn ? 'currentColor' : 'none'} /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />{microphoneState === 'off' && <path d="m3 3 18 18" />}</svg>
        {(microphonePending || microphoneState === 'recognizing') && <span className="public-controls__progress" aria-hidden="true" />}
        {microphoneState === 'error' && <span className="public-controls__error" aria-hidden="true">!</span>}
        {microphoneState === 'speaking' && <span className="public-controls__level" aria-hidden="true" style={{ '--input-level': level ?? .5 } as CSSProperties}><i /><i /><i /></span>}
      </button>
      <button aria-label={isMuted ? '音声をオンにする' : '音声をミュートする'} title={isMuted ? '音声をオンにする' : '音声をミュートする'} aria-pressed={isMuted} onClick={onMuteToggle}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M11 4 6 8H3v8h3l5 4Z" />{isMuted ? <path d="m16 9 5 6m0-6-5 6" /> : <><path d="M15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16" /></>}</svg>
      </button>
      <button className="public-controls__disclosure" aria-label={status?.exhibition?.warning ? '設定：展示予算の通知あり' : '設定'} title="設定" aria-expanded={expanded} aria-controls="public-session-panel" onClick={() => { if (expanded) closeSettings(); else setExpanded(true); }}>
        {status?.exhibition?.warning && <span className="public-exhibition-notification" aria-hidden="true">!</span>}
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polygon points="21.95,11.02 21.95,12.98 19.66,14.32 19.06,15.77 19.73,18.34 18.34,19.73 15.77,19.06 14.32,19.66 12.98,21.95 11.02,21.95 9.68,19.66 8.23,19.06 5.66,19.73 4.27,18.34 4.94,15.77 4.34,14.32 2.05,12.98 2.05,11.02 4.34,9.68 4.94,8.23 4.27,5.66 5.66,4.27 8.23,4.94 9.68,4.34 11.02,2.05 12.98,2.05 14.32,4.34 15.77,4.94 18.34,4.27 19.73,5.66 19.06,8.23 19.66,9.68" /><circle cx="12" cy="12" r="3.2" /></svg>
      </button>
    </div>
    <PublicSettingsPanel layout={settingsLayout} open={expanded} onClose={closeSettings}>
    <fieldset className="public-theme" data-resolved-theme={resolvedTheme}><legend>テーマ</legend>
      {(['auto', 'light', 'dark'] as const).map((value, index) => <label key={value} title={['自動（端末の設定に合わせる）', 'ライト', 'ダーク'][index]}>
        <input className="visually-hidden" aria-label={['自動', 'ライト', 'ダーク'][index]} type="radio" name="public-theme" value={value} checked={themePreference === value} onChange={() => onThemeChange(value)} />
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          {value === 'auto' ? <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" /></> : value === 'light' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" />}
        </svg>
      </label>)}
    </fieldset>
    <h3>利用状況</h3>
    <p aria-live="polite">{active ? '会話中です。' : status?.enabled === false || status?.stopped ? '現在は会話を休止しています。' : '会話は開始していません。'} {status && !status.exhibition && `残り: 本日${status.remainingDay}回・今月${status.remainingMonth}回`}</p>
    {active && !status?.exhibition && <button onClick={() => void end()}>会話を終了</button>}
    <ExhibitionControls exhibition={status?.exhibition} />
    {statusStale && <p role="status">利用状況を更新できていません。表示は最後に確認できた値です。</p>}
    {microphoneOn && <>
    <h3>音声入力</h3>
    <label><input type="checkbox" checked={manual} onChange={event => { setManual(event.target.checked); window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: event.target.checked, pressed: false } })); }} />押して話す（オフで自動検出）</label>
    {manual && <button disabled={!active} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: true } })); }} onPointerUp={() => window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: false } }))} onPointerCancel={() => window.dispatchEvent(new CustomEvent('vayria-public-microphone', { detail: { manual: true, pressed: false } }))}>押している間に話す</button>}
    </>}
    <details><summary>送信先・利用条件</summary>音声認識と文章生成はOpenAI、音声合成はAivis Cloudへ送信します。匿名Cookieを90日間保存し、利用回数を管理します。会話本文と音声はアプリの永続ログへ保存しません。<br />アバター作者: わかどり。このアプリでの表示を許可しています。第三者への再利用許諾ではありません。<br />音声: zonoko / zgock（配布元の表示: CC0）。<a href="https://hub.aivis-project.com/aivm-models/7fc08a41-b64d-456d-8b22-8e1284674775" target="_blank" rel="noreferrer">モデル情報</a></details>
    </PublicSettingsPanel>
  </aside>;
}
