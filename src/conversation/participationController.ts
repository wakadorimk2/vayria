import {
  DEFAULT_CHARACTER_IDENTITY,
  resolveSelfName,
  type CharacterIdentity,
} from '../character/identity.js';
import type { InteractionTimeline } from './interactionTimeline.js';

export const PARTICIPATION_DECISIONS = ['SPEAK', 'SILENT'] as const;
export type ParticipationDecisionKind =
  (typeof PARTICIPATION_DECISIONS)[number];

export const PARTICIPATION_MODES = ['multi_party', 'dyadic_fallback'] as const;
export type ParticipationMode = (typeof PARTICIPATION_MODES)[number];

export const PARTICIPATION_CATEGORIES = [
  'explicit_address',
  'contextual_intervention',
  'group_address',
  'referenced_not_addressed',
  'no_reference',
  'overlap',
  'fallback',
] as const;
export type ParticipationCategory =
  (typeof PARTICIPATION_CATEGORIES)[number];

export const PARTICIPATION_REASONS = [
  'explicit_address',
  'contextual_intervention',
  'group_address_open_floor',
  'referenced_not_addressed',
  'no_reference',
  'human_exchange',
  'overlap_detected',
  'participants_unavailable',
  'participants_not_multi_party',
  'speaker_identity_unavailable',
] as const;
export type ParticipationReason = (typeof PARTICIPATION_REASONS)[number];

export type ParticipantRole = 'human' | 'vayria';

export interface Participant {
  id: string;
  role: ParticipantRole;
  displayName?: string;
}

export interface ConversationContext {
  participants: readonly Participant[];
}

export type FloorState =
  | { kind: 'held'; participantId: string }
  | { kind: 'open' }
  | { kind: 'contested' }
  | { kind: 'transitioning' }
  | { kind: 'unknown' };

export type OverlapState = 'none' | 'overlap' | 'unknown';

export interface ConversationUtterance {
  segmentId: string;
  speakerId: string | null;
  text: string;
  at: number;
}

export interface ParticipationDecision {
  decision: ParticipationDecisionKind;
  mode: ParticipationMode;
  category: ParticipationCategory;
  reason: ParticipationReason;
  confidence: number;
  speakerId: string | null;
  participantCount: number;
  currentSpeakerId: string | null;
  recentSpeakerIds: readonly (string | null)[];
  floorState: FloorState;
  overlapState: OverlapState;
  addressivity: Readonly<Record<string, number>>;
  transcriptLength: number;
}

export interface ConversationState {
  context: ConversationContext | null;
  currentSpeakerId: string | null;
  recentSpeakerIds: readonly (string | null)[];
  floorState: FloorState;
  overlapState: OverlapState;
  recentUtterances: readonly ConversationUtterance[];
  addressivity: Readonly<Record<string, number>>;
  lastDecision: ParticipationDecision | null;
}

export interface ParticipationSpeechSignal {
  speakerId?: string | null;
  at?: number;
  overlapState?: OverlapState;
}

export interface ParticipationUtteranceInput {
  segmentId: string;
  text: string;
  speakerId?: string | null;
  at?: number;
  overlapState?: OverlapState;
}

export interface ParticipationControllerOptions {
  context?: ConversationContext | null;
  characterIdentity?: CharacterIdentity;
  timeline?: InteractionTimeline;
}

export const MAX_PARTICIPATION_UTTERANCES = 8;
export const MAX_PARTICIPATION_SPEAKER_IDS = 8;
export const MAX_PARTICIPATION_TEXT_LENGTH = 1_000;

const DIRECT_CONTEXTUAL_INTERVENTION_PATTERNS = [
  /(?:AI|ＡＩ)(?:側)?(?:の)?(?:意見|考え|見解|感想|立場)/iu,
  /(?:AI|ＡＩ)(?:側)?(?:は|が)?\s*どう思う/iu,
  /(?:AI|ＡＩ|人工知能)(?:に|へ)聞(?:こう|いて|きたい)/u,
] as const;

