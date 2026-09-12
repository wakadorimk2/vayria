export type MicrophoneState = 'off' | 'starting' | 'stopping' | 'error' | 'recovering' | 'recognizing' | 'speaking' | 'listening';

export const microphoneStateLabels: Record<MicrophoneState, string> = {
  off: '', starting: '開始中', stopping: '停止中', error: 'マイクを確認',
  recognizing: '音声認識中', speaking: '聞き取り中', listening: '入力受付中',
  recovering: '音声入力を再開しています',
};

export function getPublicInteractionHint(state: MicrophoneState, selectionActive: boolean, cardHint: string): string {
  if (selectionActive) return '脳内へ一枚';
  if (state === 'error' || state === 'recovering') return cardHint;
  return microphoneStateLabels[state] || cardHint;
}

export function getMicrophoneState(input: {
  transition: 'starting' | 'stopping' | null;
  error: string | null;
  enabled: boolean;
  recognizing: boolean;
  speaking: boolean;
  recovering?: boolean;
}): MicrophoneState {
  if (input.transition) return input.transition;
  if (input.recovering && input.enabled) return 'recovering';
  if (input.error) return 'error';
  if (!input.enabled) return 'off';
  if (input.recognizing) return 'recognizing';
  if (input.speaking) return 'speaking';
  return 'listening';
}

export function normalizeMicrophoneLevel(level: number | null): number | null {
  return level === null || !Number.isFinite(level) ? null : Math.max(0, Math.min(1, level));
}
