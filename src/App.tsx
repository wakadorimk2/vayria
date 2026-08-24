import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { VrmStage, type VrmStageHandle } from './avatar/VrmStage';
import { useCameraAttention } from './attention/useCameraAttention';
import { useAudioLipSync } from './audio/useAudioLipSync';
import { CardGamePrototype } from './cards/CardGamePrototype';
import { useCardGamePrototype } from './cards/useCardGamePrototype';
import {
  addCharacterAlias,
  parseExplicitAliasInstruction,
  readCharacterIdentity,
  writeCharacterIdentity,
  type CharacterIdentity,
} from './character/identity';
import {
  useAutonomousTalk,
  type AutonomyCandidateTelemetry,
  type AutonomyExternalEventSignal,
  type AutonomousTurnOutcome,
} from './conversation/useAutonomousTalk';
import {
  readAutonomyTurnGateTiming,
  type AutonomyTurnGateExternalEvent,
} from './conversation/autonomyTurnGate';
import { emitAutonomyGateEvent } from './conversation/conversationEvents';
import {
  INITIAL_AUTONOMOUS_CONTEXT,
  recordViewerIntent,
} from './conversation/autonomousContext';
import {
  applyReasonUpdates,
  completeInactiveEpisodes,
  createAutonomyEvidenceId,
  createInitialAutonomyState,
  markCandidateOffered,
  observeAutonomyEvidence,
  resolveUsedReasons,
  selectAutonomyCandidate,
  type AutonomyCandidate,
  type AutonomyEvidence,
  type AutonomyInternalDelta,
  type AutonomyState,
} from './conversation/autonomyState';
import {
  useConversation,
  type AutonomyDeltaContext,
  type AutonomyEvidenceContext,
  type AutonomousContext,
  type ChatCardContext,
} from './conversation/useConversation';
import {
  DEFAULT_PROGRAM_CONTEXT,
  type ProgramContext,
  type ProgramPhase,
} from './conversation/programContext';
import type { CardSwapResult } from './cards/useCardGamePrototype';
import {
  CARD_INTERACTION_ATTENTION_DURATION_MS,
  shouldReactToCardInteraction,
} from './cards/cardReactions';
import { useWildcardDirection } from './cards/wildcardDirection';
import { usePerformerRuntime } from './performer/usePerformerRuntime';
import type {
  Attention,
  ConversationActionDecision,
  DirectionContribution,
  AttentionReader,
  PerformancePlan,
  PerformanceResult,
  PerformerTrigger,
} from './performer/types';
import { isContentBearingVoiceMessage } from './performer/runtime';
import { runtimeConfig } from './runtimeConfig';
import { fetchListeningBackchannels } from './voice/backchannel';
import type { ListeningBackchannelAudio } from './voice/backchannelPolicy';
import {
  selectListeningBackchannelIndex,
} from './voice/backchannelPolicy';
import { useVoiceInput } from './voice/useVoiceInput';
import { AudioLabPanel } from './voice/AudioLabPanel';
import { RouterPanel } from './router/RouterPanel';
import { useConversationRouter } from './router/useConversationRouter';
import type {
  RouterEffect,
  RouterSignal,
} from './router/routerTypes.js';
import {
  isConfirmedBargeInTranscript,
  isRejectedBargeInCandidate,
  reduceBargeIn,
  shouldInterruptBusyTurn,
  type BargeInEvent,
} from './voice/bargeIn';
import {
  BARGE_IN_TIMEOUT_MS,
  clampVadThreshold,
  DEFAULT_VAD_THRESHOLD,
  getEffectiveAudioEndpointMs,
  getExhibitionAudioPresetConfig,
  isAudioEndpointMs,
  isAudioLabMode,
  resolveInitialAudioLabMode,
  VAD_THRESHOLD_MAX,
  VAD_THRESHOLD_MIN,
  VAD_THRESHOLD_STEP,
  type AudioEndpointMs,
  type AudioLabMode,
  type BargeInState,
} from './voice/audioLab.js';
import { useVoiceLab } from './voice/useVoiceLab';
import {
  LISTENING_THINKING_MOTION_ASSET_ID,
  type VoiceBackchannelCue,
} from './voice/voiceInteraction';
import {
  MAX_VOICE_TEXT_LENGTH,
  type ListeningReactionCue,
  type VoiceInputEvent,
} from './voice/voiceInput';
import { PerformancePlaybackCoordinator } from './performer/performancePlayback';

const STATUS_LABELS = {
  idle: '話しかけてください。',
  thinking: '考えています…',
  synthesizing: '返答音声を作っています…',
  speaking: '話しています。',
  error: '処理を完了できませんでした。',
} as const;

function getCameraAttentionStatusMessage(
  status: ReturnType<typeof useCameraAttention>['status'],
  errorCode: ReturnType<typeof useCameraAttention>['errorCode'],
): string {
  if (status === 'starting') return '視線追従を準備しています…';
  if (status === 'active') return '視線追従が有効です。';
  if (status === 'disabled') {
    return '動きの少ない表示では視線追従を停止します。';
  }
  switch (errorCode) {
    case 'insecure-context':
      return 'HTTPSで開くと視線追従を使えます。';
    case 'unsupported':
      return 'このブラウザーではカメラを使えません。';
    case 'permission-denied':
      return 'カメラの許可が必要です。もう一度お試しください。';
    case 'camera-failed':
      return 'カメラを開始できませんでした。もう一度お試しください。';
    case 'model-failed':
    case 'worker-failed':
      return '視線追従を準備できませんでした。もう一度お試しください。';
    default:
      return '';
  }
}

function getVoiceStatusLabel(
  isEnabled: boolean,
  phase: ReturnType<typeof useVoiceInput>['phase'],
): string {
  if (!isEnabled) return STATUS_LABELS.idle;
  if (phase === 'speech_detected') return '聞いています。発話を検知しました。';
  if (phase === 'utterance_finalized') return '聞き取りました。送信します…';
  if (phase === 'error') return '音声入力を利用できません。';
  return '聞いています…';
}

function getVoiceErrorMessage(code: string | null): string {
  switch (code) {
    case 'unsupported':
      return 'このブラウザーは音声入力に対応していません。テキスト入力を利用してください。';
    case 'not-allowed':
    case 'service-not-allowed':
      return 'マイクの権限がありません。ブラウザーの設定を確認してください。';
    case 'audio-capture':
      return 'マイクを利用できません。接続とブラウザーの設定を確認してください。';
    case 'audio-capture-silent':
      return 'マイク音声フレームを取得できません。ホーム画面版を再試行するか、Safariタブで開いてください。';
    case 'audio-capture-muted':
      return 'iPadOSがマイク音声を停止しました。音声入力を再試行してください。';
    case 'audio-capture-ended':
      return 'マイク捕捉が終了しました。音声入力を再試行してください。';
    case 'insecure-context':
      return '音声入力にはHTTPS接続が必要です。VayriaをHTTPSで開いてください。';
    case 'audio-worklet-unsupported':
    case 'audio-capture-unsupported':
      return 'このブラウザーはPCM音声入力に対応していません。テキスト入力を利用してください。';
    case 'audio-context-timeout':
      return '音声エンジンの起動がタイムアウトしました。ホーム画面版を再試行するか、Safariタブで開いてください。';
    case 'voice-transport-unavailable':
    case 'voice-transport-closed':
    case 'voice-transport-timeout':
      return '音声サービスに接続できません。STTサービスが起動しているか確認してください。';
    case 'stt-unavailable':
      return '音声認識サービスを利用できません。STTサービスの設定を確認してください。';
    case 'voice-transport-backpressure':
      return '音声データの送信が詰まりました。接続を確認してください。';
    default:
      return code ? '音声入力でエラーが発生しました。' : '';
  }
}

function MicrophoneIcon() {
  return (
    <svg
      aria-hidden="true"
      className="control-icon"
      viewBox="0 0 24 24"
      focusable="false"
    >
      <path
        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0m6 6v4m-3 0h6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="control-icon"
      viewBox="0 0 24 24"
      focusable="false"
    >
      <path
        d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Zm9-2.25A2.25 2.25 0 1 0 12 14.25 2.25 2.25 0 0 0 12 9.75Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

type ExhibitionPresentationState = 'idle' | 'selecting' | 'reacting';

const AUDIO_SETTINGS_STORAGE_KEY = 'vayria.audio-settings.v1';
const LEGACY_AUDIO_SETTINGS_STORAGE_KEY = 'wildcard.audio-settings.v1';
const ROUTER_AUDIO_INPUT_DEVICE_STORAGE_KEY =
  'vayria.router.audio-input-device.v1';
const VOICE_NONVERBAL_REACTION_HOLD_MS = 650;

interface AudioControlState {
  isMuted: boolean;
  lastAudibleVolume: number;
  volume: number;
}

function createDefaultAudioControlState(): AudioControlState {
  return { isMuted: false, lastAudibleVolume: 1, volume: 1 };
}

function readStoredVolume(value: unknown, allowZero: boolean): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < (allowZero ? 0 : Number.EPSILON) || value > 1) return null;
  return value;
}

function parseAudioControlState(rawValue: string | null): AudioControlState | null {
  if (rawValue === null) return null;

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const volume = readStoredVolume(record.volume, true);
    const lastAudibleVolume = readStoredVolume(
      record.lastAudibleVolume,
      false,
    );
    if (volume === null || lastAudibleVolume === null) {
      return null;
    }
    return {
      isMuted: volume === 0,
      lastAudibleVolume,
      volume,
    };
  } catch {
    return null;
  }
}

function readAudioControlState(): AudioControlState {
  try {
    for (const storageKey of [
      AUDIO_SETTINGS_STORAGE_KEY,
      LEGACY_AUDIO_SETTINGS_STORAGE_KEY,
    ]) {
      const state = parseAudioControlState(localStorage.getItem(storageKey));
      if (state !== null) return state;
    }
  } catch {
    // Playback remains usable when storage is unavailable.
  }

  return createDefaultAudioControlState();
}

