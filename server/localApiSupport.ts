import type { CardContinuation } from '../src/conversation/cardContinuation.js';
import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cardPool } from '../src/cards/cardPool.js';
import type { WildcardCardData } from '../src/cards/cardTypes.js';
import {
  VOICE_STYLE_BY_EMOTION,
  type AssistantResponse,
  type Emotion
} from '../src/character/emotion.js';
import {
  DEFAULT_CHARACTER_IDENTITY,
  resolveSelfName,
  type CharacterIdentity
} from '../src/character/identity.js';
import {
  type ViewerEngagement,
  type ViewerIntent
} from '../src/conversation/autonomousContext.js';
import {
  MAX_CANDIDATE_REASONS,
  type AutonomyCandidate,
  type AutonomyExternalAction,
  type AutonomyInternalDelta
} from '../src/conversation/autonomyState.js';
import {
  type AutonomyTurnGateTelemetry
} from '../src/conversation/autonomyTurnGate.js';
import {
  type ProgramContext
} from '../src/conversation/programContext.js';
import {
  type ExpressionLevel,
  type SpeechAct
} from '../src/conversation/utterancePlan.js';
import type {
  NetworkAvailability,
  VayriaAppMode,
  VayriaHealthResponse,
} from '../src/networkState.js';
import {
  classifyViewerMessageFastPath,
  isActionCommitmentMessage,
  isContentBearingVoiceMessage,
  isDefiniteQuestionMessage,
  isDirectActionRequestMessage
} from '../src/performer/runtime.js';
import {
  type ConversationAction,
  type ConversationActionDecision,
  type ConversationBackchannelCue,
  type PerformerStateContext,
  type WeightedSemanticCue
} from '../src/performer/types.js';
import { isPlaycheckRunId } from '../src/playcheck.js';
import {
  type VoiceInteractionAction,
  type VoiceInteractionDecision
} from '../src/voice/voiceInteraction.js';
import {
  type ExhibitionCaptureWriter
} from './exhibitionCaptureStore.js';
import type { ExhibitionNetworkRuntime } from './exhibitionNetwork.js';
import type { InternetConnectivityProbe } from './internetConnectivity.js';
import {
  type LlmProviderPurpose,
  type LlmProviderSource
} from './llmProviderTelemetry.js';
import {
  type LlmRuntimeOptions
} from './llmRuntime.js';
import { OpenAiResponsesError } from './openAiResponses.js';
import { parseStreamingSpeechEnvelope } from './streamingSpeech.js';
import {
  type AivisCloudSynthesisResult
} from './tts/aivisCloud.js';


export const MAX_REQUEST_BYTES = 16 * 1024;

export const MAX_TEXT_LENGTH = 1_000;

export const MAX_HISTORY_ITEMS = 10;

export const CHAT_PATH = '/api/chat';

export const CARD_PREVIEW_PATH = '/api/card-preview';

export const TTS_PATH = '/api/tts';

export const HEALTH_PATH = '/api/health';

export const EVENTS_PATH = '/api/events';

export const VOICE_LAB_EVENTS_PATH = '/api/voice-lab/events';

export const ROUTER_EVENTS_PATH = '/api/router/events';

export const DEFAULT_AIVIS_BASE_URL = 'http://127.0.0.1:10101';

export const AIVIS_CONNECTION_ERROR =
  'AivisSpeech Engine に接続できません。AivisSpeech を起動しているか確認してください。';

export const NORMAL_VOICE_STYLE_NAME = VOICE_STYLE_BY_EMOTION.neutral;

export const BRAIN_CARD_COUNT = 5;

export const MAX_ACTIVATED_CARDS = 2;

export const MAX_TOPIC_LENGTH = 120;

export const MAX_TOPIC_TURNS = 100;

export const MAX_VIEWER_TURNS_SINCE = 100;

export const MAX_EVENT_TURN_ID_LENGTH = 128;

export const MAX_EVENT_REASON_LENGTH = 120;

export const MAX_EVENT_ID_LIST_LENGTH = 16;

export const SAFE_EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/u;

