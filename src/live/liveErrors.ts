/** Safe transport codes only. Never show provider bodies, SDP, or credentials. */
export class LiveConnectionError extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function readLiveResponse(response: Response): Promise<Record<string, unknown>> {
  if (response.ok) return await response.json();
  let code = `live_http_${response.status}`;
  try {
    const body = await response.json() as { code?: unknown };
    if (typeof body.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(body.code)) code = body.code;
  } catch { /* An HTML error page is not a user-facing diagnostic. */ }
  throw new LiveConnectionError(code);
}

export type LiveStartStage = 'microphone' | 'offer' | 'ice' | 'server' | 'answer';
export function liveStartFailure(error: unknown, stage: LiveStartStage): string {
  // WebKit DOMException objects need not inherit from this realm's Error.
  const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : '';
  const code = error instanceof LiveConnectionError ? error.code
    : stage === 'microphone' && ['NotAllowedError', 'SecurityError'].includes(name) ? 'microphone_permission_denied'
    : stage === 'microphone' && name === 'NotFoundError' ? 'microphone_not_found'
    : stage === 'microphone' && name === 'NotReadableError' ? 'microphone_unavailable'
    : stage === 'microphone' && name === 'OverconstrainedError' ? 'microphone_constraints_failed'
    : stage === 'microphone' && name === 'AbortError' ? 'microphone_aborted'
    : stage === 'microphone' && name === 'TypeError' ? 'microphone_api_failed'
    : stage === 'microphone' && name === 'InvalidStateError' ? 'microphone_state_failed'
    : stage === 'server' && ['TimeoutError', 'AbortError'].includes(name) ? 'live_request_timeout'
    : `live_${stage}_failed`;
  const messages: Record<string, string> = {
    microphone_permission_denied: 'マイクの使用が許可されていません。ブラウザのサイト設定でマイクを許可してから、もう一度マイクを押してください。',
    microphone_not_found: 'マイクが見つかりません。端末の音声入力を確認してください。',
    microphone_unavailable: 'マイクを開始できません。他の通話や録音を終了してから、もう一度お試しください。',
    microphone_constraints_failed: 'この端末でマイクの入力条件を設定できません。運営側で対応を確認します。',
    microphone_aborted: '端末がマイクの開始を中断しました。もう一度マイクを押してください。',
    microphone_api_failed: 'ブラウザのマイク取得処理を実行できません。運営側で対応を確認します。',
    microphone_state_failed: 'ブラウザの音声状態が録音に対応していません。ページを再読み込みしてお試しください。',
    live_ice_timeout: '音声接続のネットワーク準備が時間内に終わりませんでした。別の回線でお試しください。',
    live_request_timeout: 'サーバーの応答が時間内に届きませんでした。少し待ってからお試しください。',
    session_expired: '会話の利用時間が切れました。設定から会話を終了し、新しい会話を始めてください。',
    live_active: '前の音声接続を終了できていません。設定から会話を終了し、新しい会話を始めてください。',
    busy: '前の処理が終了するのを待っています。少し待ってから、もう一度マイクを押してください。',
    daily_budget: '本日の全体利用予算に達しました。',
    monthly_budget: '今月の全体利用予算に達しました。',
    preview_access_required: '検証環境の認証が切れました。ページを開き直して認証してください。',
    cookie_required: '会話の認証Cookieを確認できません。ページを開き直してください。',
    live_access_unavailable: 'サーバーのAPIキーでGPT-Liveを利用できません。運営側で設定を確認します。',
    live_control_failed: '音声の制御接続を開始できませんでした。運営側で接続を確認します。',
  };
  return `${messages[code] ?? 'GPT-Liveに接続できませんでした。下のエラーコードを運営へお知らせください。'}（${code}）`;
}
