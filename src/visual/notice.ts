export function visualFailureMessage(code: string): string {
  if (code === 'video_play_rejected') return '端末が動画の自動再生を許可しませんでした。画像は残しています。';
  if (code === 'video_seek_timeout') return '動画の検査に時間がかかり、再生を止めました。';
  if (code === 'video_loading_timeout') return '動画の読み込みが時間切れになりました。';
  if (code === 'video_load_failed') return '動画を読み込めませんでした。画像は残しています。';
  if (code === 'video_frame_stalled') return '動画の動きを確認できませんでした。画像は残しています。';
  if (code === 'video_play_failed') return '動画を再生できませんでした。画像は残しています。';
  if (code === 'video_reduced_motion') return '動きを減らす設定のため、画像を表示しています。';
  if (code === 'video_disabled') return '動画生成は現在停止中です。';
  if (/budget|manifestation_limit/.test(code)) return '生成の利用上限に達しました。';
  if (/disabled|stopped|not_adopted|configuration/.test(code)) return 'この生成機能は現在休止しています。';
  if (/session|ticket|permission/.test(code)) return '生成の受付期限が切れました。';
  if (/timeout|expired/.test(code)) return '生成が待機時間を超えました。';
  if (code === 'provider_rejected') return '生成サービスが要求を受け付けませんでした。';
  if (/quality|alpha|png|decode|media/.test(code)) return '素材の表示検査を通過できませんでした。';
  if (code === 'placement_unavailable') return '小物を置ける空き領域がありませんでした。';
  if (code === 'decision_invalid') return '出すものの判断を確定できませんでした。';
  if (code === 'queue_replaced') return '待機上限のため、古い生成要求を取り消しました。';
  return '生成に接続できませんでした。';
}