export const AUTONOMY_DELTA_OPERATIONS = [
  'create',
  'reinforce',
  'resolve',
  'expire',
  'defer',
  'reactivate',
  'merge',
] as const;

export const AUTONOMY_REASON_UPDATE_FIELDS = new Set([
  'operation',
  'kind',
  'content',
  'semanticKey',
  'salience',
  'reasonId',
  'parentReasonId',
  'salienceDelta',
  'cause',
  'wakeOn',
  'targetReasonId',
]);

export const INTERACTIVE_POLICY_ACTIONS = [
  'listen',
  'backchannel',
  'take_floor',
  'react_nonverbally',
  'silence',
] as const;

export const CONVERSATION_EVENTS = [
  'input_received',
  'llm_start',
  'llm_provider_start',
  'llm_provider_first_chunk',
  'llm_provider_done',
  'llm_fallback',
  'llm_done',
  'speech_unit_ready',
  'internal_delta_rejected',
  'tts_start',
  'tts_unit_start',
  'tts_unit_audio_ready',
  'tts_unit_playback_started',
  'tts_unit_playback_completed',
  'tts_queue_gap',
  'tts_fallback_started',
  'tts_fallback_completed',
  'tts_first_audio',
  'tts_ready',
  'playback_startup',
  'playback_started',
  'playback_gesture_required',
  'tts_completed',
  'motion_ready',
  'motion_start',
  'animation_start',
  'turn_completed',
  'turn_aborted',
  'turn_failed',
  'autonomy_gate',
] as const;

export const PLAYBACK_GESTURE_REASONS = [
  'not_allowed',
  'start_timeout',
] as const;

export const CARD_BY_ID: ReadonlyMap<string, WildcardCardData> = new Map(
  cardPool.map((card) => [card.id, card]),
);

export const ALL_CARD_IDS = cardPool.map((card) => card.id);

export const providerRequestCounts = { active: 0 };

export interface LocalApiConfig {
  manifestationBudgetLimitUsd?: number;
  manifestationEnabled?: boolean;
  visualVideoEnabled?: boolean;
  manifestationBenchmarkEnabled?: boolean;
  manifestationRunwareEnabled?: boolean;
  manifestation?: import('./manifestationProvider.js').ManifestationConfig;
  worldMutationEnabled?: boolean;
  openAiApiKey?: string;
  aivisBaseUrl?: string;
  aivisSpeedScale?: string;
  aivisPitchScale?: string;
  aivisIntonationScale?: string;
  aivisTempoDynamicsScale?: string;
  ttsBackend?: string;
  aivisCloudApiKey?: string;
  aivisCloudBaseUrl?: string;
  aivisCloudFirstAudioTimeoutMs?: number;
  aivisCloudModelUuid?: string;
  aivisCloudTimeoutMs?: number;
  playcheckRoot?: string;
  exhibitionCaptureEnabled?: boolean;
  exhibitionCapture?: ExhibitionCaptureWriter;
  mode?: VayriaAppMode;
  port?: number;
  httpsEnabled?: boolean;
  exhibitionNetwork?: ExhibitionNetworkRuntime;
  internetConnectivity?: InternetConnectivityProbe;
  aivisSpeakerCatalog?: AivisSpeakerCatalogCache;
  llmRuntime?: LlmRuntimeOptions;
}

export interface LlmRequestContext {
  sharedWorldEnabled?: boolean;
  manifestationEnabled?: boolean;
  visualVideoEnabled?: boolean;
  apiKey: string;
  runtime: LlmRuntimeOptions;
  signal: AbortSignal;
  onFallback: (reason: string) => void;
  warmup: boolean;
}

export const DEFAULT_LLM_RUNTIME: LlmRuntimeOptions = {
  profile: 'nano-implicit',
  serviceTier: 'standard',
  fallbackEnabled: false,
  cacheWarmupEnabled: false,
};

export function createHealthResponse(
  config: LocalApiConfig,
  internet: NetworkAvailability,
): VayriaHealthResponse {
  const mode = config.mode ?? 'local';
  const response: VayriaHealthResponse = {
    ok: true,
    service: 'vayria',
    mode,
    network: {
      localNetwork: 'available',
      internet,
    },
  };

  if (mode === 'exhibition' && config.exhibitionNetwork) {
    response.access = config.exhibitionNetwork.getAccess(
      config.port,
      config.httpsEnabled,
    );
  }

  return response;
}

