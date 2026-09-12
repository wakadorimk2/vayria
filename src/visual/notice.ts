export function visualFailureMessage(code: string): string {
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