const GROUP_ADDRESS_PATTERN =
  /^(?:みんな|皆さん|みなさん|全員)(?:は|が|の)?(?:どう思う|どうする|意見|考え)/u;
const ADDRESS_BOUNDARY_PATTERN =
  /[\s、,，。．.!！?？…:：;；「」『』"“”]/gu;
const ADDRESS_HONORIFIC_PATTERN = /(?:さん|ちゃん)/gu;

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim();
}

function normalizeSpeakerId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeText(value);
  return normalized || null;
}

function normalizeTimestamp(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : Date.now();
}

function cloneFloorState(state: FloorState): FloorState {
  return { ...state };
}

function cloneParticipant(participant: Participant): Participant {
  return {
    id: participant.id,
    role: participant.role,
    ...(participant.displayName ? { displayName: participant.displayName } : {}),
  };
}

function normalizeContext(
  context: ConversationContext | null | undefined,
): ConversationContext | null {
  if (!context || !Array.isArray(context.participants)) return null;

  const seen = new Set<string>();
  const participants: Participant[] = [];
  for (const participant of context.participants) {
    if (!participant || typeof participant.id !== 'string') continue;
    if (participant.role !== 'human' && participant.role !== 'vayria') continue;
    const id = normalizeText(participant.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName =
      typeof participant.displayName === 'string'
        ? normalizeText(participant.displayName)
        : '';
    participants.push({
      id,
      role: participant.role,
      ...(displayName ? { displayName } : {}),
    });
  }

  return { participants };
}

function cloneContext(
  context: ConversationContext | null,
): ConversationContext | null {
  if (!context) return null;
  return { participants: context.participants.map(cloneParticipant) };
}

function contextsEqual(
  left: ConversationContext | null,
  right: ConversationContext | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.participants.length !== right.participants.length) {
    return false;
  }
  return left.participants.every((participant, index) => {
    const other = right.participants[index];
    return (
      other?.id === participant.id &&
      other.role === participant.role &&
      other.displayName === participant.displayName
    );
  });
}

function createAddressivity(
  context: ConversationContext | null,
  target: 'none' | 'vayria' | 'group',
  score: number,
): Readonly<Record<string, number>> {
  const addressivity: Record<string, number> = {};
  for (const participant of context?.participants ?? []) {
    addressivity[participant.id] = target === 'group' ? score : 0;
  }

  if (target === 'vayria') {
    const vayria = context?.participants.find(
      (participant) => participant.role === 'vayria',
    );
    if (vayria) addressivity[vayria.id] = score;
  }

  return addressivity;
}

function cloneAddressivity(
  addressivity: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  return { ...addressivity };
}

function cloneUtterance(utterance: ConversationUtterance): ConversationUtterance {
  return { ...utterance };
}

function cloneDecision(decision: ParticipationDecision): ParticipationDecision {
  return {
    ...decision,
    recentSpeakerIds: [...decision.recentSpeakerIds],
    floorState: cloneFloorState(decision.floorState),
    addressivity: cloneAddressivity(decision.addressivity),
  };
}

function createInitialState(
  context: ConversationContext | null,
): ConversationState {
  return {
    context: cloneContext(context),
    currentSpeakerId: null,
    recentSpeakerIds: [],
    floorState: { kind: 'unknown' },
    overlapState: 'unknown',
    recentUtterances: [],
    addressivity: createAddressivity(context, 'none', 0),
    lastDecision: null,
  };
}

function isMultiPartyContext(context: ConversationContext | null): boolean {
  if (!context) return false;
  const humanCount = context.participants.filter(
    (participant) => participant.role === 'human',
  ).length;
  return (
    humanCount >= 2 &&
    context.participants.some((participant) => participant.role === 'vayria')
  );
}

function isKnownHumanSpeaker(
  context: ConversationContext | null,
  speakerId: string | null,
): boolean {
  return Boolean(
    speakerId &&
      context?.participants.some(
        (participant) => participant.id === speakerId && participant.role === 'human',
      ),
  );
}

function isContextualIntervention(text: string): boolean {
  return DIRECT_CONTEXTUAL_INTERVENTION_PATTERNS.some((pattern) =>
    pattern.test(text),
  );
}

