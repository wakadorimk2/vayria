import type { VoiceInputNotice } from '../voice/voiceInput';

export function voiceInputNoticeMessage(notice: VoiceInputNotice): string {
  if (notice.state === 'recovering') return '音声入力を再開しています';
  if (notice.state === 'resumed') return 'もう一度どうぞ';
  if (notice.code === 'not-allowed') return 'マイクの許可が必要です。ブラウザーの設定を確認してください。';
  if (notice.code === 'audio-capture') return 'マイクを開始できませんでした。マイクを押して再試行できます。';
  if (notice.code === 'unsupported') return 'この環境では音声入力を使えません。文字やカードでどうぞ。';
  if (!Object.hasOwn(messages, notice.code)) return '音声入力を再開できませんでした。マイクを押して再試行できます。';
  const message = publicErrorMessage({ code: notice.code });
  const retryAt = notice.retryAt;
  if (typeof retryAt !== 'number' || !Number.isFinite(retryAt) || retryAt <= 0 || Number.isNaN(new Date(retryAt).getTime())) return message;
  return `${message} 再開: ${new Date(retryAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}（日本時間）`;
}

// Shared by the conversation response and the public controls.
const messages: Record<string, string> = {
  card_limit: 'この体験のカード返答回数に達しました。次の体験でお試しください。',
  user_limit: 'この体験の会話回数に達しました。次の体験でお試しください。',
  autonomous_limit: 'この体験の自発的な返答回数に達しました。',
  tts_limit: 'この体験の音声再生枠に達しました。',
  transcribe_limit: 'この体験の音声入力回数に達しました。文字やカードでお試しください。',
  audio_limit: '音声入力の長さの上限に達しました。文字やカードでお試しください。',
  daily_budget: '本日のサービス全体の利用枠に達しました。',
  monthly_budget: '今月のサービス全体の利用枠に達しました。',
  visitor_day_limit: '本日の体験回数に達しました。',
  visitor_month_limit: '今月の体験回数に達しました。',
  session_expired: '体験の時間が終了しました。カード交換・文字送信から再開できます。',
  session_required: 'カード交換・文字送信から体験を始めてください。',
  busy: 'ほかの処理を実行中か、混雑しています。少し待ってからお試しください。',
  ip_rate_limit: '接続の試行回数が多くなっています。少し待ってください。',
  generation_stopped: '現在は会話を休止しています。',
  network_error: '接続できませんでした。通信状態を確認して、もう一度お試しください。',
  provider_unavailable: '返答または音声の生成サービスに接続できませんでした。',
  generation_failed: '返答を生成できませんでした。もう一度お試しください。',
  service_unavailable: '現在サービスを利用できません。少し待ってからお試しください。',
  usage_unavailable: '利用状況を確認できませんでした。少し待ってください。',
  configuration_unavailable: '現在サービスの準備ができていません。',
  preview_access_required: '検証用アクセスチケットを入力し直してください。',
  cookie_required: '会話にはCookieを有効にしてください。',
  challenge_required: '利用確認を完了してください。',
  challenge_failed: '利用確認に失敗しました。もう一度お試しください。',
  invalid_ticket: '音声の有効期限が切れたか、再生できない状態です。',
  ticket_used: 'この音声はすでに再生処理を開始しています。',
};
export function publicErrorMessage(reason: unknown): string {
  const value = reason && typeof reason === 'object' ? reason as Record<string, unknown> : {};
  const message = typeof value.code === 'string' && Object.hasOwn(messages, value.code)
    ? messages[value.code] : '処理を完了できませんでした。少し待ってからお試しください。';
  const retryAt = value.retryAt;
  return message + (typeof retryAt === 'number' && retryAt > 0 && Number.isFinite(retryAt) &&
    !Number.isNaN(new Date(retryAt).getTime()) ? ' 再開可能: ' + new Date(retryAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + '（日本時間）' : '');
}
