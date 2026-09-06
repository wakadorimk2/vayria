export const EXHIBITION_UI_MODES = ['baseline', 'candidate'] as const;

export type ExhibitionUiMode = (typeof EXHIBITION_UI_MODES)[number];

export type ExhibitionUiPhase =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'permission'
  | 'error';

export interface ExhibitionUiPhaseInput {
  conversationStatus:
    | 'idle'
    | 'thinking'
    | 'synthesizing'
    | 'speaking'
    | 'error';
  hasError: boolean;
  needsPlaybackGesture: boolean;
  voiceInputEnabled: boolean;
  voiceInputPhase:
    | 'idle'
    | 'listening'
    | 'speech_detected'
    | 'utterance_finalized'
    | 'error';
}

export interface ExhibitionUiPhasePresentation {
  label: string;
  mark: string;
}

const PHASE_PRESENTATIONS: Record<
  ExhibitionUiPhase,
  ExhibitionUiPhasePresentation
> = {
  idle: { label: 'あなたの番です', mark: '◇' },
  listening: { label: '聞いています', mark: '◎' },
  thinking: { label: '考えています', mark: '…' },
  synthesizing: { label: '声を準備しています', mark: '♪' },
  speaking: { label: '話しています', mark: '◆' },
  permission: { label: '音声の再生許可が必要です', mark: '!' },
  error: { label: '会話を続けられませんでした', mark: '!' },
};

function isExhibitionUiMode(value: unknown): value is ExhibitionUiMode {
  return (
    typeof value === 'string' &&
    (EXHIBITION_UI_MODES as readonly string[]).includes(value)
  );
}

export function resolveExhibitionUiMode(
  search: string,
  environmentValue: unknown,
): ExhibitionUiMode {
  const queryValue = new URLSearchParams(search).get('exhibitionUi');
  if (isExhibitionUiMode(queryValue)) return queryValue;
  if (isExhibitionUiMode(environmentValue)) return environmentValue;
  return 'candidate';
}

export function resolveExhibitionUiPhase(
  input: ExhibitionUiPhaseInput,
): ExhibitionUiPhase {
  if (input.needsPlaybackGesture) return 'permission';
  if (
    input.hasError ||
    input.conversationStatus === 'error' ||
    input.voiceInputPhase === 'error'
  ) {
    return 'error';
  }
  if (input.conversationStatus === 'speaking') return 'speaking';
  if (input.conversationStatus === 'synthesizing') return 'synthesizing';
  if (
    input.conversationStatus === 'thinking' ||
    input.voiceInputPhase === 'utterance_finalized'
  ) {
    return 'thinking';
  }
  if (
    input.voiceInputEnabled &&
    (input.voiceInputPhase === 'listening' ||
      input.voiceInputPhase === 'speech_detected')
  ) {
    return 'listening';
  }
  return 'idle';
}

export function getExhibitionUiPhasePresentation(
  phase: ExhibitionUiPhase,
): ExhibitionUiPhasePresentation {
  return PHASE_PRESENTATIONS[phase];
}
