import {
  DEFAULT_CHARACTER_IDENTITY,
  resolveSelfName,
  type CharacterIdentity,
} from '../character/identity.js';
import {
  isActionCommitmentMessage,
  isDefiniteConversationClosingMessage,
  isDefiniteBackchannelMessage,
  isDefiniteNonverbalAcknowledgementMessage,
  isDefiniteParticipationMessage,
  isDefiniteQuestionMessage,
  isDefiniteUnfinishedMessage,
  isDirectActionRequestMessage,
} from '../performer/runtime.js';

export const VIEWER_INTENTS = [
  'direct_address',
  'call',
  'question',
  'request',
  'action_commitment',
  'closing',
  'unfinished',
  'backchannel',
  'statement',
] as const;

export type ViewerIntent = (typeof VIEWER_INTENTS)[number];

export const VIEWER_ENGAGEMENTS = ['available', 'settled'] as const;

export type ViewerEngagement = (typeof VIEWER_ENGAGEMENTS)[number];

export interface AutonomousContext {
  topic: string | null;
  topicTurns: number;
  viewerIntent: ViewerIntent | null;
  viewerTurnsSince: number;
  viewerEngagement: ViewerEngagement;
}

export const MAX_VIEWER_TURNS_SINCE = 100;

export const INITIAL_AUTONOMOUS_CONTEXT: AutonomousContext = {
  topic: null,
  topicTurns: 0,
  viewerIntent: null,
  viewerTurnsSince: 0,
  viewerEngagement: 'available',
};

export function isViewerIntent(value: unknown): value is ViewerIntent {
  return (
    typeof value === 'string' &&
    (VIEWER_INTENTS as readonly string[]).includes(value)
  );
}

export function isViewerEngagement(value: unknown): value is ViewerEngagement {
  return (
    typeof value === 'string' &&
    (VIEWER_ENGAGEMENTS as readonly string[]).includes(value)
  );
}

export function classifyViewerIntent(
  message: string,
  identity: CharacterIdentity = DEFAULT_CHARACTER_IDENTITY,
): ViewerIntent {
  if (isDefiniteConversationClosingMessage(message)) {
    return 'closing';
  }
  if (resolveSelfName(message, identity).role === 'direct_address') {
    return 'direct_address';
  }
  if (isDefiniteParticipationMessage(message)) return 'call';
  if (isDefiniteQuestionMessage(message)) return 'question';
  if (isDirectActionRequestMessage(message)) return 'request';
  if (isDefiniteUnfinishedMessage(message)) return 'unfinished';
  if (isActionCommitmentMessage(message)) return 'action_commitment';
  if (
    isDefiniteBackchannelMessage(message) ||
    isDefiniteNonverbalAcknowledgementMessage(message)
  ) {
    return 'backchannel';
  }
  return 'statement';
}

export function recordViewerIntent(
  current: AutonomousContext,
  message: string,
  identity: CharacterIdentity = DEFAULT_CHARACTER_IDENTITY,
): AutonomousContext {
  const viewerIntent = classifyViewerIntent(message, identity);
  const keepsSettledState =
    current.viewerEngagement === 'settled' &&
    (viewerIntent === 'backchannel' || viewerIntent === 'unfinished');
  return {
    ...current,
    viewerIntent,
    viewerTurnsSince: 0,
    viewerEngagement:
      viewerIntent === 'closing' || keepsSettledState
        ? 'settled'
        : 'available',
  };
}

export function advanceAutonomousContext(
  current: AutonomousContext,
  decision: {
    action: 'continue' | 'new_topic' | 'silence';
    topic: string;
  },
): AutonomousContext {
  if (decision.action === 'silence') return current;

  return {
    ...current,
    topic: decision.topic,
    topicTurns:
      decision.action === 'new_topic' || current.topic === null
        ? 1
        : current.topicTurns + 1,
    viewerTurnsSince:
      current.viewerIntent === null
        ? 0
        : Math.min(current.viewerTurnsSince + 1, MAX_VIEWER_TURNS_SINCE),
  };
}