export interface AivisTtsSettings {
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  tempoDynamicsScale: number;
}

export type TtsBackend =
  | 'aivis-cloud'
  | 'cloud-with-fallback'
  | 'local';

export interface AivisStyle {
  id: number;
  name: string;
}

export type ChatMode = 'manual' | 'voice' | 'autonomous';

export type ChatRetryCause = 'output_limit' | 'contract' | null;
export const CHAT_MAX_OUTPUT_TOKENS: Record<ChatMode, number> = {
  manual: 2_048,
  voice: 2_048,
  autonomous: 2_048,
};

export function maxOutputTokensForChatMode(
  mode: ChatMode,
  retryCause: ChatRetryCause = null,
): number {
  if (mode === 'voice' && retryCause === 'output_limit') return 4_096;
  return CHAT_MAX_OUTPUT_TOKENS[mode];
}

export function runtimeForReplyAttempt(
  runtime: LlmRuntimeOptions,
  source: LlmProviderSource,
  retryCause: ChatRetryCause = null,
): LlmRuntimeOptions {
  return runtime.profile === 'nano-implicit' &&
    retryCause === 'output_limit' &&
    (source === 'voice' || source === 'card_change')
    ? { ...runtime, profile: 'luna-prefix' }
    : runtime;
}

export function isRetryableIncompleteResponseError(error: unknown): boolean {
  return (
    error instanceof OpenAiResponsesError &&
    error.kind === 'incomplete' &&
    (error.incompleteReason === 'max_output_tokens' ||
      error.incompleteReason === 'max_tokens')
  );
}

export function classifyTerminalStreamingEnvelope(
  value: string,
): 'terminal_envelope_parseable' | 'terminal_envelope_unparseable' {
  try {
    parseStreamingSpeechEnvelope(value);
    return 'terminal_envelope_parseable';
  } catch {
    return 'terminal_envelope_unparseable';
  }
}

export function buildUsedReasonIdsProperty(
  reasonIds: readonly string[],
): Record<string, unknown> {
  return {
    type: 'array',
    items: {
      type: 'string',
      enum: [...reasonIds],
    },
    maxItems: Math.min(reasonIds.length, MAX_CANDIDATE_REASONS),
  };
}

export type ConversationEventSource = ChatMode;

export type ConversationEventName = (typeof CONVERSATION_EVENTS)[number];

export interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface PerformanceContextPayload {
  callbackTendency: number;
  fragmentation: number;
  semanticBiases: WeightedSemanticCue[];
}

export interface ChatRequestPayload {
  greeting?: true;
  cardContinuation?: CardContinuation;
  mode: ChatMode;
  message: string | null;
  characterIdentity: CharacterIdentity;
  history: ChatHistoryItem[];
  brainCardIds: string[];
  forcedCardId: string | null;
  topic: string | null;
  topicTurns: number;
  viewerIntent: ViewerIntent | null;
  viewerTurnsSince: number;
  viewerEngagement: ViewerEngagement;
  programContext: ProgramContext;
  performerState: PerformerStateContext | null;
  lastSelfUtterance: string | null;
  performanceContext: PerformanceContextPayload;
  autonomyCandidate: AutonomyCandidate | null;
  streamSpeech: boolean;
  earlySpeechLead: boolean;
  recentExpressionLevels: ExpressionLevel[];
}

export interface CardPreviewRequestPayload {
  cardId: string;
  performanceContext: PerformanceContextPayload;
}

export interface CardAssistantResponse extends AssistantResponse {
  worldIntent?: import('../src/sharedWorld/state.js').WorldIntent;
  visualIntent?: import('../src/visual/types.js').VisualIntent;
  manifestation?: 'none' | 'chicken' | 'gigantic' | 'sparkle' | 'underwater';
  activatedCards: string[];
  speechAct: SpeechAct | null;
  expressionLevel: ExpressionLevel | null;
  externalAction?: AutonomyExternalAction;
  usedReasonIds?: string[];
  internalDelta?: AutonomyInternalDelta;
  interactionAction?: ConversationAction;
  voiceAction?: VoiceInteractionAction;
  backchannelCue?: ConversationBackchannelCue;
}

