import { setComparingAudio, observeExhibitionAudio, configureExhibition, readPublicExperience, readExhibitionAudioMode, subscribeExhibition, readAudioObservations, subscribeAudioObservations, type PublicExperience, type ExhibitionAudioMode } from './public/exhibition';
import { SharedConversationQueue, resemblesPlayback } from './conversation/sharedConversation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { useAutonomyReasons } from './app/useAutonomyReasons';
import { publicActive, requestPublicSession, subscribePublic } from './public/session';
import { useViewerArrival } from './app/useViewerArrival';
import { createViewerNoticePlan } from './performer/viewerNotice';
import { EXHIBITION_CONVERSATION_CONTEXT } from './conversation/participationController';
import { useBargeInControl } from './app/useBargeInControl';
import { useCardAttention } from './app/useCardAttention';
import { useListeningBackchannels } from './app/useListeningBackchannels';
import { usePerformancePresentation } from './app/usePerformancePresentation';
import { SpatialTargetRegistry } from './attention/spatialTargetRegistry';
import { useCameraAttention } from './attention/useCameraAttention';
import { useAudioLipSync } from './audio/useAudioLipSync';
import { getIosAudioSession } from './audio/iosAudioSession';
import { VrmStage, type VrmStageHandle } from './avatar/VrmStage';
import {
  CardGamePrototype,
  type CardAttentionInput,
  type CardDragPositionUpdate,
  type CardInteractionTarget,
} from './cards/CardGamePrototype';
import {
  CARD_INTERACTION_CUE_DURATION_MS,
  shouldReactToCardInteraction
} from './cards/cardReactions';
import type { CardSwapResult } from './cards/useCardGamePrototype';
import { useCardGamePrototype } from './cards/useCardGamePrototype';
import { useWildcardDirection } from './cards/wildcardDirection';
import {
  addCharacterAlias,
  parseExplicitAliasInstruction,
  readCharacterIdentity,
  writeCharacterIdentity,
  type CharacterIdentity,
} from './character/identity';
import {
  INITIAL_AUTONOMOUS_CONTEXT,
  recordViewerIntent,
} from './conversation/autonomousContext';
import {
  completeInactiveEpisodes,
  createInitialAutonomyState,
  markCandidateOffered,
  resolveUsedReasons,
  selectAutonomyCandidate,
  type AutonomyCandidate
} from './conversation/autonomyState';
import {
  readAutonomyTurnGateTiming
} from './conversation/autonomyTurnGate';
import { emitAutonomyGateEvent } from './conversation/conversationEvents';
import {
  DEFAULT_PROGRAM_CONTEXT,
  type ProgramContext,
  type ProgramPhase,
} from './conversation/programContext';
import {
  useAutonomousTalk,
  type AutonomousTurnOutcome,
  type AutonomyCandidateTelemetry
} from './conversation/useAutonomousTalk';
import {
  useConversation,
  type AutonomousContext,
  type AutonomyEvidenceContext,
  type ChatCardContext
} from './conversation/useConversation';
import { PerformancePlaybackCoordinator } from './performer/performancePlayback';
import { isContentBearingVoiceMessage } from './performer/runtime';
import type {
  Attention,
  AttentionReader,
  ConversationActionDecision,
  DirectionContribution,
  PerformancePlan,
  PerformanceResult,
  PerformerTrigger,
} from './performer/types';
import { usePerformerRuntime } from './performer/usePerformerRuntime';
import { RouterPanel } from './router/RouterPanel';
import type {
  RouterEffect,
  RouterSignal,
} from './router/routerTypes.js';
import { useConversationRouter } from './router/useConversationRouter';
import { runtimeConfig } from './runtimeConfig';
import { useNetworkState } from './useNetworkState';
import {
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
  type AudioLabMode
} from './voice/audioLab.js';
import { AudioLabPanel } from './voice/AudioLabPanel';
import {
  selectListeningBackchannelIndex,
} from './voice/backchannelPolicy';
import {
  isConfirmedBargeInTranscript,
  isRejectedBargeInCandidate,
  shouldInterruptBusyTurn,
  shouldSuppressStartupDuck
} from './voice/bargeIn';
import { useVoiceInput } from './voice/useVoiceInput';
import { useVoiceLab } from './voice/useVoiceLab';
import {
  MAX_VOICE_TEXT_LENGTH,
  type ListeningReactionCue,
  type VoiceInputEvent,
} from './voice/voiceInput';
import {
  LISTENING_THINKING_MOTION_ASSET_ID
} from './voice/voiceInteraction';

import PublicControls from './public/PublicControls';
import { getMicrophoneState } from './public/microphoneState';
import { readThemePreference, readResolvedTheme, setThemePreference, subscribeTheme } from './public/theme';
import { usePanelVisibility } from './public/usePanelVisibility';

const STATUS_LABELS = {
  idle: '話しかけてください。',
  thinking: '考えています…',
  synthesizing: '返答音声を作っています…',
  speaking: '話しています。',
  error: '処理を完了できませんでした。',
} as const;

type MicrophoneInputTransition = 'starting' | 'stopping';

function readAnimationNow(): number {
  return typeof performance !== 'undefined' && Number.isFinite(performance.now())
    ? performance.now()
    : Date.now();
}

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