function isGroupAddress(text: string): boolean {
  return GROUP_ADDRESS_PATTERN.test(text);
}

function hasAddressContent(
  text: string,
  matchedText: string | null,
): boolean {
  if (!matchedText) return false;
  const remaining = text
    .replace(matchedText, '')
    .replace(ADDRESS_HONORIFIC_PATTERN, '')
    .replace(ADDRESS_BOUNDARY_PATTERN, '')
    .trim();
  return remaining.length > 0;
}

interface TextClassification {
  category: Exclude<ParticipationCategory, 'overlap' | 'fallback'>;
  reason: ParticipationReason;
  confidence: number;
  addressivity: Readonly<Record<string, number>>;
}

function classifyText(
  text: string,
  context: ConversationContext | null,
  identity: CharacterIdentity,
): TextClassification {
  const selfNameResolution = resolveSelfName(text, identity);
  if (
    selfNameResolution.role === 'direct_address' &&
    hasAddressContent(text, selfNameResolution.matchedText)
  ) {
    return {
      category: 'explicit_address',
      reason: 'explicit_address',
      confidence: 1,
      addressivity: createAddressivity(context, 'vayria', 1),
    };
  }

  if (selfNameResolution.role === 'direct_address') {
    return {
      category: 'referenced_not_addressed',
      reason: 'referenced_not_addressed',
      confidence: 0.9,
      addressivity: createAddressivity(context, 'vayria', 0.6),
    };
  }

  if (isGroupAddress(text)) {
    return {
      category: 'group_address',
      reason: 'group_address_open_floor',
      confidence: 0.55,
      addressivity: createAddressivity(context, 'group', 0.8),
    };
  }

  if (isContextualIntervention(text)) {
    return {
      category: 'contextual_intervention',
      reason: 'contextual_intervention',
      confidence: 0.85,
      addressivity: createAddressivity(context, 'vayria', 0.85),
    };
  }

  if (selfNameResolution.role === 'self_reference') {
    return {
      category: 'referenced_not_addressed',
      reason: 'referenced_not_addressed',
      confidence: 0.9,
      addressivity: createAddressivity(context, 'vayria', 0.6),
    };
  }

  return {
    category: 'no_reference',
    reason: 'no_reference',
    confidence: 0.65,
    addressivity: createAddressivity(context, 'none', 0),
  };
}

export class ParticipationController {
  private context: ConversationContext | null;
  private characterIdentity: CharacterIdentity;
  private readonly timeline?: InteractionTimeline;
  private state: ConversationState;
  private readonly activeSpeakerCounts = new Map<string, number>();
  private activeUnknownSpeakerCount = 0;
  private overlapDetectedForUtterance = false;

  constructor(options: ParticipationControllerOptions = {}) {
    this.context = normalizeContext(options.context);
    this.characterIdentity =
      options.characterIdentity ?? DEFAULT_CHARACTER_IDENTITY;
    this.timeline = options.timeline;
    this.state = createInitialState(this.context);
  }

  setContext(context: ConversationContext | null | undefined): void {
    const normalized = normalizeContext(context);
    if (contextsEqual(this.context, normalized)) return;
    this.context = normalized;
    this.resetState();
  }

  setCharacterIdentity(identity: CharacterIdentity): void {
    this.characterIdentity = identity;
  }

  getState(): ConversationState {
    return {
      ...this.state,
      context: cloneContext(this.state.context),
      recentSpeakerIds: [...this.state.recentSpeakerIds],
      floorState: cloneFloorState(this.state.floorState),
      recentUtterances: this.state.recentUtterances.map(cloneUtterance),
      addressivity: cloneAddressivity(this.state.addressivity),
      lastDecision: this.state.lastDecision
        ? cloneDecision(this.state.lastDecision)
        : null,
    };
  }