export interface AivisSpeaker {
  name: string;
  styles: AivisStyle[];
}

export interface AivisSpeakerCatalogCache {
  get(baseUrl: URL): Promise<AivisSpeaker[]>;
}

export const AIVIS_SPEAKER_CACHE_TTL_MS = 5 * 60 * 1_000;

export interface ClientConversationEvent {
  audioContextState?: 'closed' | 'running' | 'suspended';
  audioSourceKind?: 'buffer' | 'stream';
  at: string;
  bufferedDurationMs?: number;
  elapsedMs: number;
  event: ConversationEventName;
  source: ConversationEventSource;
  turnId: string;
  durationMs?: number;
  emotion?: Emotion;
  firstChunkBytes?: number;
  firstChunkIntervalMs?: number;
  phase?: 'llm' | 'tts';
  playbackRoute?: 'conversation';
  primingOutcome?: 'cancelled' | 'complete' | 'disabled' | 'target' | 'timeout';
  primingTargetMs?: number;
  primingWaitMs?: number;
  reason?: string;
  sampleRateHz?: number;
  interactionAction?: ConversationAction;
  purpose?: LlmProviderPurpose;
  callIndex?: number;
  retry?: number;
  unitIndex?: number;
  runId?: string;
  gateEvent?: AutonomyTurnGateTelemetry['gateEvent'];
  gatePhase?: AutonomyTurnGateTelemetry['gatePhase'];
  transition?: AutonomyTurnGateTelemetry['transition'];
  blockedBy?: AutonomyTurnGateTelemetry['blockedBy'];
  externalEvent?: AutonomyTurnGateTelemetry['externalEvent'];
  candidateEpisodeId?: string;
  candidateReasonIds?: string[];
  candidateEvidenceIds?: string[];
  usedReasonIds?: string[];
  internalDeltaOperations?: string[];
  affectedReasonIds?: string[];
  createdReasonIds?: string[];
  resolvedReasonIds?: string[];
  externalAction?: AutonomyTurnGateTelemetry['externalAction'];
  nextEligibleAt?: number | null;
  delayMs?: number;
  timingMode?: AutonomyTurnGateTelemetry['timingMode'];
  elapsedSilenceMs?: number;
  readiness?: number;
  threshold?: number;
  opportunityOutcome?: AutonomyTurnGateTelemetry['opportunityOutcome'];
  sessionGeneration?: number;
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export class AivisSpeechError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
  }
}

export class CardContractError extends Error { }

export class VoicePolicyContractError extends CardContractError { }

export class ConversationPolicyContractError extends Error { }

export function normalizeConversationActionDecision(
  message: string,
  decision: ConversationActionDecision,
  characterIdentity: CharacterIdentity = DEFAULT_CHARACTER_IDENTITY,
): ConversationActionDecision {
  const selfNameResolution = resolveSelfName(message, characterIdentity);
  if (selfNameResolution.role === 'direct_address') {
    return { action: 'take_floor', backchannelCue: 'none' };
  }
  return classifyViewerMessageFastPath(message) ?? decision;
}

export function normalizeVoiceInteractionDecision(
  message: string,
  decision: ConversationActionDecision,
  characterIdentity: CharacterIdentity = DEFAULT_CHARACTER_IDENTITY,
): ConversationActionDecision {
  return normalizeConversationActionDecision(message, decision, characterIdentity);
}

