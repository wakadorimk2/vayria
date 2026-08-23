export const VOICE_INTERACTION_ACTIONS = [
  'listen',
  'backchannel',
  'react_nonverbally',
  'take_floor',
] as const;

export type VoiceInteractionAction =
  (typeof VOICE_INTERACTION_ACTIONS)[number];

export const VOICE_BACKCHANNEL_CUES = ['none', 'un', 'uun'] as const;

export type VoiceBackchannelCue = (typeof VOICE_BACKCHANNEL_CUES)[number];

export interface VoiceInteractionDecision {
  action: VoiceInteractionAction;
  backchannelCue: VoiceBackchannelCue;
}

export const LISTENING_THINKING_MOTION_ASSET_ID = 'listening-thinking';

export function isVoiceInteractionAction(
  value: unknown,
): value is VoiceInteractionAction {
  return (
    typeof value === 'string' &&
    (VOICE_INTERACTION_ACTIONS as readonly string[]).includes(value)
  );
}

export function isVoiceBackchannelCue(
  value: unknown,
): value is VoiceBackchannelCue {
  return (
    typeof value === 'string' &&
    (VOICE_BACKCHANNEL_CUES as readonly string[]).includes(value)
  );
}

export function isVoiceInteractionDecision(
  value: unknown,
): value is VoiceInteractionDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== 'action' && key !== 'backchannelCue',
    )
  ) {
    return false;
  }
  if (!isVoiceInteractionAction(record.action)) return false;
  if (!isVoiceBackchannelCue(record.backchannelCue)) return false;

  return (
    (record.action === 'backchannel' && record.backchannelCue !== 'none') ||
    (record.action !== 'backchannel' && record.backchannelCue === 'none')
  );
}