  observeSpeechStarted(signal: ParticipationSpeechSignal): void {
    const speakerId = normalizeSpeakerId(signal.speakerId);
    const activeBefore = this.getActiveSpeakerCount();
    if (speakerId) {
      this.activeSpeakerCounts.set(
        speakerId,
        (this.activeSpeakerCounts.get(speakerId) ?? 0) + 1,
      );
    } else {
      this.activeUnknownSpeakerCount += 1;
    }

    if (activeBefore > 0 || signal.overlapState === 'overlap') {
      this.overlapDetectedForUtterance = true;
    }

    this.updateActiveFloor(speakerId, signal.overlapState);
    this.state = {
      ...this.state,
      currentSpeakerId: speakerId,
    };
  }

  observeSpeechEnded(signal: ParticipationSpeechSignal): void {
    const speakerId = normalizeSpeakerId(signal.speakerId);
    if (speakerId) {
      const count = this.activeSpeakerCounts.get(speakerId) ?? 0;
      if (count <= 1) {
        this.activeSpeakerCounts.delete(speakerId);
      } else {
        this.activeSpeakerCounts.set(speakerId, count - 1);
      }
    } else if (this.activeUnknownSpeakerCount > 0) {
      this.activeUnknownSpeakerCount -= 1;
    }

    if (signal.overlapState === 'overlap') {
      this.overlapDetectedForUtterance = true;
    }

    this.updateActiveFloor(speakerId, signal.overlapState);
  }

  evaluateFinalized(
    input: ParticipationUtteranceInput,
    characterIdentity = this.characterIdentity,
  ): ParticipationDecision {
    const at = normalizeTimestamp(input.at);
    const text = normalizeText(input.text).slice(
      0,
      MAX_PARTICIPATION_TEXT_LENGTH,
    );
    const speakerId = normalizeSpeakerId(input.speakerId);
    const classification = classifyText(text, this.context, characterIdentity);
    const overlapState = this.readDecisionOverlapState(
      input.overlapState,
      speakerId,
    );
    const floorState =
      overlapState === 'overlap'
        ? ({ kind: 'contested' } as const)
        : this.readDecisionFloorState(speakerId);
    const multiParty = isMultiPartyContext(this.context);
    const knownHumanSpeaker = isKnownHumanSpeaker(this.context, speakerId);

    let decision: ParticipationDecisionKind = 'SILENT';
    let mode: ParticipationMode = 'multi_party';
    let category: ParticipationCategory = classification.category;
    let reason = classification.reason;
    let confidence = classification.confidence;

    if (!multiParty) {
      decision = 'SPEAK';
      mode = 'dyadic_fallback';
      category = 'fallback';
      reason = !speakerId
        ? 'speaker_identity_unavailable'
        : this.context
          ? this.context.participants.filter(
                (participant) => participant.role === 'human',
              ).length < 2
            ? 'participants_not_multi_party'
            : 'participants_unavailable'
          : 'participants_unavailable';
      confidence = 0;
    } else if (!knownHumanSpeaker) {
      decision = 'SPEAK';
      mode = 'dyadic_fallback';
      category = 'fallback';
      reason = 'speaker_identity_unavailable';
      confidence = 0;
    } else if (overlapState === 'overlap') {
      decision = 'SILENT';
      category = 'overlap';
      reason = 'overlap_detected';
      confidence = 0.95;
    } else if (classification.category === 'explicit_address') {
      decision = 'SPEAK';
    } else if (classification.category === 'contextual_intervention') {
      decision = 'SPEAK';
    }

    const recentHumanIds = new Set(
      this.state.recentUtterances
        .map((utterance) => utterance.speakerId)
        .filter(
          (id): id is string => isKnownHumanSpeaker(this.context, id),
        ),
    );
    if (
      category === 'no_reference' &&
      speakerId &&
      recentHumanIds.size > 0
    ) {
      recentHumanIds.add(speakerId);
      if (recentHumanIds.size >= 2) reason = 'human_exchange';
    }

    const recentSpeakerIds = [
      ...this.state.recentSpeakerIds,
      speakerId,
    ].slice(-MAX_PARTICIPATION_SPEAKER_IDS);
    const recentUtterances = [
      ...this.state.recentUtterances,
      { segmentId: input.segmentId, speakerId, text, at },
    ].slice(-MAX_PARTICIPATION_UTTERANCES);
    const participantCount = this.context?.participants.length ?? 0;
    const finalDecision: ParticipationDecision = {
      decision,
      mode,
      category,
      reason,
      confidence,
      speakerId,
      participantCount,
      currentSpeakerId: speakerId,
      recentSpeakerIds,
      floorState,
      overlapState,
      addressivity:
        mode === 'dyadic_fallback'
          ? createAddressivity(this.context, 'none', 0)
          : classification.addressivity,
      transcriptLength: text.length,
    };

    this.state = {
      ...this.state,
      currentSpeakerId: speakerId,
      recentSpeakerIds,
      floorState: speakerId ? { kind: 'open' } : { kind: 'unknown' },
      overlapState: 'none',
      recentUtterances,
      addressivity: finalDecision.addressivity,
      lastDecision: finalDecision,
    };
    this.overlapDetectedForUtterance = false;

    this.timeline?.record({
      kind: 'participation_decision',
      at,
      currentSpeakerId: finalDecision.currentSpeakerId,
      recentSpeakerIds: [...finalDecision.recentSpeakerIds],
      participantCount: finalDecision.participantCount,
      floorState: cloneFloorState(finalDecision.floorState),
      overlapState: finalDecision.overlapState,
      addressivity: cloneAddressivity(finalDecision.addressivity),
      decision: finalDecision.decision,
      mode: finalDecision.mode,
      category: finalDecision.category,
      reason: finalDecision.reason,
      confidence: finalDecision.confidence,
      transcriptLength: finalDecision.transcriptLength,
    });

    return cloneDecision(finalDecision);
  }