export function normalizeVoiceAssistantResponseDecision(
  message: string,
  decision: VoiceInteractionDecision,
  characterIdentity: CharacterIdentity = DEFAULT_CHARACTER_IDENTITY,
): VoiceInteractionDecision {
  if (resolveSelfName(message, characterIdentity).role === 'direct_address') {
    return { action: 'take_floor', backchannelCue: 'none' };
  }
  if (decision.action === 'take_floor' || !isContentBearingVoiceMessage(message)) {
    return decision;
  }
  if (
    decision.action === 'react_nonverbally' &&
    !isDefiniteQuestionMessage(message) &&
    !isActionCommitmentMessage(message) &&
    !isDirectActionRequestMessage(message)
  ) {
    return decision;
  }
  return { action: 'take_floor', backchannelCue: 'none' };
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: object,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

export function sendNoContent(response: ServerResponse): void {
  response.writeHead(204, {
    'Cache-Control': 'no-store',
  });
  response.end();
}

export function startNdjson(response: ServerResponse): void {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
}

export function writeNdjson(response: ServerResponse, payload: object): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`${JSON.stringify(payload)}\n`);
}

export function readTurnIdHeader(request: IncomingMessage): string | null {
  const values = [
    request.headers['x-performer-turn-id'],
    request.headers['x-wildcard-turn-id'],
  ];

  for (const value of values) {
    if (value === undefined) continue;
    const candidate = Array.isArray(value) ? value[0] : value;
    if (
      typeof candidate !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(candidate)
    ) {
      return null;
    }
    return candidate;
  }

  return null;
}

export function readPlaycheckRunIdHeader(
  request: IncomingMessage,
): string | null | undefined {
  const value = request.headers['x-performer-run-id'];
  if (value === undefined) return undefined;
  const candidate = Array.isArray(value) ? value[0] : value;
  return isPlaycheckRunId(candidate) ? candidate : null;
}

export const PLAYCHECK_RECORD_FIELDS = [
  'requestId',
  'turnId',
  'source',
  'clientAt',
  'elapsedMs',
  'durationMs',
  'emotion',
  'phase',
  'reason',
  'interactionAction',
  'activeRequests',
  'audioBytes',
  'provider',
  'model',
  'purpose',
  'callIndex',
  'retry',
  'externalRequestIndex',
  'providerCallCount',
  'profile',
  'apiEndpoint',
  'maxOutputTokens',
  'providerMaxOutputTokens',
  'terminationKind',
  'httpStatus',
  'incompleteReason',
  'cacheMode',
  'cacheKeyVersion',
  'cacheStatus',
  'requestedTier',
  'actualTier',
  'actualModel',
  'inputTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
  'outputTextChars',
  'outputTextDeltaCount',
  'outputTextDone',
  'staticPrefixChars',
  'dynamicContextChars',
  'schemaBytes',
  'historyItemCount',
  'historyChars',
  'requestBytes',
  'warmup',
  'fallbackReason',
  'parserMilestone',
  'unitIndex',
  'characterCount',
  'gateEvent',
  'gatePhase',
  'transition',
  'blockedBy',
  'externalEvent',
  'candidateEpisodeId',
  'candidateReasonIds',
  'candidateEvidenceIds',
  'usedReasonIds',
  'internalDeltaOperations',
  'affectedReasonIds',
  'createdReasonIds',
  'resolvedReasonIds',
  'externalAction',
  'nextEligibleAt',
  'delayMs',
  'timingMode',
  'elapsedSilenceMs',
  'readiness',
  'threshold',
  'opportunityOutcome',
  'sessionGeneration',
] as const;

export const SAFE_PLAYCHECK_REASONS = new Set([
  'busy',
  'muted',
  'superseded',
  'request_invalid',
  'provider_error',
  'authentication',
  'configuration',
  'connection',
  'invalid_request',
  'model',
  'quota',
  'rate_limit',
  'timeout',
  'silence',
  'take_floor',
  'listen',
  'backchannel',
  'react_nonverbally',
  'wait',
]);

export function bindLlmProviderAbort(
  request: IncomingMessage,
  response: ServerResponse,
  controller: AbortController,
): () => void {
  const abortProvider = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once('aborted', abortProvider);
  response.once('close', abortProvider);
  if (request.aborted || response.destroyed) abortProvider();
  return () => {
    request.off('aborted', abortProvider);
    response.off('close', abortProvider);
  };
}

