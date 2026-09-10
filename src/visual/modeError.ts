const codes = new Set(['network_error','session_expired','session_required','cookie_required','unauthorized','preview_access_required','not_found','generation_stopped','visual_disabled','stale_permission','invalid_request']);
export class VisualModeError extends Error {
  readonly code:string;
  constructor(readonly status:number, code:unknown) { super('visual_mode_failed'); this.code=typeof code==='string'&&codes.has(code)?code:'unknown'; }
}
export function visualModeErrorMessage(error:unknown) {
  const e=error instanceof VisualModeError?error:new VisualModeError(0,'network_error');
  if(e.code==='preview_access_required')return '検証用アクセスの期限が切れました。ページを読み込み直してください。';
  if(['session_expired','session_required','cookie_required','unauthorized'].includes(e.code)||e.status===401||e.status===403)return '接続の有効期限が切れました。会話を開始し直してください。';
  if(['not_found','generation_stopped','visual_disabled'].includes(e.code)||e.status===404)return '生成モードは現在利用できません。';
  if(e.code==='stale_permission')return '生成モードの状態が変わりました。ページを読み込み直してください。';
  return '接続できませんでした。もう一度操作してください。';
}
