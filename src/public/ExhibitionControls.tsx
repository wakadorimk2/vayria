import type { ExhibitionStatus } from './session';

export default function ExhibitionControls({ exhibition }: { exhibition: ExhibitionStatus | null | undefined }) {
  if (!exhibition) return null;
  return <section className="public-exhibition-settings" aria-label="展示の運営">
    <h3>展示の運営</h3>
    {exhibition && <>
      <p>{exhibition.revoked ? '端末登録は解除されています。' : exhibition.available ? '展示モード' : '展示枠は現在利用できません。'}</p>
      <p>期間：{new Date(exhibition.starts).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ～ {new Date(exhibition.expires).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}（日本時間）</p>
      <p>推計API使用額（予約分を含む）：{Math.ceil(exhibition.usedYen).toLocaleString('ja-JP')}円 ／ {exhibition.budgetYen.toLocaleString('ja-JP')}円</p>
      {exhibition.warning && <p role="status">展示予算の{exhibition.warning}％に達しました。上限に達すると生成を停止します。</p>}
      <p>参加者を交代しても使用額は戻りません。</p>
    </>}
  </section>;
}