  reset(): void {
    this.resetState();
  }

  private resetState(): void {
    this.activeSpeakerCounts.clear();
    this.activeUnknownSpeakerCount = 0;
    this.overlapDetectedForUtterance = false;
    this.state = createInitialState(this.context);
  }

  private getActiveSpeakerCount(): number {
    let count = this.activeUnknownSpeakerCount;
    for (const speakerCount of this.activeSpeakerCounts.values()) {
      count += speakerCount;
    }
    return count;
  }

  private updateActiveFloor(
    latestSpeakerId: string | null,
    overlapState: OverlapState | undefined,
  ): void {
    const activeCount = this.getActiveSpeakerCount();
    const hasOverlap =
      activeCount > 1 ||
      overlapState === 'overlap' ||
      this.overlapDetectedForUtterance;
    if (hasOverlap) {
      this.state = {
        ...this.state,
        floorState: { kind: 'contested' },
        overlapState: 'overlap',
      };
      return;
    }
    if (activeCount === 0) {
      this.state = {
        ...this.state,
        floorState: { kind: 'transitioning' },
        overlapState: 'none',
      };
      return;
    }
    this.state = {
      ...this.state,
      floorState: latestSpeakerId
        ? { kind: 'held', participantId: latestSpeakerId }
        : { kind: 'unknown' },
      overlapState: latestSpeakerId ? 'none' : 'unknown',
    };
  }

  private readDecisionOverlapState(
    inputOverlapState: OverlapState | undefined,
    speakerId: string | null,
  ): OverlapState {
    if (
      inputOverlapState === 'overlap' ||
      this.overlapDetectedForUtterance ||
      this.state.overlapState === 'overlap' ||
      this.state.floorState.kind === 'contested'
    ) {
      return 'overlap';
    }
    return speakerId ? 'none' : 'unknown';
  }

  private readDecisionFloorState(speakerId: string | null): FloorState {
    if (this.state.floorState.kind === 'contested') {
      return { kind: 'contested' };
    }
    if (this.getActiveSpeakerCount() > 0) {
      return speakerId
        ? { kind: 'held', participantId: speakerId }
        : { kind: 'unknown' };
    }
    return speakerId ? { kind: 'open' } : { kind: 'unknown' };
  }
}

export function createParticipationController(
  options: ParticipationControllerOptions = {},
): ParticipationController {
  return new ParticipationController(options);
}