function CameraIcon() {
  return (
    <svg
      aria-hidden="true"
      className="control-icon"
      viewBox="0 0 24 24"
      focusable="false"
    >
      <path
        d="M5 7.5h3l1.2-2h5.6l1.2 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <circle
        cx="12"
        cy="13"
        r="3.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function WifiStatusIcon({ unavailable }: { unavailable: boolean }) {
  return (
    <svg aria-hidden="true" className="network-status-icon" viewBox="0 0 24 24" focusable="false">
      <path
        d="M3 8.5c5-4.5 13-4.5 18 0M6.5 12c3.1-2.8 7.9-2.8 11 0M10 15.5c1.1-1 2.9-1 4 0M12 19h.01"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      {unavailable && (
        <path
          d="m4 4 16 16"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.9"
        />
      )}
    </svg>
  );
}

function InternetStatusIcon({ unavailable }: { unavailable: boolean }) {
  return (
    <svg aria-hidden="true" className="network-status-icon" viewBox="0 0 24 24" focusable="false">
      <path
        d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-8.5 9h17M12 3c2.2 2.5 3.3 5.5 3.3 9s-1.1 6.5-3.3 9c-2.2-2.5-3.3-5.5-3.3-9S9.8 5.5 12 3Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
      {unavailable && (
        <path
          d="m4 4 16 16"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.9"
        />
      )}
    </svg>
  );
}

type ExhibitionPresentationState = 'idle' | 'selecting' | 'reacting';

const EXHIBITION_MICROPHONE_PANEL_ID = 'exhibition-microphone-adjuster';
const MICROPHONE_INPUT_ACTIVITY_FLOOR = 0.001;
const MICROPHONE_METER_MAX = VAD_THRESHOLD_MAX;

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
  const themePreference = useSyncExternalStore(subscribeTheme, readThemePreference);
  const resolvedTheme = useSyncExternalStore(subscribeTheme, readResolvedTheme);
  const publicExperience = useSyncExternalStore(subscribeExhibition, readPublicExperience);
  const exhibitionAudioMode = useSyncExternalStore(subscribeExhibition, readExhibitionAudioMode);
  const audioObservations = useSyncExternalStore(subscribeAudioObservations, readAudioObservations);
  const isPublicExhibition = runtimeConfig.mode === 'public' && publicExperience === 'exhibition';
  const [comparisonSample, setComparisonSample] = useState<{ data: ArrayBuffer; mimeType: string } | null>(null);
  const [comparisonPlaying, setComparisonPlaying] = useState(false);
  const [sharedQueue] = useState(() => new SharedConversationQueue(() => {}, () => {}));
  const sharedGenerationRef = useRef(0);
  const publicTransitionRef = useRef(false);
  const playbackAtSpeechRef = useRef(new Map<string, string>());
  const publicSessionActive = useSyncExternalStore(subscribePublic, publicActive);
  const [input, setInput] = useState('');
  const [isAvatarReady, setIsAvatarReady] = useState(false);
  const [isCardSelectionActive, setIsCardSelectionActive] = useState(false);

  const [audioControl, setAudioControl] = useState(readAudioControlState);
  const [characterIdentity, setCharacterIdentity] = useState(
    readCharacterIdentity,
  );
  const [programPhase, setProgramPhase] = useState<ProgramPhase>(
    DEFAULT_PROGRAM_CONTEXT.phase,
  );
  const [showExhibitionCards, setShowExhibitionCards] = useState(false);
  const programContext = useMemo<ProgramContext>(
    () => (isPublicExhibition || runtimeConfig.mode === 'exhibition') && !showExhibitionCards
      ? { ...DEFAULT_PROGRAM_CONTEXT, format: 'live_conversation',
        objective: 'converse_freely', participantRole: 'shared_microphone_group', phase: programPhase }
      : { ...DEFAULT_PROGRAM_CONTEXT, phase: programPhase,
        participantRole: (isPublicExhibition || runtimeConfig.mode === 'exhibition') ? 'shared_microphone_group' : 'viewer_directed' },
    [programPhase, showExhibitionCards, isPublicExhibition],
  );
  const [autonomousContext, setAutonomousContext] =
    useState<AutonomousContext>(INITIAL_AUTONOMOUS_CONTEXT);

  const [isAutonomousLoopEnabled, setIsAutonomousLoopEnabled] =
    useState(true);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const { isMuted, lastAudibleVolume, volume } = audioControl;
  const isExhibitionMode = runtimeConfig.mode === 'exhibition' || isPublicExhibition;
  const usesExhibitionUi = isExhibitionMode || runtimeConfig.mode === 'public';
  const [publicTextInputOpen, setPublicTextInputOpen] = useState(false);
  const publicTextPanelRef = usePanelVisibility<HTMLFormElement>(runtimeConfig.mode !== 'public' || publicTextInputOpen, '.public-controls__text');
  const [publicSubmitPending, setPublicSubmitPending] = useState(false);
  const publicSubmitPendingRef = useRef(false);
  useEffect(() => {
    const toggle = () => setPublicTextInputOpen(value => !value);
    window.addEventListener('vayria-public-text-input', toggle);
    return () => window.removeEventListener('vayria-public-text-input', toggle);
  }, []);
  const [showExhibitionText, setShowExhibitionText] = useState(false);
  const viewerInputSequenceRef = useRef(0);
  const [exhibitionSessionMessage, setExhibitionSessionMessage] = useState('');
  const [isHumanExchange, setIsHumanExchange] = useState(false);
  const [textInputAudience, setTextInputAudience] = useState<'vayria' | 'room'>('vayria');
  const [isResettingExhibition, setIsResettingExhibition] = useState(false);
  const networkState = useNetworkState(runtimeConfig.mode === 'exhibition');
  const [spatialTargetRegistry] = useState(
    () => new SpatialTargetRegistry(),
  );

  const cardGame = useCardGamePrototype(runtimeConfig.mode === 'public');
  const {
    acceptReply,
    beginReply,
    clearReplyPresentation,
    presentReply,
    resetTurn,
    zones,
  } = cardGame;
  const cardPresentationPlanIdRef = useRef<string | null>(null);
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

  const pendingCardStimulusRef = useRef<{
    cardContext: ChatCardContext;
    contribution: DirectionContribution;
    programContext: ProgramContext;
  } | null>(null);

  useEffect(() => {
    characterIdentityRef.current = characterIdentity;
  }, [characterIdentity]);

  const stageRef = useRef<VrmStageHandle>(null);
  const [stageMotionPort, setStageMotionPort] =
    useState<VrmStageHandle | null>(null);

  const sessionGenerationRef = useRef(0);
  const iosAudioSession = runtimeConfig.mode === 'public' ? getIosAudioSession() : null;
  const {
    getPrimaryPlaybackAgeMs,
    isAudioUnlocked,
    isReactionPlaying,
    isSpeaking,
    mouthOpen,
    needsPlaybackGesture,
    play,
    playReaction,
    prepare,
    setDucked,
    stop,
    stopReaction,
  } = useAudioLipSync(volume, iosAudioSession);
  const [listeningReaction, setListeningReaction] =
    useState<ListeningReactionCue | undefined>();
  const { cardAttentionPhase, setCardAttentionPhase, cardAttentionStartedAtRef, dragAttentionLastTickAtRef, dragAttentionSpeedRef, dragAttentionControllerRef, cardAttentionEnergyControllerRef, clearCardAttentionTimers, scheduleDragAttentionTick, scheduleCardAttentionSequence, scheduleCardDefaultAttention, finishDragAttention } = useCardAttention({ spatialTargetRegistry });

  const readAttention: AttentionReader = useCallback(() => {
    const logicalAttention = logicalAttentionRef.current;
    const cameraSnapshot = readCameraSnapshot();
    const dragAttentionSnapshot = dragAttentionControllerRef.current.snapshot();
    const now = readAnimationNow();
    const cardAttentionEnergy =
      cardAttentionEnergyControllerRef.current.update(now);
    const dynamicGazeOverride = logicalAttention.gazeOverride
      ? {
        ...logicalAttention.gazeOverride,
        elapsedMs:
          dragAttentionSnapshot.phase !== 'idle'
            ? dragAttentionSnapshot.elapsedMs
            : Math.max(
              0,
              now - (cardAttentionStartedAtRef.current ?? now),
            ),
        energy:
          dragAttentionSnapshot.phase !== 'idle'
            ? dragAttentionSnapshot.attentionEnergy
            : cardAttentionEnergy.energy,
        viewerCheckIn:
          dragAttentionSnapshot.phase !== 'idle' &&
          dragAttentionSnapshot.viewerCheckIn,
      }
      : undefined;
    return {
      ...logicalAttention,
      gazeOverride: dynamicGazeOverride,
      position: cameraSnapshot.position,
      confidence: cameraSnapshot.confidence,
      updatedAt: Math.max(
        logicalAttention.updatedAt,
        cameraSnapshot.updatedAt,
      ),
    };
  }, [cardAttentionEnergyControllerRef, cardAttentionStartedAtRef, dragAttentionControllerRef, readCameraSnapshot]);

  const { autonomyState, setAutonomyState, autonomyExternalEvent, autonomyStateRef, recordAutonomyEvidence, notifyMeaningfulAutonomyEvent, readAutonomyEvidenceContext, handleAutonomyDelta } = useAutonomyReasons();

  const [voiceValidationError, setVoiceValidationError] = useState('');
  const voiceEventHandlerRef = useRef<((event: VoiceInputEvent) => void) | null>(
    null,
  );
  const routerObserveSignalRef = useRef<
    ((signal: RouterSignal) => unknown) | null
  >(null);
  const voiceReactionIdRef = useRef(0);

  const routerBlockedSegmentRef = useRef<string | null>(null);
  const { backchannelAudioRef, backchannelVariantIndexRef, backchannelLoadingRef, preloadBackchannel } = useListeningBackchannels();

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
  const [isMicrophoneControlExpanded, setIsMicrophoneControlExpanded] =
    useState(false);
  const [microphoneInputTransition, setMicrophoneInputTransition] =
    useState<MicrophoneInputTransition | null>(null);
  const microphoneInputTransitionRef =
    useRef<MicrophoneInputTransition | null>(null);
  const microphoneControlRef = useRef<HTMLDivElement>(null);
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
  const {
    handleInteractionTimelineEvent,
    handleConversationInputReceived,
  } = voiceLab;
  const voiceInput = useVoiceInput({
    audioMode: audioLabMode,
    audioPreset: runtimeConfig.audioPreset,
    audioEndpointMs: effectiveAudioEndpointMs,
    audioInputDeviceId: routerAudioInputDeviceId,
    language: 'ja-JP',
    ttsPlaying,
    onDiagnostic: voiceLab.handleDiagnostic,
    onEvent: (event) => {
      if (event.type === 'utterance_finalized') {
        voiceEventHandlerRef.current?.(event);
        voiceLab.handleVoiceEvent(event);
        return;
      }
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
        holdAudioCapture: iosAudioSession ? () => iosAudioSession.holdPlayback().release : undefined,
      }),
    [play, stageMotionPort, stop, iosAudioSession],
  );

  const handleReplyPresentationStart = useCallback(
    (planId: string, activatedCardIds: string[]) => {
      cardPresentationPlanIdRef.current = planId;
      presentReply(activatedCardIds);
    },
    [presentReply],
  );

  const handleReplyPresentationEnd = useCallback(
    (planId: string) => {
      if (cardPresentationPlanIdRef.current !== planId) return;
      cardPresentationPlanIdRef.current = null;
      clearReplyPresentation();
    },
    [clearReplyPresentation],
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
      if (isPublicExhibition) {
        setIsHumanExchange(decision.action !== 'take_floor');
        setExhibitionSessionMessage(decision.action === 'take_floor' ? '' : 'お二人の会話を聞いています');
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
    [isPublicExhibition, backchannelAudioRef, backchannelLoadingRef, backchannelVariantIndexRef, handleInteractionTimelineEvent, playReaction, stopReaction],
  );

  const handlePerformancePlan = useCallback((plan: PerformancePlan) => {
    activePlanRef.current = plan;
    setActivePlan(plan);
    setActiveEmotionCue(plan.preReaction?.expression ?? null);
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

  const { cardDropReactionControllerRef, cardReactionPlanIdsRef, cardDropReactionPlanIdsRef, pendingActivatedCardIdsRef, nonSpeechTimerRef, handlePerformanceResult, handleReplyAccepted, cancelActiveCardReactionPlan, executeNonSpeechPlan, cancelNonSpeechPlan } = usePerformancePresentation({ activePlanRef, setActivePlan, setActiveEmotionCue, setIsAutonomousLoopEnabled, playbackCoordinator, completePlan, acceptReply, resetTurn, handlePerformancePlan, sessionGeneration, sessionGenerationRef });

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
    conversationContext: isExhibitionMode ? EXHIBITION_CONVERSATION_CONTEXT : undefined,
    programContext,
    getPerformerStateContext,
    onPerformanceCue: handlePerformanceCue,
    onPerformancePlan: handlePerformancePlan,
    onPerformanceResult: handlePerformanceResult,
    onInteractionAction: handleInteractionAction,
    onInteractionTimelineEvent: handleInteractionTimelineEvent,
    onAutonomyDelta: handleAutonomyDelta,
    onReplyPresentationStart: handleReplyPresentationStart,
    onReplyPresentationEnd: handleReplyPresentationEnd,
  });

  const routerResetSessionRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (runtimeConfig.mode !== 'public') return;
    const stop = () => { void stopVoiceInput(); interruptCurrentTurn('router_control'); stopReaction(); playbackCoordinator.stop(); };
    const unlock = () => { void prepare(); };
    const start = () => { void prepare(); };
    window.addEventListener('vayria-public-stop', stop);
    window.addEventListener('vayria-public-start', start);
    window.addEventListener('vayria-public-prepare', unlock);
    return () => { window.removeEventListener('vayria-public-stop', stop); window.removeEventListener('vayria-public-start', start); window.removeEventListener('vayria-public-prepare', unlock); };
  }, [stopVoiceInput, startVoiceInput, interruptCurrentTurn, prepare, stopReaction, playbackCoordinator]);
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

  const { activeBargeInSegmentRef, bargeInStateRef, bargeInState, clearBargeInTimer, dispatchBargeIn } = useBargeInControl({ setDucked, voiceLab, ttsPlaying, handleInteractionTimelineEvent, audioLabMode });

  useEffect(() => {
    return () => {
      clearBargeInTimer();
      setDucked(false);
    };
  }, [clearBargeInTimer, setDucked]);

  const displayEmotion = activeEmotionCue?.emotion ?? performer.state.emotion.value;
  const isPerformerBusy = isBusy || activePlan !== null;
  const canNoticeViewer = isAvatarReady && !isPerformerBusy && !isVadSpeech && !isSttProcessing &&
    (!runtimeConfig.routerEnabled || (routerSnapshot.controlState === 'idle' &&
      routerSnapshot.vayriaOutputGate === 'open'));
  const noticeViewer = useCallback(() => {
    if (!canNoticeViewer || activePlanRef.current !== null) return;
    const base = createPlan({ kind: 'external_stimulus', semanticCue: 'viewer_attention',
      metadata: { origin: 'viewer-attention' } });
    executeNonSpeechPlan(createViewerNoticePlan(base,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches));
  }, [canNoticeViewer, createPlan, executeNonSpeechPlan]);
  useViewerArrival({
    enabled: isExhibitionMode && cameraAttentionStatus === 'active' && (runtimeConfig.mode !== 'public' || publicSessionActive),
    canNotice: canNoticeViewer,
    canSpeak: isAvatarReady && isAudioUnlocked && !isMuted &&
      isAutonomousLoopEnabled && !isPerformerBusy && !isVadSpeech && !isSttProcessing &&
      !isHumanExchange &&
      (!runtimeConfig.routerEnabled || (routerSnapshot.controlState === 'idle' &&
        routerSnapshot.vayriaOutputGate === 'open')),
    sessionGeneration,
    readSnapshot: readCameraSnapshot,
    readViewerInputSequence: () => viewerInputSequenceRef.current,
    onNotice: noticeViewer,
    onArrival: () => {
      const content = 'カメラの前で顔が継続して検出された。誰か、初対面か、戻った人かは不明。相手がまだ話していなければ、今の自分の関心から短く一言声をかけてもよい。人物の外見や感情を推測せず、カードや操作方法の説明、定型の自己紹介はしない。返事を求め続けず相手の間を残す。';
      recordAutonomyEvidence({
        id: `viewer-arrival:${sessionGeneration}:${Date.now()}`,
        kind: 'environment_change', at: Date.now(),
        semanticKey: 'viewer-arrival', content,
        wakeConditions: ['new_evidence', 'attention_available'],
        reasonProposals: [{ kind: 'participant_reengagement', content,
          semanticKey: 'viewer-arrival', salience: 0.8 }],
      });
    },
    onUnavailable: () => {
      const state = autonomyStateRef.current;
      if (!state.reasons.some((reason) => reason.semanticKey === 'viewer-arrival' &&
        (reason.status === 'active' || reason.status === 'deferred'))) return;
      const next = completeInactiveEpisodes({ ...state, reasons: state.reasons.map((reason) =>
        reason.semanticKey === 'viewer-arrival' &&
          (reason.status === 'active' || reason.status === 'deferred')
          ? { ...reason, status: 'expired' as const } : reason),
      });
      autonomyStateRef.current = next;
      setAutonomyState(next);
    },
  });
  const autonomyCandidate = useMemo(
    () =>
      selectAutonomyCandidate(autonomyState, {
        enabled:
          isAutonomousLoopEnabled && !comparisonPlaying && !isHumanExchange &&
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
      isHumanExchange,
      comparisonPlaying,
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
  const publicMicrophoneState = getMicrophoneState({
    transition: microphoneInputTransition,
    error: voiceError,
    enabled: isVoiceInputEnabled,
    recognizing: isSttProcessing,
    speaking: isVadSpeech || voiceInputPhase === 'speech_detected',
  });
  const conversationError = error || voiceValidationError || voiceError;
  const shouldShowStatus =
    (!usesExhibitionUi || !shouldShowReply) &&
    !(runtimeConfig.mode === 'public' && (
      (status === 'idle' && !isMuted && !isPublicExhibition) ||
      (status === 'error' && Boolean(conversationError))
    ));
  const displayedAudioLevel = isVoiceInputEnabled ? audioLevel : null;
  const browserGateAvailable =
    audioLabMode === 'processed-vad' ||
    ((audioLabMode === 'processed' || audioLabMode === 'exhibition-mix') &&
      runtimeConfig.audioPreset !== 'off');
  const displayThreshold = browserGateAvailable
    ? (effectiveThreshold ?? vadThreshold)
    : null;
  const isMicrophoneInputTransitionPending =
    microphoneInputTransition !== null;
  const isMicrophoneInputVisuallyEnabled =
    microphoneInputTransition === 'starting' ||
    (microphoneInputTransition === null && isVoiceInputEnabled);
  const microphoneInputVisualState =
    microphoneInputTransition ??
    (voiceError ? 'error' : isVoiceInputEnabled ? 'on' : 'off');
  const microphoneLevel = Math.max(0, displayedAudioLevel ?? 0);
  const microphoneMeterValue = Math.min(
    MICROPHONE_METER_MAX,
    microphoneLevel,
  );
  const microphoneLevelPercent = Math.min(
    100,
    (microphoneLevel / MICROPHONE_METER_MAX) * 100,
  );
  const microphoneThresholdSettingValue = Math.min(
    VAD_THRESHOLD_MAX,
    Math.max(VAD_THRESHOLD_MIN, vadThreshold),
  );
  const effectiveThresholdPercent =
    displayThreshold === null
      ? null
      : Math.min(
        100,
        Math.max(0, (displayThreshold / MICROPHONE_METER_MAX) * 100),
      );
  const microphoneInputStrength = Math.min(
    1,
    microphoneLevel / MICROPHONE_METER_MAX,
  );
  const microphoneFeedbackStyle = {
    '--microphone-glow-size': `${1 + microphoneInputStrength * 5}px`,
    '--microphone-pulse-scale': `${1 + microphoneInputStrength * 0.04}`,
    '--microphone-ring-opacity': `${microphoneInputStrength * 0.22}`,
    '--microphone-ring-scale': `${1 + microphoneInputStrength * 0.06}`,
  } as CSSProperties;
  const isMicrophoneInputActive =
    isVoiceInputEnabled && microphoneLevel > MICROPHONE_INPUT_ACTIVITY_FLOOR;
  const isThresholdCurrentlyCrossed =
    isVoiceInputEnabled &&
    displayThreshold !== null &&
    microphoneLevel >= displayThreshold;
  const microphoneStatusLabel =
    microphoneInputTransition === 'starting'
      ? '開始中'
      : microphoneInputTransition === 'stopping'
        ? '停止中'
        : voiceError
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
    if (!isMicrophoneControlExpanded) return;

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (microphoneControlRef.current?.contains(event.target)) return;
      setIsMicrophoneControlExpanded(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsMicrophoneControlExpanded(false);
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isMicrophoneControlExpanded]);

  useEffect(() => {
    const logicalTargetFromPerformance =
      activePlan !== null
        ? activePlan.preReaction?.gaze?.target ??
        performer.state.attention.target
        : listeningReaction?.target ?? 'none';
    const dragAcquireActive = cardAttentionPhase === 'drag-acquire';
    const dragPriorityActive = cardAttentionPhase === 'drag-priority';
    const cardTaskCueActive = cardAttentionPhase !== null;
    const logicalAttentionTarget = logicalTargetFromPerformance;
    const cardSpatialTarget = cardTaskCueActive
      ? cardAttentionPhase === 'transient' ||
        dragAcquireActive ||
        dragPriorityActive
        ? ({ kind: 'game', anchor: 'transient' } as const)
        : ({ kind: 'game', anchor: 'default' } as const)
      : undefined;
    const spatialTarget: Attention['spatialTarget'] =
      logicalAttentionTarget === 'game' ||
        logicalAttentionTarget === 'chat' ||
        logicalAttentionTarget === 'viewer'
        ? { kind: logicalAttentionTarget, anchor: 'default' }
        : undefined;
    const cardEnergy = cardAttentionEnergyControllerRef.current.snapshot();
    const dragEnergy = dragAttentionControllerRef.current.snapshot();
    const gazeOverride: Attention['gazeOverride'] = cardSpatialTarget
      ? {
        kind:
          dragAcquireActive || dragPriorityActive
            ? 'card-drag'
            : 'card-transient',
        target: 'game',
        spatialTarget: cardSpatialTarget,
        elapsedMs: dragEnergy.elapsedMs,
        energy:
          dragEnergy.phase !== 'idle'
            ? dragEnergy.attentionEnergy
            : cardEnergy.energy,
        viewerCheckIn:
          dragEnergy.phase !== 'idle' && dragEnergy.viewerCheckIn,
      }
      : undefined;
    logicalAttentionRef.current = {
      ...performer.state.attention,
      target: logicalAttentionTarget,
      strength:
        listeningReaction
          ? 1
          : activePlan !== null
            ? Math.max(0.72, performer.state.attention.strength)
            : 0,
      position: null,
      confidence: 0,
      spatialTarget,
      targetMode: performer.state.attention.targetMode ?? 'semantic',
      gazeOverride,
    };
  }, [activePlan, cardAttentionEnergyControllerRef, cardAttentionPhase, dragAttentionControllerRef, listeningReaction, performer.state.attention]);
  const cameraAttentionStatusMessage = getCameraAttentionStatusMessage(
    cameraAttentionStatus,
    cameraAttentionErrorCode,
  );
  const cameraAttentionEnabled = cameraAttentionStatus === 'active';
  const cameraAttentionIsStarting = cameraAttentionStatus === 'starting';
  const cameraAttentionButtonTitle =
    cameraAttentionStatus === 'active'
      ? '視線追従を停止します'
      : cameraAttentionStatusMessage ?? '視線追従を有効化します';
  const handleCameraAttentionToggle = useCallback(() => {
    if (cameraAttentionStatus === 'starting') return;
    if (cameraAttentionStatus === 'active') {
      stopCameraAttention();
      return;
    }
    void startCameraAttention();
  }, [
    cameraAttentionStatus,
    startCameraAttention,
    stopCameraAttention,
  ]);
  const microphoneToggleLabel =
    microphoneInputTransition === 'starting'
      ? '音声入力を開始中'
      : microphoneInputTransition === 'stopping'
        ? '音声入力を停止中'
        : voiceError
          ? '音声入力を再試行'
          : isVoiceInputEnabled
            ? '音声入力を停止'
            : '音声入力を有効化';
  const microphoneDisclosureLabel =
    microphoneInputTransition === 'starting'
      ? '音声入力を開始中'
      : microphoneInputTransition === 'stopping'
        ? '音声入力を停止中'
        : voiceError
          ? '音声入力を再試行'
          : isVoiceInputEnabled
            ? 'マイク調整を表示'
            : '音声入力を有効化';
  const shouldShowAudioUnlockControl =
    !isExhibitionMode ||
    !isAudioUnlocked ||
    !isVoiceInputEnabled ||
    Boolean(voiceError);

  const resetSession = useCallback((stopMicrophone = true) => {
    const nextGeneration = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = nextGeneration;

    if (stopMicrophone) void stopVoiceInput();
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

    clearCardAttentionTimers();
    dragAttentionControllerRef.current.end();
    dragAttentionSpeedRef.current = null;
    cardAttentionEnergyControllerRef.current.clear();
    cardAttentionStartedAtRef.current = null;
    spatialTargetRegistry.clearTransient('game');
    setCardAttentionPhase(null);

    resetConversation();
    resetRuntime();
    resetTurn();
    cardDropReactionControllerRef.current.reset();
    cardDropReactionPlanIdsRef.current.clear();
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
    setIsHumanExchange(false);
    setExhibitionSessionMessage('');
    setSessionGeneration(nextGeneration);
  }, [stopVoiceInput, clearBargeInTimer, activeBargeInSegmentRef, bargeInStateRef, stopReaction, backchannelVariantIndexRef, nonSpeechTimerRef, clearCardAttentionTimers, dragAttentionControllerRef, dragAttentionSpeedRef, cardAttentionEnergyControllerRef, cardAttentionStartedAtRef, spatialTargetRegistry, setCardAttentionPhase, resetConversation, resetRuntime, resetTurn, cardDropReactionControllerRef, cardDropReactionPlanIdsRef, cardReactionPlanIdsRef, pendingActivatedCardIdsRef, autonomyStateRef, setAutonomyState, dispatchBargeIn, setDucked]);

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

  const handleNextVisitor = async () => {
    if (publicTransitionRef.current || isResettingExhibition || microphoneInputTransitionRef.current !== null) return;
    publicTransitionRef.current = true;
    window.dispatchEvent(new Event('vayria-exhibition-reset'));
    sharedGenerationRef.current++; sharedQueue.reset(); playbackAtSpeechRef.current.clear();
    interruptCurrentTurn('visitor_reset');
    setIsResettingExhibition(true);
    const restartMicrophone = isVoiceInputEnabled;
    try {
      await stopVoiceInput();
      resetSession(false);
      wildcardDirection.reset(cardGame.resetCards());
      setShowExhibitionCards(false);
      setShowExhibitionText(false);
      setPublicTextInputOpen(false);
      setTextInputAudience('vayria');
      viewerInputSequenceRef.current = 0;
      setExhibitionSessionMessage('新しい会話を始められます');
      if (restartMicrophone && !(await startVoiceInput())) {
        setExhibitionSessionMessage('会話をリセットしました。マイクを再開してください');
      }
    } catch {
      setExhibitionSessionMessage('切り替えに失敗しました。マイクの状態を確認して再試行してください');
    } finally {
      publicTransitionRef.current = false;
      setIsResettingExhibition(false);
    }
  };

  const changePublicExperience = async (next: PublicExperience, audio = exhibitionAudioMode) => {
    if (publicTransitionRef.current) return;
    publicTransitionRef.current = true; setIsResettingExhibition(true);
    window.dispatchEvent(new Event('vayria-exhibition-reset'));
    sharedGenerationRef.current++; sharedQueue.reset(); playbackAtSpeechRef.current.clear();
    interruptCurrentTurn('experience_change');
    const resume = isVoiceInputEnabled;
    try {
      await stopVoiceInput(); resetSession(false);
      wildcardDirection.reset(cardGame.resetCards());
      setShowExhibitionCards(false); setShowExhibitionText(false); setPublicTextInputOpen(false);
      setTextInputAudience('vayria');
      configureExhibition(next, audio);
      if (resume && publicActive() && !(await startVoiceInput())) setExhibitionSessionMessage('切り替えました。マイクを再開してください');
    } catch { setExhibitionSessionMessage('切り替えに失敗しました。マイクを再開してください'); }
    finally { publicTransitionRef.current = false; setIsResettingExhibition(false); }
  };

  const compareAudio = async (withoutMicrophone: boolean) => {
    if (!comparisonSample || publicTransitionRef.current || comparisonPlaying) return;
    sharedQueue.reset(); sharedGenerationRef.current++;
    interruptCurrentTurn('audio_comparison');
    publicTransitionRef.current = true; setComparisonPlaying(true); setComparingAudio(true);
    try {
      if (withoutMicrophone) await stopVoiceInput();
      else if (!(await requestPublicSession()) || !(await startVoiceInput())) return;
      observeExhibitionAudio({ event: withoutMicrophone ? 'comparison_no_microphone' : 'comparison_start' });
      await prepare();
      await play({ kind: 'buffer', ...comparisonSample, data: comparisonSample.data.slice(0) }, {
        onPlaybackStartup: info => observeExhibitionAudio({ event: 'comparison_playback', contextState: info.audioContextState, sampleRate: info.sampleRateHz }),
      });
    } catch { setExhibitionSessionMessage('比較音声を再生できませんでした'); }
    finally {
      setComparingAudio(false); publicTransitionRef.current = false; setComparisonPlaying(false);
      observeExhibitionAudio({ event: 'comparison_end' });
    }
  };

  const handleCardInteraction = useCallback(
    ({ element, interaction }: CardInteractionTarget) => {
      if (!isExhibitionMode) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }

      if (interaction === 'drag-start') {
        spatialTargetRegistry.refreshDefault('game');
        spatialTargetRegistry.captureTransient('game', element);
        spatialTargetRegistry.setTransientDragActive('game', true);
        clearCardAttentionTimers();
        dragAttentionControllerRef.current.start(
          logicalAttentionRef.current.gazeStrength ??
          logicalAttentionRef.current.strength,
        );
        dragAttentionSpeedRef.current = null;
        dragAttentionLastTickAtRef.current = readAnimationNow();
        cardAttentionStartedAtRef.current = dragAttentionLastTickAtRef.current;
        setCardAttentionPhase('drag-acquire');
        scheduleDragAttentionTick();
        return;
      }

      if (!shouldReactToCardInteraction()) return;

      spatialTargetRegistry.refreshDefault('game');
      spatialTargetRegistry.captureTransient('game', element);
      scheduleCardAttentionSequence(CARD_INTERACTION_CUE_DURATION_MS);
    },
    [cardAttentionStartedAtRef, clearCardAttentionTimers, dragAttentionControllerRef, dragAttentionLastTickAtRef, dragAttentionSpeedRef, isExhibitionMode, scheduleCardAttentionSequence, scheduleDragAttentionTick, setCardAttentionPhase, spatialTargetRegistry],
  );

  const handleCardAttentionInput = useCallback(
    ({ interaction }: CardAttentionInput) => {
      if (!isExhibitionMode) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return;
      }
      if (interaction === 'drag-start') return;

      const now = readAnimationNow();
      cardAttentionEnergyControllerRef.current.trigger(
        now,
        logicalAttentionRef.current.gazeStrength ??
        logicalAttentionRef.current.strength,
      );

      if (interaction === 'appearance') {
        spatialTargetRegistry.refreshDefault('game');
        scheduleCardDefaultAttention();
        return;
      }

      spatialTargetRegistry.refreshDefault('game');
      scheduleCardDefaultAttention();
    },
    [cardAttentionEnergyControllerRef, isExhibitionMode, scheduleCardDefaultAttention, spatialTargetRegistry],
  );

  const handleCardDragPositionChange = useCallback(
    ({ center, speedPxPerSecond, capturedAt }: CardDragPositionUpdate) => {
      spatialTargetRegistry.updateTransientPoint('game', center, {
        now: capturedAt,
      });
      dragAttentionSpeedRef.current = {
        speedPxPerSecond,
        capturedAt,
      };
    },
    [dragAttentionSpeedRef, spatialTargetRegistry],
  );

  const handleCardDragActiveChange = useCallback(
    (isActive: boolean) => {
      if (isActive) return;
      finishDragAttention();
    },
    [finishDragAttention],
  );

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
    routerObserveSignalRef.current?.({
      type: 'vayria_status',
      status,
      voiceInputEnabled: isVoiceInputEnabled,
    });
  }, [isVoiceInputEnabled, status]);

  useEffect(() => {
    return () => {
      if (nonSpeechTimerRef.current !== null) {
        window.clearTimeout(nonSpeechTimerRef.current);
      }
      clearCardAttentionTimers();
      spatialTargetRegistry.clearTransient('game');
    };
  }, [clearCardAttentionTimers, nonSpeechTimerRef, spatialTargetRegistry]);

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

  useEffect(() => {
    sharedQueue.setCallbacks((text: string) => {
      if (!isPublicExhibition || !publicActive() || document.hidden || publicTransitionRef.current) return;
      const generation = sharedGenerationRef.current;
      setIsHumanExchange(true);
      const state = autonomyStateRef.current;
      const next = completeInactiveEpisodes({ ...state, reasons: state.reasons.map(reason =>
        reason.status === 'active' || reason.status === 'deferred' ? { ...reason, status: 'expired' as const } : reason) });
      autonomyStateRef.current = next; setAutonomyState(next);
      interruptCurrentTurn('shared_turn');
      const context = readCardContext();
      const plan = createPlanForTrigger({ kind: 'viewer_message', text });
      plan.actionDecision = undefined;
      void sendVoice(text, context, handleReplyAccepted, plan,
        { segmentId: `shared:${Date.now()}:${generation}`, at: Date.now(), asrConfidence: null },
        characterIdentityRef.current, programContext).then(() => {
          if (generation !== sharedGenerationRef.current) return;
        });
    }, () => {
      setExhibitionSessionMessage('会話の処理が追いつきません。マイクを再開してください');
      void stopVoiceInput();
    });
    const overflow = () => sharedQueue.reportOverflow();
    const stopShared = () => {
      if (!isPublicExhibition) return;
      sharedQueue.reset(); sharedGenerationRef.current++; playbackAtSpeechRef.current.clear();
      setDucked(false); interruptCurrentTurn('public_session_stopped');
    };
    window.addEventListener('vayria-exhibition-overflow', overflow);
    window.addEventListener('vayria-public-stop', stopShared);
    return () => {
      window.removeEventListener('vayria-exhibition-overflow', overflow);
      window.removeEventListener('vayria-public-stop', stopShared);
    };
  }, [isPublicExhibition, sharedQueue, autonomyStateRef, setAutonomyState, interruptCurrentTurn, readCardContext, createPlanForTrigger, sendVoice, handleReplyAccepted, programContext, stopVoiceInput, setDucked]);
  useEffect(() => () => sharedQueue.reset(), [sharedQueue]);

  const handleVoiceEvent = useCallback(
    (event: VoiceInputEvent) => {
      if (event.type === 'speech_started') viewerInputSequenceRef.current += 1;
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
      if (isPublicExhibition) {
        if (publicTransitionRef.current || !publicActive()) return;
        recordVoiceSignal(event);
        if (event.type === 'speech_started') {
          sharedQueue.speechStarted();
          setIsHumanExchange(true);
          viewerInputSequenceRef.current++;
          sharedGenerationRef.current++;
          if (ttsPlaying) { playbackAtSpeechRef.current.set(event.segmentId, reply); setDucked(true); }
          else { interruptCurrentTurn('shared_new_speech'); }
          return;
        }
        if (event.type === 'speech_ended') { sharedQueue.speechEnded(event.at); return; }
        if (event.type === 'utterance_finalized') {
          const spoken = playbackAtSpeechRef.current.get(event.segmentId);
          playbackAtSpeechRef.current.delete(event.segmentId);
          setDucked(false);
          const text = event.text.trim();
          if (!text || (spoken && resemblesPlayback(text, spoken))) { sharedQueue.discard(); return; }
          interruptCurrentTurn('shared_confirmed_speech');
          sharedQueue.append(text);
          return;
        }
        if (event.type === 'recognition_stopped' || event.type === 'recognition_failed') {
          sharedQueue.reset(); sharedGenerationRef.current++; playbackAtSpeechRef.current.clear();
          setDucked(false); interruptCurrentTurn('shared_capture_stopped');
        }
        return;
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
          const primaryPlaybackAgeMs = getPrimaryPlaybackAgeMs();
          dispatchBargeIn({
            type: 'speech_started',
            ttsPlaying,
            suppressDuck: shouldSuppressStartupDuck(
              isBargeInCandidate,
              source === 'voice',
              primaryPlaybackAgeMs,
            ),
            ...(primaryPlaybackAgeMs === null
              ? {}
              : { playbackAgeMs: primaryPlaybackAgeMs }),
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
          const participation = evaluateVoiceParticipation({
            segmentId: event.segmentId, text: message, speakerId: event.speakerId, at: event.at,
          }, characterIdentityRef.current);
          if (participation.mode === 'multi_party' && participation.decision === 'SILENT') {
            if (bargeInTransition.effects.includes('interrupt')) {
              interruptCurrentTurn('human_exchange');
            }
            dispatchBargeIn({ type: 'reset' });
            // Human-to-human speech is context, never a new autonomous prompt.
            const state = autonomyStateRef.current;
            const next = completeInactiveEpisodes({ ...state, reasons: state.reasons.map((reason) =>
              (reason.status === 'active' || reason.status === 'deferred')
                ? { ...reason, status: 'expired' as const } : reason) });
            autonomyStateRef.current = next;
            setAutonomyState(next);
            setExhibitionSessionMessage('お二人の会話を聞いています');
            setIsHumanExchange(true);
            return;
          }
          setExhibitionSessionMessage('');
          setIsHumanExchange(false);
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
          const voiceCardContext = readCardContext();
          cardDropReactionControllerRef.current.prepareReplyHandoff(
            voiceCardContext.forcedCardId,
          );
          cancelNonSpeechPlan();
          cancelActiveCardReactionPlan();
          setAutonomousContext((current) =>
            recordViewerIntent(current, message, identityForRequest),
          );
          const trigger: PerformerTrigger = {
            kind: 'viewer_message',
            text: message,
          };
          const plan = createPlanForTrigger(trigger);
          cardDropReactionControllerRef.current.handoffToReply(
            voiceCardContext.forcedCardId,
            plan.planId,
          );
          if (
            !plan.actionDecision ||
            plan.actionDecision.action === 'take_floor'
          ) {
            beginReply();
          }
          if (!isMuted) void prepare();
          handleConversationInputReceived(event.segmentId, Date.now());
          void sendVoice(
            message,
            voiceCardContext,
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
    [isPublicExhibition, sharedQueue, reply, setDucked, autonomyStateRef, setAutonomyState, recordVoiceSignal, routerSnapshot.gptInputGate, observeRouterSignal, recordAutonomyEvidence, dispatchBargeIn, activeBargeInSegmentRef, stopReaction, ttsPlaying, getPrimaryPlaybackAgeMs, source, rememberExplicitAlias, isBusy, evaluateVoiceParticipation, readCardContext, cardDropReactionControllerRef, cancelNonSpeechPlan, cancelActiveCardReactionPlan, createPlanForTrigger, isMuted, prepare, handleConversationInputReceived, sendVoice, handleReplyAccepted, notifyMeaningfulAutonomyEvent, readAutonomyEvidenceContext, interruptCurrentTurn, beginReply],
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
        cardDropReactionControllerRef.current.handoffToReply(
          cardContextOverride?.forcedCardId ?? null,
          preactivatedPlan.planId,
        );
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
    [sessionGeneration, isAutonomousLoopEnabled, routerSnapshot.controlState, routerSnapshot.vayriaOutputGate, isMuted, isBusy, autonomyCandidate, autonomyStateRef, setAutonomyState, createPlanForTrigger, getDirectionContribution, isExhibitionMode, beginReply, sendAutonomous, readCardContext, autonomousContext, handleReplyAccepted, cardDropReactionControllerRef, cardReactionPlanIdsRef, handlePerformancePlan, handlePerformanceResult, pendingActivatedCardIdsRef, prepare, executeNonSpeechPlan],
  );

  const handleCardInserted = useCallback(
    (result: CardSwapResult) => {
      if (runtimeConfig.mode === 'public') {
        if (!isMuted) void prepare();
        void requestPublicSession();
      }
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
      const reducedMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      const canStartCardDropReaction =
        activePlanRef.current === null && !isBusy;
      const cardDropReaction = canStartCardDropReaction
        ? cardDropReactionControllerRef.current.begin(
          result,
          runtimeConfig.cardDropReactionMode,
          reducedMotion,
        )
        : null;
      if (!canStartCardDropReaction) {
        cardDropReactionControllerRef.current.supersede();
        cardDropReactionPlanIdsRef.current.clear();
      }
      if (cardDropReaction) {
        spatialTargetRegistry.refreshDefault('game');
        if (!reducedMotion) {
          cardAttentionEnergyControllerRef.current.trigger(
            readAnimationNow(),
            logicalAttentionRef.current.gazeStrength ??
            logicalAttentionRef.current.strength,
          );
          scheduleCardDefaultAttention();
        }
        const reactionPlan = createPlanForTrigger(
          cardDropReaction.trigger,
          cardDropReaction.contribution,
        );
        cardDropReactionControllerRef.current.bindReactionPlan(
          reactionPlan.planId,
        );
        cardDropReactionPlanIdsRef.current.add(reactionPlan.planId);
        executeNonSpeechPlan(reactionPlan);
      }
      if (!isAutonomousLoopEnabled || isMuted) return;
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
    [activateCardSwap, cardAttentionEnergyControllerRef, cardDropReactionControllerRef, cardDropReactionPlanIdsRef, createPlanForTrigger, executeNonSpeechPlan, isAutonomousLoopEnabled, isBusy, isMuted, notifyMeaningfulAutonomyEvent, prepare, programContext, recordAutonomyEvidence, scheduleCardDefaultAttention, spatialTargetRegistry],
  );

  const handleVoiceToggle = useCallback(async () => {
    if (microphoneInputTransitionRef.current !== null) return;

    const transition = isVoiceInputEnabled ? 'stopping' : 'starting';
    microphoneInputTransitionRef.current = transition;
    setMicrophoneInputTransition(transition);
    try {
      if (isVoiceInputEnabled) {
        await stopVoiceInput();
        return;
      }

      if (runtimeConfig.mode === 'public') {
        void prepare();
        if (!(await requestPublicSession())) return;
      }
      if (!(await startVoiceInput())) return;
      void prepare();
      preloadBackchannel();
    } finally {
      microphoneInputTransitionRef.current = null;
      setMicrophoneInputTransition(null);
    }
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
    isLoopEnabled: isAutonomousLoopEnabled && !comparisonPlaying && !isHumanExchange && (runtimeConfig.mode !== 'public' || publicSessionActive),
    isMuted,
    isReady:
      isAvatarReady && (!isExhibitionMode || isAudioUnlocked),
    onCandidate: startAutonomous,
    onGateEvent: emitAutonomyGateEvent,
    sessionGeneration,
    timing: autonomyTurnGateTiming,
    timingMode: runtimeConfig.autonomyTimingMode,
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedInput || isManualBusy || publicSubmitPendingRef.current || publicTransitionRef.current) return;
    const submittedGeneration = sharedGenerationRef.current;
    if (runtimeConfig.mode === 'public') {
      if (!isMuted) void prepare();
      publicSubmitPendingRef.current = true;
      setPublicSubmitPending(true);
      try { if (!(await requestPublicSession())) return; }
      finally { publicSubmitPendingRef.current = false; setPublicSubmitPending(false); }
      setPublicTextInputOpen(false);
    }
    if (submittedGeneration !== sharedGenerationRef.current) return;
    viewerInputSequenceRef.current += 1;
    if (isPublicExhibition && textInputAudience === 'room') {
      sharedQueue.speechEnded(); sharedQueue.append(trimmedInput); setInput(''); return;
    }
    if (isExhibitionMode && textInputAudience === 'room') {
      const participation = evaluateVoiceParticipation({
        segmentId: `room-text:${Date.now()}:${viewerInputSequenceRef.current}`,
        text: trimmedInput, at: Date.now(),
      }, characterIdentityRef.current);
      if (participation.decision === 'SILENT') {
        const state = autonomyStateRef.current;
        const next = completeInactiveEpisodes({ ...state, reasons: state.reasons.map((reason) =>
          (reason.status === 'active' || reason.status === 'deferred')
            ? { ...reason, status: 'expired' as const } : reason) });
        autonomyStateRef.current = next;
        setAutonomyState(next);
        setInput('');
        setIsHumanExchange(true);
        setExhibitionSessionMessage('お二人の会話を聞いています');
        return;
      }
    }
    setIsHumanExchange(false);
    setExhibitionSessionMessage('');
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
    const manualCardContext = readCardContext();
    cardDropReactionControllerRef.current.prepareReplyHandoff(
      manualCardContext.forcedCardId,
    );
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
    cardDropReactionControllerRef.current.handoffToReply(
      manualCardContext.forcedCardId,
      plan.planId,
    );
    if (!plan.actionDecision || plan.actionDecision.action === 'take_floor') {
      beginReply();
    }
    if (!isMuted) void prepare();
    setInput('');
    void sendManual(
      trimmedInput,
      manualCardContext,
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
    return voiceStarted;
  }, [
    isMuted,
    lastAudibleVolume,
    preloadBackchannel,
    prepare,
    startVoiceInput,
    volume,
  ]);

  const handleMicrophoneControlToggle = useCallback(() => {
    if (microphoneInputTransitionRef.current !== null) return;

    if (isVoiceInputEnabled && !voiceError) {
      setIsMicrophoneControlExpanded(true);
      return;
    }

    microphoneInputTransitionRef.current = 'starting';
    setMicrophoneInputTransition('starting');
    void handleExhibitionAudioUnlock().finally(() => {
      microphoneInputTransitionRef.current = null;
      setMicrophoneInputTransition(null);
    });
  }, [
    handleExhibitionAudioUnlock,
    isVoiceInputEnabled,
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

  const registerChatTarget = useCallback(
    (element: HTMLElement | null) => {
      spatialTargetRegistry.registerDefault('chat', element);
    },
    [spatialTargetRegistry],
  );

  const isLocalNetworkAvailable = networkState.localNetwork === 'available';
  const isInternetAvailable = networkState.internet === 'available';
  const localNetworkLabel = `Local network: ${isLocalNetworkAvailable ? 'Connected' : 'Unavailable'}`;
  const internetLabel = `Internet: ${isInternetAvailable ? 'Connected' : 'Unavailable'}`;

  return (
    <main
      className="app-shell"
      data-app-mode={runtimeConfig.mode}
      data-ui-mode={usesExhibitionUi ? 'exhibition' : 'local'}
      data-public-text-input={publicTextInputOpen}
      data-exhibition-experience={isExhibitionMode}
      data-exhibition-state={exhibitionPresentationState}
      data-exhibition-cards={showExhibitionCards ? 'open' : 'closed'}
      data-exhibition-text={(isPublicExhibition ? publicTextInputOpen : showExhibitionText) ? 'open' : 'closed'}
    >
      {runtimeConfig.mode !== 'public' && (shouldShowAudioUnlockControl || isExhibitionMode) && (
        <header className="app-title">
          {!usesExhibitionUi && <span>Vayria</span>}
          {isExhibitionMode && (
            <div
              aria-label={`展示ネットワーク状態。${localNetworkLabel}。${internetLabel}。`}
              className="exhibition-network-status"
              data-internet={networkState.internet}
              data-local-network={networkState.localNetwork}
              role="status"
            >
              <span
                aria-label={localNetworkLabel}
                className="exhibition-network-status__item"
                data-state={networkState.localNetwork}
                role="img"
                title={localNetworkLabel}
              >
                <WifiStatusIcon unavailable={!isLocalNetworkAvailable} />
              </span>
              <span
                aria-label={internetLabel}
                className="exhibition-network-status__item"
                data-state={networkState.internet}
                role="img"
                title={internetLabel}
              >
                <InternetStatusIcon unavailable={!isInternetAvailable} />
              </span>
            </div>
          )}
          <div
            className="audio-controls"
            aria-label="音声コントロール"
            role="group"
          >
            {isExhibitionMode ? (
              <>
                <div
                  ref={microphoneControlRef}
                  className="microphone-control"
                  data-expanded={isMicrophoneControlExpanded ? 'true' : 'false'}
                >
                  <button
                    aria-controls={EXHIBITION_MICROPHONE_PANEL_ID}
                    aria-expanded={isMicrophoneControlExpanded}
                    aria-label={microphoneDisclosureLabel}
                    aria-busy={isMicrophoneInputTransitionPending}
                    className="audio-unlock-button microphone-disclosure-button"
                    data-input-active={isMicrophoneInputActive ? 'true' : 'false'}
                    data-state={microphoneInputVisualState}
                    data-threshold-crossing={
                      isThresholdCurrentlyCrossed ? 'true' : 'false'
                    }
                    disabled={isMicrophoneInputTransitionPending}
                    onClick={handleMicrophoneControlToggle}
                    style={microphoneFeedbackStyle}
                    title={`${microphoneDisclosureLabel}。${microphoneStatusLabel}`}
                    type="button"
                  >
                    <MicrophoneIcon />
                    <span className="visually-hidden">
                      {`${microphoneDisclosureLabel}。${microphoneStatusLabel}。`}
                    </span>
                  </button>
                  <div
                    aria-label="マイク入力と反応ライン"
                    className="microphone-adjuster"
                    data-gate={browserGateAvailable ? 'enabled' : 'disabled'}
                    data-state={microphoneInputVisualState}
                    data-threshold-crossing={
                      isThresholdCurrentlyCrossed ? 'true' : 'false'
                    }
                    hidden={!isMicrophoneControlExpanded}
                    id={EXHIBITION_MICROPHONE_PANEL_ID}
                  >
                    <div
                      aria-label="マイク入力レベル"
                      aria-valuemax={MICROPHONE_METER_MAX}
                      aria-valuemin={0}
                      aria-valuenow={microphoneMeterValue}
                      aria-valuetext={
                        displayedAudioLevel === null
                          ? '入力レベル未取得'
                          : `入力レベル ${displayedAudioLevel.toFixed(3)}`
                      }
                      className="microphone-vertical-meter"
                      role="meter"
                    >
                      <span
                        className="microphone-vertical-meter__fill"
                        style={{ height: `${microphoneLevelPercent}%` }}
                      />
                      {effectiveThresholdPercent !== null && (
                        <span
                          aria-hidden="true"
                          className="microphone-vertical-meter__threshold"
                          style={{ bottom: `${effectiveThresholdPercent}%` }}
                        />
                      )}
                      <span className="visually-hidden">
                        {displayThreshold === null
                          ? '実効反応ラインは利用できません'
                          : `実効反応ライン ${displayThreshold.toFixed(3)}`}
                      </span>
                      <input
                        aria-label="マイクの反応ライン設定"
                        aria-valuemax={VAD_THRESHOLD_MAX}
                        aria-valuemin={VAD_THRESHOLD_MIN}
                        aria-valuenow={microphoneThresholdSettingValue}
                        aria-valuetext={`設定した反応ライン ${microphoneThresholdSettingValue.toFixed(3)}`}
                        className="microphone-vertical-meter__input"
                        disabled={!browserGateAvailable}
                        max={VAD_THRESHOLD_MAX}
                        min={VAD_THRESHOLD_MIN}
                        onInput={(event) =>
                          handleVadThresholdChange(
                            Number(event.currentTarget.value),
                          )
                        }
                        step={VAD_THRESHOLD_STEP}
                        type="range"
                        value={microphoneThresholdSettingValue}
                      />
                    </div>
                    <button
                      aria-label={microphoneToggleLabel}
                      aria-busy={isMicrophoneInputTransitionPending}
                      aria-pressed={isMicrophoneInputVisuallyEnabled}
                      className="microphone-adjuster__toggle"
                      data-state={microphoneInputVisualState}
                      disabled={isMicrophoneInputTransitionPending}
                      onClick={handleVoiceToggle}
                      title={microphoneToggleLabel}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="microphone-adjuster__switch"
                      >
                        <span className="microphone-adjuster__switch-thumb" />
                      </span>
                      <span className="visually-hidden">
                        {microphoneToggleLabel}
                      </span>
                    </button>
                  </div>
                </div>
                <div
                  className="attention-controls"
                  aria-label="視線追従コントロール"
                  role="group"
                >
                  <button
                    aria-label={
                      cameraAttentionIsStarting
                        ? '視線追従を準備中'
                        : cameraAttentionEnabled
                          ? '視線追従を停止する'
                          : '視線追従を有効化する'
                    }
                    aria-pressed={cameraAttentionEnabled}
                    className="attention-button"
                    data-state={
                      cameraAttentionIsStarting
                        ? 'starting'
                        : cameraAttentionEnabled
                          ? 'on'
                          : 'off'
                    }
                    disabled={cameraAttentionIsStarting}
                    onClick={handleCameraAttentionToggle}
                    title={cameraAttentionButtonTitle}
                    type="button"
                  >
                    <CameraIcon />
                    <span className="visually-hidden">
                      {cameraAttentionIsStarting
                        ? '視線追従を準備中…'
                        : cameraAttentionEnabled
                          ? '視線追従を停止'
                          : '視線追従を有効化'}
                    </span>
                  </button>
                  {cameraAttentionStatusMessage &&
                    cameraAttentionStatus !== 'idle' &&
                    cameraAttentionStatus !== 'active' && (
                      <span
                        className="attention-status"
                        role="status"
                        aria-live="polite"
                      >
                        {cameraAttentionStatusMessage}
                      </span>
                    )}
                </div>
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
          stageVariant={runtimeConfig.mode === 'public' ? 'public' : 'default'}
          attentionReader={readAttention}
          emotion={displayEmotion}
          isExhibitionMode={usesExhibitionUi}
          emotionIntensity={activeEmotionCue?.intensity ?? 1}
          listeningReaction={listeningReaction}
          mouthOpen={mouthOpen}
          onReady={handleAvatarReady}
          performancePlan={activePlan ?? undefined}
          ref={stageRef}
          sessionGeneration={sessionGeneration}
          spatialTargetRegistry={spatialTargetRegistry}
        />
        {isExhibitionMode && (
          <aside className="exhibition-copy" aria-label="展示案内">
            <p className="exhibition-copy__title">ここにいる、Vayria。</p>
            <p className="exhibition-copy__hint">
              ひとこと、話しかけてみて。
            </p>
          </aside>
        )}
        {isExhibitionMode && (
          <nav className="exhibition-invitation" aria-label="体験の切り替え">
            <button type="button" className="exhibition-call" disabled={!canNoticeViewer || isResettingExhibition || comparisonPlaying}
              onClick={async () => {
                if (isPublicExhibition) {
                  const requestedGeneration = sharedGenerationRef.current;
                  if (!(await requestPublicSession()) || requestedGeneration !== sharedGenerationRef.current) return;
                  sharedQueue.speechEnded(); sharedQueue.append(isHumanExchange ? 'Vayria、今の話を聞いてどう思う？' : 'Vayria、こんにちは。');
                  return;
                }
                viewerInputSequenceRef.current += 1;
                setIsHumanExchange(false);
                setExhibitionSessionMessage('');
                noticeViewer();
                if (!isMuted && isAudioUnlocked && isAutonomousLoopEnabled) {
                  const content = isHumanExchange
                    ? '人間の参加者が「Vayriaに振る」を押して、直前のお二人の会話にあなたを招いた。共有文脈に沿って短い意見や補足を一つ返してよい。誰の意見か断定せず、自分もその場の一人として話す。'
                    : '来場者が「呼んでみる」を押して、あなたの注意を引いた。短く反応してもよい。カメラで見えた、声が聞こえたとは言わない。説明を始めず、相手の次の言葉を待ってよい。';
                  recordAutonomyEvidence({ id: `viewer-call:${Date.now()}`, kind: 'interaction_state_change',
                    at: Date.now(), semanticKey: 'viewer-call', content,
                    wakeConditions: ['new_evidence', 'floor_available'],
                    reasonProposals: [{ kind: 'participant_reengagement', content,
                      semanticKey: 'viewer-call', salience: 0.8 }] });
                }
              }}>
              {isHumanExchange ? 'Vayriaに振る' : '呼んでみる'}
            </button>
            <button type="button" aria-pressed={showExhibitionCards}
              onClick={() => setShowExhibitionCards((value) => !value)}>
              {showExhibitionCards ? '会話にもどる' : 'カードで、ちょっといたずら'}
            </button>
            <button type="button" aria-pressed={isPublicExhibition ? publicTextInputOpen : showExhibitionText}
              onClick={() => { setShowExhibitionText(value => !value); setPublicTextInputOpen(value => !value); }}>
              {(isPublicExhibition ? publicTextInputOpen : showExhibitionText) ? '文字入力を閉じる' : '文字で話す'}
            </button>
          </nav>
        )}
        {isExhibitionMode && (
          <details className="exhibition-operator">
            <summary>展示設定</summary>
            <div className="exhibition-operator__body">
              <p>出展者・Vayria・参加者の三者会話</p>
              <p>共用マイク：話者を自動で断定しません。</p>
              <p>取得チャンネル数：{(isPublicExhibition ? [...audioObservations].reverse().find(item => item.event === 'capture_acquired')?.channelCount : voiceInput.mediaSettings?.applied.channelCount) ?? '未取得'}<br />音声認識へ送る音：モノラル</p>
              <p>「Vayria、どう思う？」で会話に招けます。</p>
              {isPublicExhibition && <>
                <button type="button" disabled={cameraAttentionIsStarting} onClick={handleCameraAttentionToggle}>
                  {cameraAttentionEnabled ? '視線追従を止める' : 'カメラで視線追従'}
                </button>
                <label>音声経路（実験）<select value={exhibitionAudioMode} disabled={isResettingExhibition || comparisonPlaying}
                  onChange={event => void changePublicExperience('exhibition', event.target.value as ExhibitionAudioMode)}>
                  <option value="release_capture">録音を停止して再生（現在の方式）</option>
                  <option value="duplex_auto">同時録音・再生／auto</option>
                  <option value="duplex_record">同時録音・再生／play-and-record</option>
                </select></label>
                <details><summary>音声比較と診断</summary>
                  <p>同じ短い音声ファイルを選び、各経路で比較します。ファイルは端末内だけで再生します。</p>
                  <input type="file" accept="audio/*" aria-label="比較用の音声ファイル" disabled={comparisonPlaying} onChange={async event => {
                    const file = event.target.files?.[0];
                    if (file && file.size <= 8 * 1024 * 1024) setComparisonSample({ data: await file.arrayBuffer(), mimeType: file.type });
                    else { setComparisonSample(null); setExhibitionSessionMessage('8 MB以内の音声を選んでください'); }
                  }} />
                  <button type="button" disabled={!comparisonSample || comparisonPlaying || isResettingExhibition} onClick={() => void compareAudio(false)}>現在の経路で比較再生</button>
                  <button type="button" disabled={!comparisonSample || comparisonPlaying || isResettingExhibition} onClick={() => void compareAudio(true)}>マイクなしで比較再生</button>
                  <p>要求：1ch・エコーキャンセルあり・ノイズ抑制あり。下記は取得結果です。音声と本文は記録しません。</p>
                  <pre aria-label="音声診断">{JSON.stringify(audioObservations.slice(-8), null, 2)}</pre>
                </details>
              </>}
              <button type="button" disabled={runtimeConfig.routerEnabled || isResettingExhibition || isMicrophoneInputTransitionPending}
                onClick={() => void handleNextVisitor()}>
                {isResettingExhibition ? '切り替え中…' : '次の参加者へ'}
              </button>
              <p className="exhibition-operator__hint">会話とカードを初期化します。マイク使用中は再開します。</p>
              {runtimeConfig.routerEnabled && <p>Router使用中はRouterのResetを使います。</p>}
              {conversationError && <p className="exhibition-operator__error">{conversationError}</p>}
            </div>
          </details>
        )}
        <CardGamePrototype
          publicMicrophoneState={runtimeConfig.mode === 'public' ? publicMicrophoneState : undefined}
          game={cardGame}
          key={sessionGeneration}
          isResetLocked={isPerformerBusy}
          onCardAttentionInput={handleCardAttentionInput}
          onCardDragPositionChange={handleCardDragPositionChange}
          onCardDragActiveChange={handleCardDragActiveChange}
          onCardInteraction={handleCardInteraction}
          onCardInserted={handleCardInserted}
          onSessionReset={handleSessionReset}
          onSelectionActiveChange={setIsCardSelectionActive}
          spatialTargetRegistry={spatialTargetRegistry}
        />
      </section>

      <section
        className={`conversation conversation--${status}`}
        aria-label="Character conversation"
        ref={registerChatTarget}
      >
        <div className="conversation-copy" aria-live="polite">
          {shouldShowReply && <p className="reply">{reply}</p>}
          {shouldShowStatus && (
            <p className="status">
              {isExhibitionMode && exhibitionSessionMessage && status === 'idle'
                ? exhibitionSessionMessage
                : isMuted && status === 'idle'
                ? 'ミュート中です。テキスト会話は利用できます。'
                : conversationStatusLabel}
            </p>
          )}
          {needsPlaybackGesture && (
            <div className="playback-permission" role="alert">
              <p>音声の再生許可が必要です。</p>
              <button
                autoFocus
                className="playback-resume-button"
                type="button"
                onClick={() => void prepare()}
              >
                音声を再開
              </button>
            </div>
          )}
          {conversationError && !needsPlaybackGesture && (
            <p className="conversation-error" role="alert">
              {isExhibitionMode ? '今は返事を届けられません。展示スタッフにお声がけください。' : conversationError}
            </p>
          )}
          {isVoiceInputEnabled && !usesExhibitionUi && (
            <p className="voice-input-hint">
              {runtimeConfig.voiceTransport === 'remote'
                ? 'PCM音声サービスを使用中です。ヘッドセットを推奨します。'
                : 'ブラウザー音声認識を使用中です。ヘッドセットを推奨します。'}
            </p>
          )}
        </div>

        <form ref={runtimeConfig.mode === 'public' ? publicTextPanelRef : undefined} className="message-form" onSubmit={handleSubmit}>
          {isExhibitionMode && (
            <select aria-label="入力の宛先" value={textInputAudience}
              onChange={(event) => setTextInputAudience(event.target.value as 'vayria' | 'room')}>
              <option value="vayria">Vayriaへ</option>
              <option value="room">場の会話</option>
            </select>
          )}
          <label className="visually-hidden" htmlFor="message-input">
            キャラクターへ送るメッセージ
          </label>
          <input
            autoComplete="off"
            disabled={isManualBusy || publicSubmitPending}
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
          <button disabled={!trimmedInput || isManualBusy || publicSubmitPending} type="submit">
            {publicSubmitPending ? '確認中…' : '送信'}
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
      {runtimeConfig.mode === 'public' && (
        <PublicControls
          experience={publicExperience}
          onExperienceChange={next => void changePublicExperience(next)}
          experiencePending={isResettingExhibition || comparisonPlaying}
          themePreference={themePreference}
          resolvedTheme={resolvedTheme}
          onThemeChange={setThemePreference}
          isMuted={isMuted}
          onMuteToggle={handleMuteToggle}
          microphoneOn={isVoiceInputEnabled}
          microphoneState={publicMicrophoneState}
          microphoneLevel={displayedAudioLevel === null ? null : microphoneInputStrength}
          onMicrophoneToggle={() => { void handleVoiceToggle(); }}
        />
      )}
    </main>
  );
}