function readRouterAudioInputDeviceId(): string {
  try {
    return localStorage.getItem(ROUTER_AUDIO_INPUT_DEVICE_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export default function App() {
  const [input, setInput] = useState('');
  const [isAvatarReady, setIsAvatarReady] = useState(false);
  const [isCardSelectionActive, setIsCardSelectionActive] = useState(false);
  const [cardAttentionTarget, setCardAttentionTarget] = useState<
    'game' | null
  >(null);
  const [audioControl, setAudioControl] = useState(readAudioControlState);
  const [characterIdentity, setCharacterIdentity] = useState(
    readCharacterIdentity,
  );
  const [programPhase, setProgramPhase] = useState<ProgramPhase>(
    DEFAULT_PROGRAM_CONTEXT.phase,
  );
  const programContext = useMemo(
    () => ({ ...DEFAULT_PROGRAM_CONTEXT, phase: programPhase }),
    [programPhase],
  );
  const [autonomousContext, setAutonomousContext] =
    useState<AutonomousContext>(INITIAL_AUTONOMOUS_CONTEXT);
  const [autonomyState, setAutonomyState] = useState<AutonomyState>(
    createInitialAutonomyState,
  );
  const [autonomyExternalEvent, setAutonomyExternalEvent] = useState<
    AutonomyExternalEventSignal | null
  >(null);
  const [isAutonomousLoopEnabled, setIsAutonomousLoopEnabled] =
    useState(true);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const { isMuted, lastAudibleVolume, volume } = audioControl;
  const isExhibitionMode = runtimeConfig.mode === 'exhibition';
  const cardGame = useCardGamePrototype();
  const { acceptReply, beginReply, resetTurn, zones } = cardGame;
  const performer = usePerformerRuntime();
  const {
    errorCode: cameraAttentionErrorCode,
    readSnapshot: readCameraSnapshot,
    start: startCameraAttention,
    status: cameraAttentionStatus,
    stop: stopCameraAttention,
  } = useCameraAttention({ enabled: isExhibitionMode });
  const wildcardDirection = useWildcardDirection(zones);
  const {
    completePlan,
    createPlan,
    getPerformerStateContext,
    profile: performerProfile,
    resetRuntime,
    setPhase,
  } = performer;
  const {
    activateCardSwap,
    getContribution: getWildcardContribution,
  } = wildcardDirection;
  const [activePlan, setActivePlan] = useState<PerformancePlan | null>(null);
  const [activeEmotionCue, setActiveEmotionCue] = useState<
    { emotion: NonNullable<PerformanceResult['emotionCue']>['emotion']; intensity: number } | null
  >(null);
  const activePlanRef = useRef<PerformancePlan | null>(null);
  const logicalAttentionRef = useRef<Attention>({
    target: 'none',
    strength: 0,
    updatedAt: 0,
    position: null,
    confidence: 0,
  });
  const characterIdentityRef = useRef<CharacterIdentity>(characterIdentity);
  const autonomyStateRef = useRef(autonomyState);
  const pendingCardStimulusRef = useRef<{
    cardContext: ChatCardContext;
    contribution: DirectionContribution;
    programContext: ProgramContext;
  } | null>(null);
  useEffect(() => {
    characterIdentityRef.current = characterIdentity;
  }, [characterIdentity]);
  const cardReactionPlanIdsRef = useRef(new Set<string>());
  const pendingActivatedCardIdsRef = useRef(new Map<string, string[]>());
  const stageRef = useRef<VrmStageHandle>(null);
  const [stageMotionPort, setStageMotionPort] =
    useState<VrmStageHandle | null>(null);
  const nonSpeechTimerRef = useRef<number | null>(null);
  const cardAttentionTimerRef = useRef<number | null>(null);
  const sessionGenerationRef = useRef(0);
  const {
    isAudioUnlocked,
    isReactionPlaying,
    isSpeaking,
    mouthOpen,
    play,
    playReaction,
    prepare,
    setDucked,
    stop,
    stopReaction,
  } = useAudioLipSync(volume);
  const [listeningReaction, setListeningReaction] =
    useState<ListeningReactionCue | undefined>();
  const readAttention: AttentionReader = useCallback(() => {
    const logicalAttention = logicalAttentionRef.current;
    const cameraSnapshot = readCameraSnapshot();
    return {
      ...logicalAttention,
      position: cameraSnapshot.position,
      confidence: cameraSnapshot.confidence,
      updatedAt: Math.max(
        logicalAttention.updatedAt,
        cameraSnapshot.updatedAt,
      ),
    };
  }, [readCameraSnapshot]);

  const recordAutonomyEvidence = useCallback((evidence: AutonomyEvidence) => {
    const nextState = observeAutonomyEvidence(autonomyStateRef.current, evidence);
    autonomyStateRef.current = nextState;
    setAutonomyState(nextState);
    return nextState;
  }, []);

  const notifyMeaningfulAutonomyEvent = useCallback(
    (kind: AutonomyTurnGateExternalEvent) => {
      setAutonomyExternalEvent((current) => ({
        sequence: (current?.sequence ?? 0) + 1,
        kind,
      }));
    },
    [],
  );

  const readAutonomyEvidenceContext = useCallback(
    (state: AutonomyState, evidenceId: string): AutonomyEvidenceContext | null => {
      const matchingReasons = state.reasons.filter(
        (reason) =>
          reason.status === 'active' &&
          reason.decisionEvidenceIds.includes(evidenceId),
      );
      const episodeId = matchingReasons[0]?.episodeId;
      if (!episodeId) return null;
      return {
        episodeId,
        evidenceId,
        reasonIds: matchingReasons
          .filter((reason) => reason.episodeId === episodeId)
          .map((reason) => reason.id),
      };
    },
    [],
  );

  const handleAutonomyDelta = useCallback(
    (
      delta: AutonomyInternalDelta,
      context: AutonomyDeltaContext,
    ) => {
      const current = autonomyStateRef.current;
      const episodeId =
        context.episodeId ??
        current.reasons.find((reason) =>
          reason.decisionEvidenceIds.includes(context.evidenceId),
        )?.episodeId ??
        null;
      if (!episodeId) return;
      let nextState = current;
      let createdReasonIds: readonly string[] = [];
      let resolvedReasonIds: readonly string[] = [];
      const internalDeltaOperations = delta.reasonUpdates.map(
        (update) => update.operation,
      );
      if (delta.reasonUpdates.length) {
        const deltaEvidenceId = createAutonomyEvidenceId('autonomy-delta');
        const stateWithDeltaEvidence = observeAutonomyEvidence(current, {
          id: deltaEvidenceId,
          kind: 'internal_state_change',
          at: Date.now(),
          semanticKey: `internal-delta:${context.source}`,
          episodeId,
        });
        const result = applyReasonUpdates(stateWithDeltaEvidence, delta.reasonUpdates, {
          episodeId,
          evidenceId: deltaEvidenceId,
          at: Date.now(),
        });
        createdReasonIds = result.createdReasonIds;
        resolvedReasonIds = result.state.reasons
          .filter((reason) => {
            if (reason.status !== 'resolved') return false;
            const previous = current.reasons.find(
              (candidate) => candidate.id === reason.id,
            );
            return previous?.status !== 'resolved';
          })
          .map((reason) => reason.id);
        if (result.changed) nextState = result.state;
      }
      const resolvableReasonIds = context.reasonIds.filter((reasonId) =>
        nextState.reasons.some(
          (reason) => reason.id === reasonId && reason.status === 'active',
        ),
      );
      if (context.resolvesReason && resolvableReasonIds.length) {
        resolvedReasonIds = [
          ...new Set([...resolvedReasonIds, ...resolvableReasonIds]),
        ];
        nextState = resolveUsedReasons(
          nextState,
          resolvableReasonIds,
          episodeId,
        );
      }
      nextState = completeInactiveEpisodes(nextState);
      if (delta.reasonUpdates.length || resolvedReasonIds.length) {
        emitAutonomyGateEvent({
          gateEvent: 'internal_delta',
          gatePhase: 'running',
          transition: 'ignored',
          internalDeltaOperations,
          affectedReasonIds: [
            ...new Set([
              ...context.reasonIds,
              ...createdReasonIds,
              ...resolvedReasonIds,
            ]),
          ],
          createdReasonIds,
          resolvedReasonIds,
        });
      }
      if (nextState === current) return;
      autonomyStateRef.current = nextState;
      setAutonomyState(nextState);
    },
    [],
  );
  const [voiceValidationError, setVoiceValidationError] = useState('');
  const voiceEventHandlerRef = useRef<((event: VoiceInputEvent) => void) | null>(
    null,
  );
  const routerObserveSignalRef = useRef<
    ((signal: RouterSignal) => unknown) | null
  >(null);
  const voiceReactionIdRef = useRef(0);
  const activeBargeInSegmentRef = useRef<string | null>(null);
  const routerBlockedSegmentRef = useRef<string | null>(null);
  const backchannelAudioRef = useRef<ListeningBackchannelAudio[]>([]);
  const backchannelVariantIndexRef = useRef<
    Record<Exclude<VoiceBackchannelCue, 'none'>, number | null>
  >({ un: null, uun: null });
  const backchannelLoadingRef = useRef<Promise<void> | null>(null);
  const bargeInTimerRef = useRef<number | null>(null);
  const bargeInStateRef = useRef<BargeInState>('idle');
  const [bargeInState, setBargeInState] = useState<BargeInState>('idle');
  const [bargeInTimeoutToken, setBargeInTimeoutToken] = useState(0);
  const [audioLabMode, setAudioLabMode] = useState<AudioLabMode>(
    () =>
      resolveInitialAudioLabMode(
        runtimeConfig.audioLabEnabled,
        isExhibitionMode,
      ),
  );
  const [vadThreshold, setVadThreshold] = useState(
    () =>
      getExhibitionAudioPresetConfig(runtimeConfig.audioPreset)
        .defaultVadThreshold ?? DEFAULT_VAD_THRESHOLD,
  );
  const [audioEndpointMs, setAudioEndpointMs] = useState<AudioEndpointMs>(
    runtimeConfig.audioEndpointMs,
  );
  const [routerAudioInputDeviceId, setRouterAudioInputDeviceId] = useState(
    () => (runtimeConfig.routerEnabled ? readRouterAudioInputDeviceId() : ''),
  );
  const effectiveAudioEndpointMs = getEffectiveAudioEndpointMs(
    audioLabMode,
    audioEndpointMs,
  );
  const ttsPlaying = isSpeaking || isReactionPlaying;
  const voiceLab = useVoiceLab({
    // Router runs with derived-only logging. Voice Lab stores transcripts, so
    // do not start its recorder in the closed-loop mode.
    enabled: runtimeConfig.audioLabEnabled && !runtimeConfig.routerEnabled,
    mode: audioLabMode,
    preset: runtimeConfig.audioPreset,
    audioEndpointMs: effectiveAudioEndpointMs,
    ttsPlaying,
  });
  const { handleInteractionTimelineEvent } = voiceLab;
  const voiceInput = useVoiceInput({
    audioMode: audioLabMode,
    audioPreset: runtimeConfig.audioPreset,
    audioEndpointMs: effectiveAudioEndpointMs,
    audioInputDeviceId: routerAudioInputDeviceId,
    language: 'ja-JP',
    ttsPlaying,
    onDiagnostic: voiceLab.handleDiagnostic,
    onEvent: (event) => {
      voiceLab.handleVoiceEvent(event);
      voiceEventHandlerRef.current?.(event);
    },
    vadThreshold,
  });
  const {
    errorCode: voiceInputErrorCode,
    audioLevel,
    effectiveThreshold,
    isEnabled: isVoiceInputEnabled,
    isSttProcessing,
    isSupported: isVoiceInputSupported,
    isVadSpeech,
    noiseFloor,
    phase: voiceInputPhase,
    start: startVoiceInput,
    stop: stopVoiceInput,
  } = voiceInput;

  const handleAudioLabModeChange = useCallback(
    (nextMode: AudioLabMode) => {
      if (isVoiceInputEnabled || !isAudioLabMode(nextMode)) return;
      setAudioLabMode(nextMode);
    },
    [isVoiceInputEnabled],
  );

  const handleVadThresholdChange = useCallback((nextThreshold: number) => {
    setVadThreshold(clampVadThreshold(nextThreshold));
  }, []);

  const handleAudioEndpointChange = useCallback(
    (nextEndpoint: number) => {
      if (isVoiceInputEnabled || !isAudioEndpointMs(nextEndpoint)) return;
      setAudioEndpointMs(nextEndpoint);
    },
    [isVoiceInputEnabled],
  );
  const playbackCoordinator = useMemo(
    () =>
      new PerformancePlaybackCoordinator({
        getMotionPort: () => stageMotionPort,
        playAudio: play,
        stopAudio: stop,
      }),
    [play, stageMotionPort, stop],
  );

  const handleInteractionAction = useCallback(
    (decision: ConversationActionDecision) => {
      if (
        decision.action === 'listen' ||
        decision.action === 'backchannel' ||
        decision.action === 'react_nonverbally' ||
        decision.action === 'take_floor'
      ) {
        routerObserveSignalRef.current?.({
          type: 'interaction_action',
          action: decision.action,
          ...(decision.backchannelCue === 'un' || decision.backchannelCue === 'uun'
            ? { backchannelCue: decision.backchannelCue }
            : {}),
        });
      }
      if (decision.action === 'take_floor') return;

      stopReaction();
      voiceReactionIdRef.current += 1;
      const reactionId = voiceReactionIdRef.current;

      if (decision.action === 'listen') {
        setListeningReaction({
          id: reactionId,
          kind: 'thinking',
          target: 'viewer',
        });
        const motionPromise = stageRef.current?.playReactionMotion(
          LISTENING_THINKING_MOTION_ASSET_ID,
          reactionId,
        );
        if (motionPromise) {
          void motionPromise.then(
            () => {
              if (voiceReactionIdRef.current === reactionId) {
                setListeningReaction(undefined);
              }
            },
            () => {
              if (voiceReactionIdRef.current === reactionId) {
                setListeningReaction(undefined);
              }
            },
          );
        } else {
          setListeningReaction(undefined);
        }
        return;
      }

      if (decision.action === 'react_nonverbally') {
        setListeningReaction({
          id: reactionId,
          kind: 'nod',
          target: 'viewer',
        });
        window.setTimeout(() => {
          if (voiceReactionIdRef.current === reactionId) {
            setListeningReaction(undefined);
          }
        }, VOICE_NONVERBAL_REACTION_HOLD_MS);
        return;
      }

      if (decision.action !== 'backchannel') {
        setListeningReaction(undefined);
        return;
      }

      // The spoken backchannel is already the response. Do not add a second
      // nod for the same short acknowledgement.
      const cue = decision.backchannelCue === 'uun' ? 'uun' : 'un';
      const playCue = () => {
        if (voiceReactionIdRef.current !== reactionId) return;
        const candidates = backchannelAudioRef.current.filter(
          (audio) => audio.cue === cue,
        );
        const variantIndex = selectListeningBackchannelIndex(
          candidates.length,
          backchannelVariantIndexRef.current[cue],
        );
        const selectedAudio =
          variantIndex === null ? undefined : candidates[variantIndex];
        if (!selectedAudio) {
          setListeningReaction(undefined);
          return;
        }
        void playReaction(selectedAudio.audioData).then((played) => {
          if (played) {
            backchannelVariantIndexRef.current[cue] = variantIndex;
            handleInteractionTimelineEvent({
              kind: 'backchannel_played',
              at: Date.now(),
              cue,
              channel: 'local_preloaded',
            });
          }
          if (voiceReactionIdRef.current === reactionId) {
            setListeningReaction(undefined);
          }
        });
      };

      if (backchannelLoadingRef.current) {
        void backchannelLoadingRef.current.then(playCue);
      } else {
        playCue();
      }
    },
    [handleInteractionTimelineEvent, playReaction, stopReaction],
  );

  const handlePerformancePlan = useCallback((plan: PerformancePlan) => {
    activePlanRef.current = plan;
    setActivePlan(plan);
    playbackCoordinator.prepare(plan);
  }, [playbackCoordinator]);

  const handlePerformanceCue = useCallback(
    (
      planId: string,
      cue: NonNullable<PerformanceResult['emotionCue']>,
    ) => {
      if (activePlanRef.current?.planId !== planId) return;
      setActiveEmotionCue(cue);
    },
    [],
  );

  const handlePerformanceResult = useCallback(
    (result: PerformanceResult) => {
      if (activePlanRef.current?.planId !== result.planId) return;
      const isCardReactionPlan = cardReactionPlanIdsRef.current.delete(
        result.planId,
      );
      const pendingActivatedCardIds = pendingActivatedCardIdsRef.current.get(
        result.planId,
      );
      pendingActivatedCardIdsRef.current.delete(result.planId);
      if (result.outcome === 'failed') {
        setIsAutonomousLoopEnabled(false);
      }
      playbackCoordinator.stop();
      completePlan(result);
      if (isCardReactionPlan) {
        if (result.outcome === 'completed' && pendingActivatedCardIds) {
          acceptReply(pendingActivatedCardIds);
        } else {
          resetTurn();
        }
      }
      activePlanRef.current = null;
      setActivePlan(null);
      setActiveEmotionCue(null);
    },
    [acceptReply, completePlan, playbackCoordinator, resetTurn],
  );

  const handleReplyAccepted = useCallback(
    (activatedCardIds: string[]) => {
      const planId = activePlanRef.current?.planId;
      if (planId && cardReactionPlanIdsRef.current.has(planId)) {
        pendingActivatedCardIdsRef.current.set(planId, activatedCardIds);
        return;
      }
      acceptReply(activatedCardIds);
    },
    [acceptReply],
  );

  const cancelActiveCardReactionPlan = useCallback(() => {
    const plan = activePlanRef.current;
    if (!plan || !cardReactionPlanIdsRef.current.has(plan.planId)) {
      return false;
    }
    handlePerformanceResult({
      planId: plan.planId,
      completedAt: Date.now(),
      outcome: 'cancelled',
      trigger: plan.trigger,
      intent: plan.intent,
    });
    return true;
  }, [handlePerformanceResult]);

  const executeNonSpeechPlan = useCallback(
    (plan: PerformancePlan) => {
      const expectedSessionGeneration = sessionGeneration;
      handlePerformancePlan(plan);
      if (nonSpeechTimerRef.current !== null) {
        window.clearTimeout(nonSpeechTimerRef.current);
      }
      const timer = window.setTimeout(() => {
        if (nonSpeechTimerRef.current === timer) {
          nonSpeechTimerRef.current = null;
        }
        if (expectedSessionGeneration !== sessionGenerationRef.current) return;
        handlePerformanceResult({
          planId: plan.planId,
          completedAt: Date.now(),
          outcome: 'completed',
          trigger: plan.trigger,
          intent: plan.intent,
          interactionAction: plan.actionDecision?.action,
        });
      }, plan.preReaction?.leadBeforeSpeechMs ?? 0);
      nonSpeechTimerRef.current = timer;
      return true;
    },
    [handlePerformancePlan, handlePerformanceResult, sessionGeneration],
  );

  const cancelNonSpeechPlan = useCallback(() => {
    if (nonSpeechTimerRef.current === null) return;

    window.clearTimeout(nonSpeechTimerRef.current);
    nonSpeechTimerRef.current = null;
    const plan = activePlanRef.current;
    if (!plan) return;

    handlePerformanceResult({
      planId: plan.planId,
      completedAt: Date.now(),
      outcome: 'cancelled',
      trigger: plan.trigger,
      intent: plan.intent,
      interactionAction: plan.actionDecision?.action,
    });
  }, [handlePerformanceResult]);

  const {
    cancelAutonomous,
    error,
    evaluateVoiceParticipation,
    interruptCurrentTurn,
    isBusy,
    isManualBusy,
    reply,
    isSubtitleVisible,
    recordVoiceSignal,
    resetConversation,
    sendAutonomous,
    sendManual,
    sendVoice,
    source,
    status,
  } = useConversation(playbackCoordinator, {
    historyTurnLimit: 5,
    isExhibitionMode,
    isMuted,
    characterIdentity,
    programContext,
    getPerformerStateContext,
    onPerformanceCue: handlePerformanceCue,
    onPerformancePlan: handlePerformancePlan,
    onPerformanceResult: handlePerformanceResult,
    onInteractionAction: handleInteractionAction,
    onInteractionTimelineEvent: handleInteractionTimelineEvent,
    onAutonomyDelta: handleAutonomyDelta,
  });

  const routerResetSessionRef = useRef<(() => void) | null>(null);
  const handleRouterEffects = useCallback((effects: RouterEffect[]) => {
    for (const effect of effects) {
      switch (effect.type) {
        case 'interrupt_vayria':
          interruptCurrentTurn('router_control');
          cancelAutonomous();
          stopReaction();
          stageRef.current?.stopReactionMotion();
          break;
        case 'set_autonomous_enabled':
          setIsAutonomousLoopEnabled(effect.enabled);
          recordAutonomyEvidence({
            id: `router-state:${Date.now()}`,
            kind: 'interaction_state_change',
            at: Date.now(),
            semanticKey: `autonomous-enabled:${effect.enabled}`,
            wakeConditions: effect.enabled
              ? ['floor_available', 'interaction_state_changed']
              : ['interaction_state_changed'],
          });
          notifyMeaningfulAutonomyEvent('router_change');
          break;
        case 'set_gpt_input_gate':
          break;
        case 'set_vayria_output_gate':
          recordAutonomyEvidence({
            id: `router-output-gate:${Date.now()}`,
            kind: 'interaction_state_change',
            at: Date.now(),
            semanticKey: `vayria-output-gate:${effect.gate}`,
            wakeConditions:
              effect.gate === 'open'
                ? ['floor_available', 'interaction_state_changed']
                : ['interaction_state_changed'],
          });
          notifyMeaningfulAutonomyEvent('router_change');
          break;
        case 'reset_vayria':
          routerResetSessionRef.current?.();
          break;
      }
    }
  }, [
    cancelAutonomous,
    interruptCurrentTurn,
    notifyMeaningfulAutonomyEvent,
    recordAutonomyEvidence,
    stopReaction,
  ]);
  const conversationRouter = useConversationRouter({
    enabled: runtimeConfig.routerEnabled,
    onEffects: handleRouterEffects,
  });
  const {
    observe: observeRouterSignal,
    dispatch: dispatchRouterCommand,
    snapshot: routerSnapshot,
  } = conversationRouter;

  useEffect(() => {
    routerObserveSignalRef.current = observeRouterSignal;
    return () => {
      if (routerObserveSignalRef.current === observeRouterSignal) {
        routerObserveSignalRef.current = null;
      }
    };
  }, [observeRouterSignal]);

  const rememberExplicitAlias = useCallback((message: string) => {
    const currentIdentity = characterIdentityRef.current;
    const alias = parseExplicitAliasInstruction(message);
    if (!alias) return currentIdentity;

    const nextIdentity = addCharacterAlias(currentIdentity, alias);
    if (!nextIdentity || !writeCharacterIdentity(nextIdentity)) {
      return currentIdentity;
    }

    characterIdentityRef.current = nextIdentity;
    setCharacterIdentity(nextIdentity);
    return nextIdentity;
  }, []);

  const clearBargeInTimer = useCallback(() => {
    if (bargeInTimerRef.current === null) return;
    window.clearTimeout(bargeInTimerRef.current);
    bargeInTimerRef.current = null;
  }, []);

  const dispatchBargeIn = useCallback(
    (event: BargeInEvent) => {
      const transition = reduceBargeIn(bargeInStateRef.current, event);
      bargeInStateRef.current = transition.state;
      setBargeInState(transition.state);

      if (transition.effects.includes('duck')) {
        clearBargeInTimer();
        setDucked(true);
        voiceLab.handleDiagnostic({
          type: 'barge_in',
          at: Date.now(),
          action: 'duck',
          state: transition.state,
          ttsPlaying,
          reason: transition.reason,
        });
        bargeInTimerRef.current = window.setTimeout(() => {
          bargeInTimerRef.current = null;
          setBargeInTimeoutToken((token) => token + 1);
        }, BARGE_IN_TIMEOUT_MS);
      }

      if (transition.effects.includes('interrupt')) {
        voiceLab.handleDiagnostic({
          type: 'barge_in',
          at: Date.now(),
          action: 'interrupt',
          state: transition.state,
          ttsPlaying,
          reason: transition.reason,
        });
      }

      if (transition.effects.includes('restore')) {
        clearBargeInTimer();
        setDucked(false);
        voiceLab.handleDiagnostic({
          type: 'barge_in',
          at: Date.now(),
          action: 'restore',
          state: transition.state,
          ttsPlaying,
          reason: transition.reason,
        });
      }

      if (transition.effects.length > 0) {
        handleInteractionTimelineEvent({
          kind: 'barge_in',
          at: Date.now(),
          action: transition.effects.join('+'),
          state: transition.state,
          ...(transition.reason ? { reason: transition.reason } : {}),
        });
      }

      return transition;
    },
    [
      clearBargeInTimer,
      handleInteractionTimelineEvent,
      setDucked,
      ttsPlaying,
      voiceLab,
    ],
  );
  const latestDispatchBargeInRef = useRef(dispatchBargeIn);
  useEffect(() => {
    latestDispatchBargeInRef.current = dispatchBargeIn;
  }, [dispatchBargeIn]);

  useEffect(() => {
    if (bargeInTimeoutToken === 0) return;
    dispatchBargeIn({ type: 'timeout' });
  }, [bargeInTimeoutToken, dispatchBargeIn]);

  useEffect(() => {
    if (ttsPlaying) return;
    if (bargeInStateRef.current !== 'candidate') return;
    dispatchBargeIn({ type: 'tts_stopped' });
  }, [dispatchBargeIn, ttsPlaying]);

  useEffect(() => {
    clearBargeInTimer();
    activeBargeInSegmentRef.current = null;
    if (bargeInStateRef.current === 'idle') return;
    latestDispatchBargeInRef.current({ type: 'reset' });
  }, [audioLabMode, clearBargeInTimer]);

  useEffect(() => {
    return () => {
      clearBargeInTimer();
      setDucked(false);
    };
  }, [clearBargeInTimer, setDucked]);

  const displayEmotion = activeEmotionCue?.emotion ?? performer.state.emotion.value;
  const isPerformerBusy = isBusy || activePlan !== null;
  const autonomyCandidate = useMemo(
    () =>
      selectAutonomyCandidate(autonomyState, {
        enabled:
          isAutonomousLoopEnabled &&
          (!runtimeConfig.routerEnabled ||
            (routerSnapshot.controlState === 'idle' &&
              routerSnapshot.vayriaOutputGate === 'open')),
        busy: isPerformerBusy,
        floorAvailable:
          !isVadSpeech &&
          !isSttProcessing &&
          (!runtimeConfig.routerEnabled ||
            (routerSnapshot.controlState === 'idle' &&
              routerSnapshot.vayriaOutputGate === 'open')),
        attentionAvailable: !isCardSelectionActive,
        interactionAvailable: isAvatarReady && !isMuted,
      }),
    [
      autonomyState,
      isAvatarReady,
      isAutonomousLoopEnabled,
      isCardSelectionActive,
      isMuted,
      isPerformerBusy,
      isSttProcessing,
      isVadSpeech,
      routerSnapshot.controlState,
      routerSnapshot.vayriaOutputGate,
    ],
  );
  const autonomyCandidateKey = autonomyCandidate
    ? `${autonomyCandidate.episodeId}:${autonomyCandidate.reasons
        .map((reason) => reason.id)
        .join(',')}:${autonomyCandidate.decisionEvidenceIds.join(',')}`
    : null;
  const autonomyCandidateTelemetry: AutonomyCandidateTelemetry | null =
    autonomyCandidate
      ? {
          episodeId: autonomyCandidate.episodeId,
          reasonIds: autonomyCandidate.reasons.map((reason) => reason.id),
          decisionEvidenceIds: autonomyCandidate.decisionEvidenceIds,
        }
      : null;
  const autonomyTurnGateTiming = useMemo(
    () => readAutonomyTurnGateTiming(performerProfile),
    [performerProfile],
  );
  const exhibitionPresentationState: ExhibitionPresentationState = isPerformerBusy
    ? 'reacting'
    : isCardSelectionActive
      ? 'selecting'
      : 'idle';
  const trimmedInput = input.trim();
  const volumePercent = Math.round(volume * 100);
  const conversationStatusLabel =
    status === 'idle'
      ? getVoiceStatusLabel(isVoiceInputEnabled, voiceInputPhase)
      : STATUS_LABELS[status];
  const shouldShowReply =
    Boolean(reply) && (!isExhibitionMode || isSubtitleVisible);
  const voiceError = getVoiceErrorMessage(voiceInputErrorCode);
  const conversationError = error || voiceValidationError || voiceError;
  const displayedAudioLevel = isVoiceInputEnabled ? audioLevel : null;
  const displayedNoiseFloor = isVoiceInputEnabled ? noiseFloor : null;
  const browserGateAvailable =
    audioLabMode === 'processed-vad' ||
    ((audioLabMode === 'processed' || audioLabMode === 'exhibition-mix') &&
      runtimeConfig.audioPreset !== 'off');
  const displayThreshold = browserGateAvailable
    ? (effectiveThreshold ?? vadThreshold)
    : null;
  const audioLevelPercent =
    displayedAudioLevel === null
      ? 0
      : Math.min(100, (displayedAudioLevel / 0.1) * 100);
  const thresholdPercent =
    displayThreshold === null
      ? null
      : Math.min(100, (displayThreshold / 0.1) * 100);
  const microphoneStatusLabel = voiceError
    ? 'マイクを確認'
    : isSttProcessing
      ? '判定中'
      : isVadSpeech
        ? '聞き取り中'
        : !isVoiceInputEnabled
          ? '待機中'
          : displayedAudioLevel === null
            ? '入力待ち'
            : displayThreshold !== null &&
                displayedAudioLevel < displayThreshold
              ? '反応ライン未満'
              : '入力あり';
  useEffect(() => {
    const logicalAttentionTarget =
      cardAttentionTarget ??
      (activePlan !== null
        ? activePlan.preReaction?.gaze?.target ??
          performer.state.attention.target
        : listeningReaction?.target ?? 'none');
    logicalAttentionRef.current = {
      ...performer.state.attention,
      target: logicalAttentionTarget,
      strength:
        cardAttentionTarget !== null || listeningReaction
          ? 1
          : activePlan !== null
            ? Math.max(0.72, performer.state.attention.strength)
            : 0,
      position: null,
      confidence: 0,
    };
  }, [
    activePlan,
    cardAttentionTarget,
    listeningReaction,
    performer.state.attention,
  ]);
  const cameraAttentionStatusMessage = getCameraAttentionStatusMessage(
    cameraAttentionStatus,
    cameraAttentionErrorCode,
  );
  const cameraAttentionEnabled = cameraAttentionStatus === 'active';
  const handleCameraAttentionToggle = useCallback(() => {
    if (
      cameraAttentionStatus === 'active' ||
      cameraAttentionStatus === 'starting'
    ) {
      stopCameraAttention();
      return;
    }
    void startCameraAttention();
  }, [
    cameraAttentionStatus,
    startCameraAttention,
    stopCameraAttention,
  ]);
  const exhibitionAudioActionLabel = voiceError
    ? '音声とマイクを再試行'
    : isVoiceInputEnabled
      ? '音声入力を停止'
      : '音声とマイクを有効化';
  const shouldShowAudioUnlockControl =
    !isExhibitionMode ||
    !isAudioUnlocked ||
    !isVoiceInputEnabled ||
    Boolean(voiceError);

  const resetSession = useCallback(() => {
    const nextGeneration = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = nextGeneration;

    stopVoiceInput();
    clearBargeInTimer();
    activeBargeInSegmentRef.current = null;
    routerBlockedSegmentRef.current = null;
    if (bargeInStateRef.current !== 'idle') {
      dispatchBargeIn({ type: 'reset' });
    } else {
      setDucked(false);
    }
    stopReaction();
    stageRef.current?.stopReactionMotion();
    setListeningReaction(undefined);
    backchannelVariantIndexRef.current = { un: null, uun: null };

    if (nonSpeechTimerRef.current !== null) {
      window.clearTimeout(nonSpeechTimerRef.current);
      nonSpeechTimerRef.current = null;
    }

    if (cardAttentionTimerRef.current !== null) {
      window.clearTimeout(cardAttentionTimerRef.current);
      cardAttentionTimerRef.current = null;
    }
    setCardAttentionTarget(null);

    resetConversation();
    resetRuntime();
    resetTurn();
    cardReactionPlanIdsRef.current.clear();
    pendingActivatedCardIdsRef.current.clear();
    activePlanRef.current = null;
    setActivePlan(null);
    setActiveEmotionCue(null);
    setAutonomousContext(INITIAL_AUTONOMOUS_CONTEXT);
    const initialAutonomyState = createInitialAutonomyState();
    autonomyStateRef.current = initialAutonomyState;
    setAutonomyState(initialAutonomyState);
    pendingCardStimulusRef.current = null;
    setProgramPhase(DEFAULT_PROGRAM_CONTEXT.phase);
    setInput('');
    setIsAutonomousLoopEnabled(true);
    setSessionGeneration(nextGeneration);
  }, [
    clearBargeInTimer,
    dispatchBargeIn,
    resetConversation,
    resetRuntime,
    resetTurn,
    setProgramPhase,
    setDucked,
    stopReaction,
    stopVoiceInput,
  ]);

  useEffect(() => {
    routerResetSessionRef.current = resetSession;
    return () => {
      if (routerResetSessionRef.current === resetSession) {
        routerResetSessionRef.current = null;
      }
    };
  }, [resetSession]);

  const handleSessionReset = useCallback(() => {
    if (runtimeConfig.routerEnabled) {
      dispatchRouterCommand({ type: 'reset' });
      return;
    }
    resetSession();
  }, [dispatchRouterCommand, resetSession]);

  const handleCardInteraction = useCallback(() => {
    if (!isExhibitionMode) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    if (!shouldReactToCardInteraction()) return;

    setCardAttentionTarget('game');
    if (cardAttentionTimerRef.current !== null) {
      window.clearTimeout(cardAttentionTimerRef.current);
    }
    const timerId = window.setTimeout(() => {
      if (cardAttentionTimerRef.current !== timerId) return;
      cardAttentionTimerRef.current = null;
      setCardAttentionTarget(null);
    }, CARD_INTERACTION_ATTENTION_DURATION_MS);
    cardAttentionTimerRef.current = timerId;
  }, [isExhibitionMode]);

  useEffect(() => {
    const serialized = JSON.stringify({ volume, lastAudibleVolume });
    for (const storageKey of [
      AUDIO_SETTINGS_STORAGE_KEY,
      LEGACY_AUDIO_SETTINGS_STORAGE_KEY,
    ]) {
      try {
        localStorage.setItem(storageKey, serialized);
      } catch {
        // Playback remains usable when storage is unavailable.
      }
    }
  }, [lastAudibleVolume, volume]);

  useEffect(() => {
    if (!runtimeConfig.routerEnabled) return;
    try {
      if (routerAudioInputDeviceId) {
        localStorage.setItem(
          ROUTER_AUDIO_INPUT_DEVICE_STORAGE_KEY,
          routerAudioInputDeviceId,
        );
      } else {
        localStorage.removeItem(ROUTER_AUDIO_INPUT_DEVICE_STORAGE_KEY);
      }
    } catch {
      // Remote PCM remains usable when local settings storage is unavailable.
    }
  }, [routerAudioInputDeviceId]);

  useEffect(() => {
    if (status === 'idle' && activePlanRef.current !== null) return;
    const phase =
      status === 'thinking'
        ? 'waiting'
        : status === 'synthesizing'
          ? 'synthesizing'
          : status === 'speaking'
            ? 'speaking'
            : status === 'error'
              ? 'error'
              : 'idle';
    setPhase(phase);
  }, [setPhase, status]);

  useEffect(() => {
    if (!runtimeConfig.routerEnabled) return;
    observeRouterSignal({
      type: 'vayria_status',
      status,
      voiceInputEnabled: isVoiceInputEnabled,
    });
  }, [isVoiceInputEnabled, observeRouterSignal, status]);

  useEffect(() => {
    return () => {
      if (nonSpeechTimerRef.current !== null) {
        window.clearTimeout(nonSpeechTimerRef.current);
      }
      if (cardAttentionTimerRef.current !== null) {
        window.clearTimeout(cardAttentionTimerRef.current);
      }
    };
  }, []);

  const readCardContext = useCallback(
    () => ({
      brainCardIds: zones.brain.map((card) => card.id),
      forcedCardId: zones.forcedCardId,
    }),
    [zones.brain, zones.forcedCardId],
  );

  const getDirectionContribution = useCallback(
    (trigger: PerformerTrigger) =>
      getWildcardContribution(trigger, Date.now()),
    [getWildcardContribution],
  );

  const createPlanForTrigger = useCallback(
    (
      trigger: PerformerTrigger,
      contribution = getDirectionContribution(trigger),
    ) => createPlan(trigger, [contribution]),
    [createPlan, getDirectionContribution],
  );

  const preloadBackchannel = useCallback(() => {
    if (backchannelAudioRef.current.length > 0 || backchannelLoadingRef.current) {
      return;
    }

    const loading = fetchListeningBackchannels()
      .then((audioData) => {
        backchannelAudioRef.current = audioData;
      })
      .catch(() => {
        // Voice input and visual reactions remain usable without the cue audio.
      })
      .finally(() => {
        backchannelLoadingRef.current = null;
      });
    backchannelLoadingRef.current = loading;
  }, []);

  useEffect(() => {
    preloadBackchannel();
  }, [preloadBackchannel]);

  const handleVoiceEvent = useCallback(
    (event: VoiceInputEvent) => {
      if (runtimeConfig.routerEnabled) {
        if (event.type === 'speech_started') {
          if (routerSnapshot.gptInputGate === 'closed') {
            routerBlockedSegmentRef.current = event.segmentId;
            observeRouterSignal({
              type: 'gpt_audio',
              event: 'speech_started',
            }, event.at);
            return;
          }
          observeRouterSignal(
            { type: 'voice_input', event: 'speech_started' },
            event.at,
          );
        } else if (
          routerBlockedSegmentRef.current !== null &&
          ('segmentId' in event
            ? event.segmentId === routerBlockedSegmentRef.current
            : true)
        ) {
          if (event.type === 'speech_ended' || event.type === 'utterance_finalized') {
            observeRouterSignal(
              { type: 'gpt_audio', event: 'speech_ended' },
              event.at,
            );
            routerBlockedSegmentRef.current = null;
          }
          if (
            event.type === 'speech_ended' ||
            event.type === 'utterance_finalized' ||
            event.type === 'interim_transcript_updated'
          ) {
            return;
          }
        } else if (
          event.type === 'listening_started' ||
          event.type === 'speech_ended' ||
          event.type === 'utterance_finalized' ||
          event.type === 'recognition_stopped' ||
          event.type === 'recognition_failed'
        ) {
          observeRouterSignal(
            { type: 'voice_input', event: event.type },
            event.at,
          );
        }
      }
      recordVoiceSignal(event);
      switch (event.type) {
        case 'speech_started': {
          recordAutonomyEvidence({
            id: `voice-floor:${event.segmentId}:started`,
            kind: 'interaction_state_change',
            at: event.at,
            semanticKey: 'floor:user-speaking',
          });
          // Speech detection is only a candidate. Final text decides turn handoff.
          const isBargeInCandidate = ttsPlaying;
          if (isBargeInCandidate) {
            activeBargeInSegmentRef.current = event.segmentId;
          } else {
            activeBargeInSegmentRef.current = null;
          }
          setVoiceValidationError('');
          dispatchBargeIn({
            type: 'speech_started',
            ttsPlaying,
          });
          // A speech start is still only an acoustic candidate. Do not show a
          // participation cue until the finalized turn selects a reaction.
          return;
        }
        case 'speech_ended':
          recordAutonomyEvidence({
            id: `voice-floor:${event.segmentId}:available`,
            kind: 'interaction_state_change',
            at: event.at,
            semanticKey: 'floor:available',
            wakeConditions: ['floor_available', 'interaction_state_changed'],
          });
          return;
        case 'utterance_finalized': {
          stopReaction();
          stageRef.current?.stopReactionMotion();
          setListeningReaction(undefined);
          const message = event.text.trim();
          const candidateSegmentId = activeBargeInSegmentRef.current;
          activeBargeInSegmentRef.current = null;
          const isSpeakingCandidate = candidateSegmentId === event.segmentId;
          const acceptedForBargeIn = isConfirmedBargeInTranscript(message, {
            characterIdentity: characterIdentityRef.current,
            requireConversationalCue: isSpeakingCandidate,
          });
          if (candidateSegmentId !== null) {
            observeRouterSignal(
              {
                type: 'barge_in_decision',
                accepted: acceptedForBargeIn,
              },
              event.at,
            );
          }
          const bargeInTransition = dispatchBargeIn({
            type: 'transcript_finalized',
            accepted: acceptedForBargeIn,
          });
          if (
            isRejectedBargeInCandidate(
              candidateSegmentId,
              event.segmentId,
              bargeInTransition,
            )
          ) {
            setVoiceValidationError('');
            return;
          }
          if (!message) {
            setVoiceValidationError('');
            return;
          }
          if (message.length > MAX_VOICE_TEXT_LENGTH) {
            setVoiceValidationError(
              `音声入力は${MAX_VOICE_TEXT_LENGTH}文字以内で送信してください。`,
            );
            return;
          }

          setVoiceValidationError('');
          let voiceAutonomyEvidenceContext: AutonomyEvidenceContext | undefined;
          if (isContentBearingVoiceMessage(message)) {
            const semanticKey = `conversation:${message
              .normalize('NFKC')
              .replace(/\s+/gu, ' ')
              .trim()
              .slice(0, 96)}`;
            const evidenceId = `voice-evidence:${event.segmentId}`;
            const nextAutonomyState = recordAutonomyEvidence({
              id: evidenceId,
              kind: 'conversation_input',
              at: event.at,
              semanticKey,
              content: message,
              wakeConditions: ['new_evidence', 'floor_available'],
              reasonProposals: [
                {
                  kind: 'conversation_continuation',
                  content: message,
                  semanticKey,
                  salience: /[?？]/u.test(message) ? 0.9 : 0.68,
                },
              ],
            });
            notifyMeaningfulAutonomyEvent('viewer_speech');
            voiceAutonomyEvidenceContext =
              readAutonomyEvidenceContext(nextAutonomyState, evidenceId) ??
              undefined;
          }
          cancelNonSpeechPlan();
          cancelActiveCardReactionPlan();
          const identityForRequest = rememberExplicitAlias(message);
          const confirmedBargeIn =
            bargeInTransition?.effects.includes('interrupt') ?? false;
          if (confirmedBargeIn) {
            interruptCurrentTurn('voice_barge_in');
            dispatchBargeIn({ type: 'reset' });
          } else if (
            shouldInterruptBusyTurn(
              acceptedForBargeIn,
              isBusy,
              activePlanRef.current !== null,
            )
          ) {
            interruptCurrentTurn('voice_interrupt');
          }
          const participation = evaluateVoiceParticipation(
            {
              segmentId: event.segmentId,
              text: message,
              speakerId: event.speakerId,
              at: event.at,
            },
            identityForRequest,
          );
          if (
            participation.mode === 'multi_party' &&
            participation.decision === 'SILENT'
          ) {
            return;
          }
          setAutonomousContext((current) =>
            recordViewerIntent(current, message, identityForRequest),
          );
          const trigger: PerformerTrigger = {
            kind: 'viewer_message',
            text: message,
          };
          const plan = createPlanForTrigger(trigger);
          if (
            !plan.actionDecision ||
            plan.actionDecision.action === 'take_floor'
          ) {
            beginReply();
          }
          if (!isMuted) void prepare();
          void sendVoice(
            message,
            readCardContext(),
            handleReplyAccepted,
            plan,
            { segmentId: event.segmentId, at: event.at, asrConfidence: null },
            identityForRequest,
            undefined,
            voiceAutonomyEvidenceContext,
          );
          return;
        }
        case 'recognition_stopped':
        case 'recognition_failed':
          dispatchBargeIn({
            type:
              event.type === 'recognition_stopped'
                ? 'recognition_stopped'
                : 'recognition_failed',
          });
          activeBargeInSegmentRef.current = null;
          routerBlockedSegmentRef.current = null;
          stopReaction();
          stageRef.current?.stopReactionMotion();
          setListeningReaction(undefined);
          return;
        case 'listening_started':
        case 'interim_transcript_updated':
          return;
      }
    },
    [
      beginReply,
      cancelActiveCardReactionPlan,
      cancelNonSpeechPlan,
      createPlanForTrigger,
      dispatchBargeIn,
      evaluateVoiceParticipation,
      handleReplyAccepted,
      interruptCurrentTurn,
      isBusy,
      isMuted,
      notifyMeaningfulAutonomyEvent,
      observeRouterSignal,
      prepare,
      recordAutonomyEvidence,
      recordVoiceSignal,
      readCardContext,
      readAutonomyEvidenceContext,
      rememberExplicitAlias,
      sendVoice,
      ttsPlaying,
      stopReaction,
      routerSnapshot.gptInputGate,
    ],
  );

  useEffect(() => {
    voiceEventHandlerRef.current = handleVoiceEvent;
    return () => {
      voiceEventHandlerRef.current = null;
    };
  }, [handleVoiceEvent]);

  const startAutonomous = useCallback(
    async (options: {
      cardContextOverride?: ChatCardContext;
      contribution?: DirectionContribution;
      programContextOverride?: ProgramContext;
      trigger?: PerformerTrigger;
      candidate?: AutonomyCandidate;
    } = {}) => {
      const expectedSessionGeneration = sessionGeneration;
      const isCurrentSession = () =>
        expectedSessionGeneration === sessionGenerationRef.current;

      if (
        !isCurrentSession() ||
        !isAutonomousLoopEnabled ||
        (runtimeConfig.routerEnabled &&
          (routerSnapshot.controlState !== 'idle' ||
            routerSnapshot.vayriaOutputGate === 'closed')) ||
        isMuted ||
        isBusy ||
        Boolean(activePlanRef.current)
      ) {
        return 'aborted' as AutonomousTurnOutcome;
      }

      const candidate = options.candidate ?? autonomyCandidate;
      if (!candidate) return 'aborted' as AutonomousTurnOutcome;
      const stimulus = pendingCardStimulusRef.current;
      pendingCardStimulusRef.current = null;
      const cardContextOverride =
        options.cardContextOverride ?? stimulus?.cardContext;
      const contribution = options.contribution ?? stimulus?.contribution;
      const programContextOverride =
        options.programContextOverride ?? stimulus?.programContext;
      const offeredState = markCandidateOffered(
        autonomyStateRef.current,
        candidate,
      );
      autonomyStateRef.current = offeredState;
      setAutonomyState(offeredState);
      const trigger: PerformerTrigger =
        options.trigger ?? {
          kind: 'autonomous_candidate',
          episodeId: candidate.episodeId,
          reasonIds: candidate.reasons.map((reason) => reason.id),
        };
      const isForcedCardTurn =
        contribution?.directionId === 'wildcard' &&
        cardContextOverride?.forcedCardId !== null &&
        cardContextOverride?.forcedCardId !== undefined;
      const preactivatedPlan: PerformancePlan | null = isForcedCardTurn
        ? createPlanForTrigger(
            trigger,
            contribution ?? getDirectionContribution(trigger),
          )
        : null;

      if (preactivatedPlan) {
        cardReactionPlanIdsRef.current.add(preactivatedPlan.planId);
        handlePerformancePlan(preactivatedPlan);
      }

      const cancelPreactivatedPlan = () => {
        if (!preactivatedPlan) return;
        const currentActivePlan: PerformancePlan | null =
          activePlanRef.current;
        if (currentActivePlan?.planId !== preactivatedPlan.planId) {
          cardReactionPlanIdsRef.current.delete(preactivatedPlan.planId);
          pendingActivatedCardIdsRef.current.delete(preactivatedPlan.planId);
          return;
        }
        handlePerformanceResult({
          planId: preactivatedPlan.planId,
          completedAt: Date.now(),
          outcome: 'cancelled',
          trigger: preactivatedPlan.trigger,
          intent: preactivatedPlan.intent,
        });
      };

      if (isExhibitionMode) {
        const audioReady = await prepare();
        if (!audioReady || !isCurrentSession()) {
          cancelPreactivatedPlan();
          return 'aborted' as AutonomousTurnOutcome;
        }
      } else {
        void prepare();
      }
      const currentActivePlan: PerformancePlan | null =
        activePlanRef.current;
      const keepsPreactivatedPlan =
        preactivatedPlan !== null &&
        currentActivePlan !== null &&
        currentActivePlan.planId === preactivatedPlan.planId;
      if (
        !isCurrentSession() ||
        isMuted ||
        isBusy ||
        (preactivatedPlan === null
          ? activePlanRef.current !== null
          : !keepsPreactivatedPlan)
      ) {
        cancelPreactivatedPlan();
        return 'aborted' as AutonomousTurnOutcome;
      }
      const plan =
        preactivatedPlan ??
        createPlanForTrigger(
          trigger,
          contribution ?? getDirectionContribution(trigger),
        );
      if (plan.intent !== 'speak') {
        return executeNonSpeechPlan(plan)
          ? ('none' as AutonomousTurnOutcome)
          : ('aborted' as AutonomousTurnOutcome);
      }
      beginReply();
      const decision = await sendAutonomous(
        cardContextOverride ?? readCardContext(),
        autonomousContext,
        handleReplyAccepted,
        plan,
        programContextOverride,
        candidate,
      );
      if (!decision || !isCurrentSession()) {
        return 'aborted' as AutonomousTurnOutcome;
      }
      emitAutonomyGateEvent({
        gateEvent: 'turn_result',
        gatePhase: 'running',
        transition: 'ignored',
        candidateEpisodeId: candidate.episodeId,
        candidateReasonIds: candidate.reasons.map((reason) => reason.id),
        candidateEvidenceIds: candidate.decisionEvidenceIds,
        usedReasonIds: decision.usedReasonIds,
        externalAction: decision.externalAction,
      });
      let nextState = autonomyStateRef.current;
      if (decision.externalAction === 'speak') {
        nextState = resolveUsedReasons(
          nextState,
          decision.usedReasonIds,
          candidate.episodeId,
        );
      }
      nextState = completeInactiveEpisodes(nextState);
      autonomyStateRef.current = nextState;
      setAutonomyState(nextState);
      return decision.externalAction === 'speak' ? 'speak' : 'none';
    },
    [
      autonomousContext,
      autonomyCandidate,
      beginReply,
      createPlanForTrigger,
      executeNonSpeechPlan,
      getDirectionContribution,
      handlePerformancePlan,
      handlePerformanceResult,
      handleReplyAccepted,
      isAutonomousLoopEnabled,
      isExhibitionMode,
      isBusy,
      isMuted,
      prepare,
      readCardContext,
      routerSnapshot.controlState,
      routerSnapshot.vayriaOutputGate,
      sendAutonomous,
      sessionGeneration,
    ],
  );

  const handleCardInserted = useCallback(
    (result: CardSwapResult) => {
      setProgramPhase('after_card_change');
      const contribution = activateCardSwap(result);
      recordAutonomyEvidence({
        id: `card-evidence:${result.animationSequence}`,
        kind: 'environment_change',
        at: Date.now(),
        semanticKey: `card:${result.insertedCardId}`,
        content: `カードが変わりました: ${result.insertedCardId}`,
        wakeConditions: ['new_evidence', 'interaction_state_changed'],
        reasonProposals: [
          {
            kind: 'environment_change',
            content: `カードが変わりました: ${result.insertedCardId}`,
            semanticKey: `card:${result.insertedCardId}`,
            salience: 0.82,
          },
        ],
      });
      notifyMeaningfulAutonomyEvent('card_change');
      if (!isAutonomousLoopEnabled || isMuted || isBusy) return;
      pendingCardStimulusRef.current = {
        cardContext: {
          brainCardIds: result.brainCardIds,
          forcedCardId: result.forcedCardId,
        },
        contribution,
        programContext: {
          ...programContext,
          phase: 'after_card_change',
        },
      };
    },
    [
      activateCardSwap,
      isAutonomousLoopEnabled,
      isBusy,
      isMuted,
      notifyMeaningfulAutonomyEvent,
      programContext,
      recordAutonomyEvidence,
      setProgramPhase,
    ],
  );

  const handleVoiceToggle = useCallback(async () => {
    if (isVoiceInputEnabled) {
      await stopVoiceInput();
      return;
    }

    if (!(await startVoiceInput())) return;
    void prepare();
    preloadBackchannel();
  }, [
    isVoiceInputEnabled,
    preloadBackchannel,
    prepare,
    startVoiceInput,
    stopVoiceInput,
  ]);

  useAutonomousTalk({
    cancelAutonomous,
    candidateKey: autonomyCandidateKey,
    candidateTelemetry: autonomyCandidateTelemetry,
    externalEventSignal: autonomyExternalEvent,
    hasCandidate: autonomyCandidate !== null,
    isBusy: isPerformerBusy,
    isVoiceActivityActive: isVadSpeech || isSttProcessing,
    isLoopEnabled: isAutonomousLoopEnabled,
    isMuted,
    isReady:
      isAvatarReady && (!isExhibitionMode || isAudioUnlocked),
    onCandidate: startAutonomous,
    onGateEvent: emitAutonomyGateEvent,
    sessionGeneration,
    timing: autonomyTurnGateTiming,
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedInput || isManualBusy) return;
    if (
      runtimeConfig.routerEnabled &&
      routerSnapshot.vayriaOutputGate === 'closed' &&
      routerSnapshot.controlState !== 'human_override'
    ) {
      return;
    }
    if (
      !runtimeConfig.routerEnabled ||
      routerSnapshot.controlState !== 'human_override'
    ) {
      setIsAutonomousLoopEnabled(true);
    }
    stopReaction();
    stageRef.current?.stopReactionMotion();
    if (source === 'autonomous') cancelAutonomous();
    cancelNonSpeechPlan();
    cancelActiveCardReactionPlan();
    const trigger: PerformerTrigger = {
      kind: 'viewer_message',
      text: trimmedInput,
    };
    const identityForRequest = rememberExplicitAlias(trimmedInput);
    let manualAutonomyEvidenceContext: AutonomyEvidenceContext | undefined;
    if (isContentBearingVoiceMessage(trimmedInput)) {
      const semanticKey = `conversation:${trimmedInput
        .normalize('NFKC')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 96)}`;
      const evidenceId = `manual-evidence:${Date.now()}`;
      const nextAutonomyState = recordAutonomyEvidence({
        id: evidenceId,
        kind: 'conversation_input',
        at: Date.now(),
        semanticKey,
        content: trimmedInput,
        wakeConditions: ['new_evidence', 'floor_available'],
        reasonProposals: [
          {
            kind: 'conversation_continuation',
            content: trimmedInput,
            semanticKey,
            salience: /[?？]/u.test(trimmedInput) ? 0.9 : 0.68,
          },
        ],
      });
      notifyMeaningfulAutonomyEvent('viewer_speech');
      manualAutonomyEvidenceContext =
        readAutonomyEvidenceContext(nextAutonomyState, evidenceId) ?? undefined;
    }
    setAutonomousContext((current) =>
      recordViewerIntent(current, trimmedInput, identityForRequest),
    );
    const plan = createPlanForTrigger(trigger);
    if (!plan.actionDecision || plan.actionDecision.action === 'take_floor') {
      beginReply();
    }
    if (!isMuted) void prepare();
    setInput('');
    void sendManual(
      trimmedInput,
      readCardContext(),
      handleReplyAccepted,
      plan,
      identityForRequest,
      undefined,
      manualAutonomyEvidenceContext,
    );
  };

  const handleMuteToggle = () => {
    if (isMuted) {
      const restoredVolume = volume > 0 ? volume : lastAudibleVolume;
      void prepare();
      setAudioControl({
        isMuted: false,
        lastAudibleVolume: restoredVolume,
        volume: restoredVolume,
      });
    } else {
      stop();
      setAudioControl((current) => ({ ...current, isMuted: true }));
    }
  };

  const handleExhibitionAudioUnlock = useCallback(async () => {
    if (isMuted) {
      const restoredVolume = volume > 0 ? volume : lastAudibleVolume;
      setAudioControl({
        isMuted: false,
        lastAudibleVolume: restoredVolume,
        volume: restoredVolume,
      });
    }

    const audioReadyPromise = prepare();
    const voiceStartedPromise = startVoiceInput();
    const [, voiceStarted] = await Promise.all([
      audioReadyPromise,
      voiceStartedPromise,
    ]);
    if (voiceStarted) preloadBackchannel();
  }, [
    isMuted,
    lastAudibleVolume,
    preloadBackchannel,
    prepare,
    startVoiceInput,
    volume,
  ]);

  const handleExhibitionAudioToggle = useCallback(async () => {
    if (isVoiceInputEnabled && !voiceError) {
      await stopVoiceInput();
      return;
    }
    await handleExhibitionAudioUnlock();
  }, [
    handleExhibitionAudioUnlock,
    isVoiceInputEnabled,
    stopVoiceInput,
    voiceError,
  ]);

  const handleVolumeInput = (event: FormEvent<HTMLInputElement>) => {
    const inputVolume = Number(event.currentTarget.value) / 100;
    if (!Number.isFinite(inputVolume)) return;
    const nextVolume = Math.max(0, Math.min(inputVolume, 1));
    if (nextVolume === 0) {
      stop();
      setAudioControl((current) => ({
        ...current,
        isMuted: true,
        volume: 0,
      }));
      return;
    }

    if (isMuted) void prepare();
    setAudioControl({
      isMuted: false,
      lastAudibleVolume: nextVolume,
      volume: nextVolume,
    });
  };

  const handleAvatarReady = useCallback(() => {
    void prepare();
    setStageMotionPort(stageRef.current);
    setIsAvatarReady(true);
  }, [prepare]);

  return (
    <main
      className="app-shell"
      data-app-mode={runtimeConfig.mode}
      data-exhibition-state={exhibitionPresentationState}
    >
      {(shouldShowAudioUnlockControl || isExhibitionMode) && (
        <header className="app-title">
          {!isExhibitionMode && <span>Vayria</span>}
          <div
            className="audio-controls"
            aria-label="音声コントロール"
            role="group"
          >
            {isExhibitionMode ? (
              <>
                <button
                  aria-label={`${exhibitionAudioActionLabel}する`}
                  aria-pressed={isVoiceInputEnabled}
                  className="audio-unlock-button"
                  data-state={
                    voiceError
                      ? 'error'
                      : isVoiceInputEnabled
                        ? 'on'
                        : 'off'
                  }
                  onClick={handleExhibitionAudioToggle}
                  title={`${exhibitionAudioActionLabel}します`}
                  type="button"
                >
                  <MicrophoneIcon />
                  <span className="control-state" aria-hidden="true">
                    {isVoiceInputEnabled ? 'ON' : 'OFF'}
                  </span>
                  <span className="visually-hidden">
                    {exhibitionAudioActionLabel}
                  </span>
                </button>
                <div
                  className="attention-controls"
                  aria-label="視線追従コントロール"
                  role="group"
                >
                  <button
                    aria-label={
                      cameraAttentionEnabled
                        ? '視線追従を停止する'
                        : '視線追従を有効化する'
                    }
                    aria-pressed={cameraAttentionEnabled}
                    className="attention-button"
                    data-state={cameraAttentionEnabled ? 'on' : 'off'}
                    onClick={handleCameraAttentionToggle}
                    title={cameraAttentionStatusMessage || '視線追従を有効化します'}
                    type="button"
                  >
                    <EyeIcon />
                    <span className="control-state" aria-hidden="true">
                      {cameraAttentionEnabled ? 'ON' : 'OFF'}
                    </span>
                    <span className="visually-hidden">
                      {cameraAttentionStatus === 'starting'
                        ? '視線追従を準備中…'
                        : cameraAttentionEnabled
                          ? '視線追従を停止'
                          : '視線追従を有効化'}
                    </span>
                  </button>
                  {cameraAttentionStatusMessage &&
                    cameraAttentionStatus !== 'idle' && (
                      <span
                        className="attention-status"
                        role="status"
                        aria-live="polite"
                      >
                        {cameraAttentionStatusMessage}
                      </span>
                    )}
                </div>
                <section
                  aria-label="マイク感度"
                  className="microphone-sensitivity"
                >
                  <div className="microphone-sensitivity__heading">
                    <span>マイク感度</span>
                    <span
                      className="microphone-sensitivity__status"
                      data-state={voiceError ? 'error' : isVoiceInputEnabled ? 'on' : 'off'}
                    >
                      {microphoneStatusLabel}
                    </span>
                  </div>
                  <div
                    aria-label="マイク入力レベル"
                    aria-valuemax={0.1}
                    aria-valuemin={0}
                    aria-valuenow={displayedAudioLevel ?? 0}
                    aria-valuetext={
                      displayedAudioLevel === null
                        ? '入力レベル未取得'
                        : `入力レベル ${displayedAudioLevel.toFixed(3)}`
                    }
                    className="microphone-meter"
                    role="meter"
                  >
                    <span
                      className="microphone-meter__fill"
                      style={{ width: `${audioLevelPercent}%` }}
                    />
                    {thresholdPercent !== null && (
                      <span
                        aria-hidden="true"
                        className="microphone-meter__threshold"
                        style={{ left: `${thresholdPercent}%` }}
                      />
                    )}
                  </div>
                  <div className="microphone-sensitivity__reading">
                    <span>
                      入力{' '}
                      {displayedAudioLevel === null
                        ? '—'
                        : displayedAudioLevel.toFixed(3)}
                    </span>
                    <span>
                      反応ライン{' '}
                      {displayThreshold === null
                        ? '—'
                        : displayThreshold.toFixed(3)}
                    </span>
                  </div>
                  <label
                    className="microphone-sensitivity__slider"
                    htmlFor="exhibition-microphone-sensitivity"
                  >
                    <span>
                      反応感度
                      <output htmlFor="exhibition-microphone-sensitivity">
                        {vadThreshold.toFixed(3)}
                      </output>
                    </span>
                    <input
                      aria-label="マイクの反応感度"
                      aria-valuetext={
                        `反応ライン ${displayThreshold?.toFixed(3) ?? 'なし'}`
                      }
                      disabled={!browserGateAvailable}
                      id="exhibition-microphone-sensitivity"
                      max={VAD_THRESHOLD_MAX}
                      min={VAD_THRESHOLD_MIN}
                      onChange={(event) =>
                        handleVadThresholdChange(Number(event.target.value))
                      }
                      step={VAD_THRESHOLD_STEP}
                      type="range"
                      value={vadThreshold}
                    />
                    <span className="microphone-sensitivity__scale">
                      <span>敏感</span>
                      <span>鈍感</span>
                    </span>
                  </label>
                  <p className="microphone-sensitivity__hint">
                    {browserGateAvailable
                      ? `ノイズ基準 ${displayedNoiseFloor === null ? '—' : displayedNoiseFloor.toFixed(3)}`
                      : '自動ゲートなし'}
                  </p>
                </section>
              </>
            ) : (
              <>
                <button
                  aria-label={
                    isMuted ? '音声をオンにする' : '音声をミュートする'
                  }
                  aria-pressed={isMuted}
                  className="mute-button"
                  onClick={handleMuteToggle}
                  title={isMuted ? 'Muted' : 'Autonomous talk active'}
                  type="button"
                >
                  <span aria-hidden="true">{isMuted ? '🔇' : '🔊'}</span>
                </button>
                <label className="visually-hidden" htmlFor="playback-volume">
                  再生音量
                </label>
                <input
                  aria-valuetext={
                    isMuted
                      ? `ミュート中、設定音量 ${volumePercent}%`
                      : `音量 ${volumePercent}%`
                  }
                  className="volume-slider"
                  id="playback-volume"
                  max="100"
                  min="0"
                  onInput={handleVolumeInput}
                  step="5"
                  type="range"
                  value={volumePercent}
                />
                <span className="volume-value" aria-hidden="true">
                  {volumePercent}%
                </span>
              </>
            )}
          </div>
        </header>
      )}

      <section className="avatar-area" aria-label="VRM character">
        <VrmStage
          attentionReader={readAttention}
          emotion={displayEmotion}
          isExhibitionMode={isExhibitionMode}
          listeningReaction={listeningReaction}
          mouthOpen={mouthOpen}
          onReady={handleAvatarReady}
          performancePlan={activePlan ?? undefined}
          ref={stageRef}
          sessionGeneration={sessionGeneration}
        />
        {isExhibitionMode && (
          <aside className="exhibition-copy" aria-label="展示案内">
            <p className="exhibition-copy__title">Vayriaに一枚、どうぞ。</p>
            <p className="exhibition-copy__hint">
              気になるカードを一枚、Vayriaの脳内へ。
            </p>
          </aside>
        )}
        <CardGamePrototype
          game={cardGame}
          isResetLocked={isPerformerBusy}
          onCardInteraction={handleCardInteraction}
          onCardInserted={handleCardInserted}
          onSessionReset={handleSessionReset}
          onSelectionActiveChange={setIsCardSelectionActive}
        />
      </section>

      <section
        className={`conversation conversation--${status}`}
        aria-label="Character conversation"
      >
        <div className="conversation-copy" aria-live="polite">
          {shouldShowReply && <p className="reply">{reply}</p>}
          {(!isExhibitionMode || !shouldShowReply) && (
            <p className="status">
              {isMuted && status === 'idle'
                ? 'ミュート中です。テキスト会話は利用できます。'
                : conversationStatusLabel}
            </p>
          )}
          {conversationError && (
            <p className="conversation-error" role="alert">
              {conversationError}
            </p>
          )}
          {isVoiceInputEnabled && !isExhibitionMode && (
            <p className="voice-input-hint">
              {runtimeConfig.voiceTransport === 'remote'
                ? 'PCM音声サービスを使用中です。ヘッドセットを推奨します。'
                : 'ブラウザー音声認識を使用中です。ヘッドセットを推奨します。'}
            </p>
          )}
        </div>

        <form className="message-form" onSubmit={handleSubmit}>
          <label className="visually-hidden" htmlFor="message-input">
            キャラクターへ送るメッセージ
          </label>
          <input
            autoComplete="off"
            disabled={isManualBusy}
            id="message-input"
            maxLength={1000}
            onChange={(event) => setInput(event.target.value)}
            placeholder="メッセージを入力"
            type="text"
            value={input}
          />
          <button
            aria-label={
              isVoiceInputEnabled ? '音声入力を停止する' : '音声入力を開始する'
            }
            aria-pressed={isVoiceInputEnabled}
            className="voice-input-button"
            disabled={!isVoiceInputSupported}
            onClick={handleVoiceToggle}
            title={
              isVoiceInputSupported
                ? 'マイク音声入力を切り替えます'
                : 'この環境では音声入力を利用できません'
            }
            type="button"
          >
            {isVoiceInputEnabled ? '🛑 聞くのを止める' : '🎙 聞く'}
          </button>
          <button disabled={!trimmedInput || isManualBusy} type="submit">
            Send
          </button>
        </form>
      </section>

      {runtimeConfig.routerEnabled && (
        <RouterPanel
          isVoiceInputEnabled={isVoiceInputEnabled}
          onCommand={dispatchRouterCommand}
          onInputDeviceChange={setRouterAudioInputDeviceId}
          onObserve={observeRouterSignal}
          selectedInputDeviceId={routerAudioInputDeviceId}
          snapshot={routerSnapshot}
        />
      )}

      {runtimeConfig.audioLabEnabled && (
        <AudioLabPanel
          audioLevel={voiceInput.audioLevel}
          audioEndpointMs={effectiveAudioEndpointMs}
          bargeInState={bargeInState}
          effectiveThreshold={voiceInput.effectiveThreshold}
          isMicActive={isVoiceInputEnabled}
          isVoiceInputSupported={isVoiceInputSupported}
          isSttProcessing={voiceInput.isSttProcessing}
          isVadSpeech={voiceInput.isVadSpeech}
          mediaSettings={voiceInput.mediaSettings}
          captureHealth={voiceInput.captureHealth}
          sttRuntime={voiceInput.sttRuntime}
          mode={audioLabMode}
          preset={runtimeConfig.audioPreset}
          onExport={voiceLab.downloadJsonl}
          onAudioEndpointChange={handleAudioEndpointChange}
          onModeChange={handleAudioLabModeChange}
          onVoiceToggle={handleVoiceToggle}
          onVadThresholdChange={handleVadThresholdChange}
          snapshot={voiceLab.snapshot}
          ttsPlaying={ttsPlaying}
          vadScore={voiceInput.vadScore}
          vadThreshold={vadThreshold}
          noiseFloor={voiceInput.noiseFloor}
        />
      )}
    </main>
  );
}