export function resolveLlmProviderSource(
  mode: ChatMode,
  forcedCardId: string | null,
  programContext: ProgramContext,
): LlmProviderSource {
  return mode === 'autonomous' &&
    forcedCardId !== null &&
    programContext.phase === 'after_card_change'
    ? 'card_change'
    : mode;
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new RequestError('Request body is too large.', 400);
    }
    chunks.push(buffer);
  }

  try {
    const body = Buffer.concat(chunks).toString('utf8');
    return body ? JSON.parse(body) : {};
  } catch {
    throw new RequestError('Request body must be valid JSON.', 400);
  }
}

export const VOICE_REPLY_INSTRUCTION = [
  'Reply in the same language as the user.',
  'This is a spoken Japanese conversation.',
  'Usually use one short conversational unit of about 8 to 24 Japanese characters.',
  'For a content-bearing viewer utterance, pick one concrete topic word, feeling, or question intent from the latest utterance and respond to it with a concrete reaction. Use a paraphrase only when it adds a distinct reaction or clarifies the meaning.',
  'Answer a direct question briefly.',
  'Do not make the reply only a generic acknowledgment such as うん, そうなんだ, なるほど, or そっか.',
  'If a short, low-information content utterance is better acknowledged by a small existing non-verbal reaction, use react_nonverbally with empty text instead of adding a spoken echo. Never use it for a question or a direct action request.',
  'Do not repeat the whole utterance.',
  'Use recent conversation history to avoid a mutual backchannel or agreement loop.',
  'If the last few turns already agree with or paraphrase one another, do not merely mirror the latest utterance.',
  'When appropriate after several agreeing or mirroring turns, add one small new observation, feeling, sensory detail, topic angle, or light disagreement so the conversation moves slightly sideways.',
  'When the latest utterance announces a concrete action such as confirming, organizing, sharing, creating, preparing, starting, or proceeding, do not treat the announcement or agreement as progress.',
  'When the viewer directly asks you to perform an action such as introducing yourself, stating the purpose, naming one item, or moving to the next item, perform that action in the reply. Do not reply only that you will do it.',
  'Do not claim to have seen, checked, changed, or completed an external-world action that the runtime cannot perform. If the interaction is role-play, keep the action clearly symbolic.',
  'If the needed information is present, perform the first small step now and state one concrete item or result.',
  'If the needed information is missing, ask one concrete question that names the missing item.',
  'Do not invent meeting-style purpose, agenda, decisions, owners, or schedules unless the latest request makes them necessary. For casual chat, daily requests, role-play, or simple question-and-answer, respond to the concrete content directly.',
  'Do not reply with only meta-agreement such as その方向で進めましょう, お願いします, 確認しましょう, 整理しましょう, or では始めましょう.',
  'Do not force a question or a new topic. If the moment is intentionally quiet, keep a take_floor reply brief instead of forcing novelty, but do not repeat the same agreement across turns.',
  'A fragment, filler, hesitation, or small self-correction is allowed when it sounds natural.',
  'Use at most two short clauses.',
  'Do not write a poem, lecture, explanation, greeting formula, or forced empathy.',
  'Do not add a question unless the turn needs one.',
].join(' ');

export interface GeneratedChatResponse {
  response: CardAssistantResponse;
  providerCallCount: number;
}

export interface StreamingReplyCallbacks {
  onVisualDecision?: (intent: unknown) => void;
  onSpeechUnit: (
    index: number,
    unit: string,
    response: CardAssistantResponse,
  ) => void;
  onStateRejected: () => void;
  onDeliveryMetadataRejected: () => void;
  onParserMilestone?: (
    milestone:
      | 'delivery_header_complete'
      | 'speech_lead_complete'
      | 'provisional_validation_rejected'
      | 'full_json_complete'
      | 'full_json_rejected'
      | 'speech_lead_rejected'
      | 'delivery_contract_rejected'
      | 'committed_units_changed'
      | 'state_contract_rejected'
      | 'speech_unit_written'
      | 'terminal_envelope_parseable'
      | 'terminal_envelope_unparseable',
    metadata: {
      callIndex: number;
      retry: number;
      externalRequestIndex: number;
    },
  ) => void;
}

export interface PreparedAivisCloudAudio {
  firstChunk: Uint8Array;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  result: AivisCloudSynthesisResult;
}
