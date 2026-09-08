import { useState } from 'react';
import { publicErrorMessage } from './errors';
import { pausePublic, updatePublicStatus, type ExhibitionStatus } from './session';

export default function ExhibitionControls({ exhibition }: { exhibition: ExhibitionStatus | null | undefined }) {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const enroll = async () => {
    if (pending) return;
    setPending(true); setMessage('登録しています…'); pausePublic();
    try {
      const response = await fetch('/api/exhibition/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }), signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) { setMessage(publicErrorMessage(result)); return; }
      updatePublicStatus(result); setCode(''); window.dispatchEvent(new Event('vayria-exhibition-next'));
    } catch { setMessage('登録結果を確認できませんでした。再読み込みして登録状態を確認してください。'); }
    finally { setPending(false); }
  };
  return <details className="public-exhibition-settings">
    <summary>展示の運営</summary>
    {exhibition && <>
      <p>{exhibition.revoked ? '端末登録は解除されています。' : exhibition.available ? '展示モード' : '展示枠は現在利用できません。'}</p>
      <p>期間：{new Date(exhibition.starts).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ～ {new Date(exhibition.expires).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}（日本時間）</p>
      <p>推計API使用額（予約分を含む）：{Math.ceil(exhibition.usedYen).toLocaleString('ja-JP')}円 ／ {exhibition.budgetYen.toLocaleString('ja-JP')}円</p>
      {exhibition.warning && <p role="status">展示予算の{exhibition.warning}％に達しました。上限に達すると生成を停止します。</p>}
      <p>参加者を交代しても使用額は戻りません。</p>
    </>}
    <form onSubmit={event => { event.preventDefault(); void enroll(); }}>
      <label>端末登録コード<input type="password" value={code} onChange={event => setCode(event.target.value)}
        autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32} required /></label>
      <button type="submit" disabled={pending || !code.trim()}>{pending ? '登録中…' : 'この端末を登録'}</button>
    </form>
    <p aria-live="polite">{message}</p>
  </details>;
}
