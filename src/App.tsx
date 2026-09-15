import { SharedConversation } from './sharedWorld/SharedConversation';
import { sharedConversationActive } from './sharedWorld/voice';
import { sharedReplyPlayback } from './sharedWorld/replyPlayback';
import { useVisualGeneration } from './visual/useVisualGeneration';
import { useSharedWorld } from './sharedWorld/useSharedWorld';
import { SharedWorldStage } from './sharedWorld/SharedWorldStage';
import { WorldCards } from './sharedWorld/WorldCards';
import { worldAccess } from './sharedWorld/client';
import { VisualStage } from './visual/VisualStage';
import { visualContext } from './visual/session';
import { environmentStorageKey } from './storageKey';
import { calculateSettingsLayout, type AvatarScreenBounds } from './public/settingsLayout';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { ExhibitionMicrophoneControl } from './app/ExhibitionMicrophoneControl';
import { MuteVolumeControls } from './app/MuteVolumeControls';
import { useAudioControl } from './app/useAudioControl';
import { useAutonomyReasons } from './app/useAutonomyReasons';
import { publicActive, publicExhibition, runPublicAction, subscribePublic } from './public/session';
import { allowExhibitionAutonomy } from './public/exhibitionHandoff';
import { useBargeInControl } from './app/useBargeInControl';
import { useCardAttention } from './app/useCardAttention';
import { useExhibitionMicrophone } from './app/useExhibitionMicrophone';
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
import { useManifestation } from './manifestation/useManifestation';
import { manifestationContext } from './manifestation/session';
import { ManifestationStage } from './manifestation/ManifestationStage';
import { useWorldMutation } from './world/useWorldMutation';
import { WorldControls, WorldStage } from './world/WorldStage';
import { worldConversationContext } from './world/worldState';
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

const ROUTER_AUDIO_INPUT_DEVICE_STORAGE_KEY =
  'vayria.router.audio-input-device.v1';
const VOICE_NONVERBAL_REACTION_HOLD_MS = 650;

function readRouterAudioInputDeviceId(): string {
  try {
    return localStorage.getItem(environmentStorageKey(ROUTER_AUDIO_INPUT_DEVICE_STORAGE_KEY))?.trim() ?? '';
  } catch {
    return '';
  }
}

export default function App() {
  const themePreference = useSyncExternalStore(subscribeTheme, readThemePreference);
  const resolvedTheme = useSyncExternalStore(subscribeTheme, readResolvedTheme);
  const publicSessionActive = useSyncExternalStore(subscribePublic, publicActive);
  const exhibitionRegistration = useSyncExternalStore(subscribePublic, publicExhibition);
  const [input, setInput] = useState('');
  const [isAvatarReady, setIsAvatarReady] = useState(false);
  const [isCardSelectionActive, setIsCardSelectionActive] = useState(false);

  const { isMuted, lastAudibleVolume, volume, mute, unmute, setVolume } =
    useAudioControl();
  const [characterIdentity, setCharacterIdentity] = useState(
    readCharacterIdentity,
  );
  const [programPhase, setProgramPhase] = useState<ProgramPhase>(
    DEFAULT_PROGRAM_CONTEXT.phase,
  );
  const [autonomousContext, setAutonomousContext] =
    useState<AutonomousContext>(INITIAL_AUTONOMOUS_CONTEXT);

  const [isAutonomousLoopEnabled, setIsAutonomousLoopEnabled] =
    useState(true);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const { runtime: worldRuntime, snapshot: worldSnapshot } = useWorldMutation();
  const visual = useVisualGeneration();
  const sharedWorld = useSharedWorld();
  const sharedSequenceRef = useRef(-1);
  const sharedEpochRef = useRef<number | null>(null);
  const sharedOutcomeRef = useRef('');
  const resetVisual = visual.reset;
  const { runtime: manifestationRuntime, snapshot: manifestationSnapshot, bind: bindManifestation, newExperiment: newManifestationExperiment } = useManifestation();
  const worldReactionKeyRef = useRef(new Set<string>());
  const worldReactionPendingRef = useRef(false);
  const worldReactionRunningRef = useRef(false);
  const programContext = useMemo(
    () => ({ ...DEFAULT_PROGRAM_CONTEXT, phase: programPhase, ...(runtimeConfig.manifestationEnabled ? { worldContext: runtimeConfig.mode === 'public' ? visualContext(visual.snapshot) : manifestationContext(manifestationSnapshot) } : runtimeConfig.worldMutationEnabled ? { worldContext: worldConversationContext(worldSnapshot.world, worldSnapshot.observation, worldSnapshot.phase, worldSnapshot.event, worldSnapshot.propObservation, worldSnapshot.phase === 'idle' && worldSnapshot.displayedAt !== null ? worldSnapshot.pendingProps.length : 0, worldSnapshot.layout) } : {}) }),
    [visual.snapshot, manifestationSnapshot, programPhase, worldSnapshot.world, worldSnapshot.observation, worldSnapshot.phase, worldSnapshot.event, worldSnapshot.propObservation, worldSnapshot.displayedAt, worldSnapshot.pendingProps.length, worldSnapshot.layout],
  );
  const isExhibitionMode = runtimeConfig.mode === 'exhibition';
  const usesExhibitionUi = isExhibitionMode || runtimeConfig.mode === 'public' || runtimeConfig.worldMutationEnabled || runtimeConfig.manifestationEnabled;
  const [publicAvatarBounds, setPublicAvatarBounds] = useState<AvatarScreenBounds | null>(null);
  const [publicSettingsOpen, setPublicSettingsOpen] = useState(false);
  const publicSettingsLayout = calculateSettingsLayout(publicAvatarBounds);
  const [publicTextInputOpen, setPublicTextInputOpen] = useState(false);
  const [publicCardsOpen, setPublicCardsOpen] = useState(false);
  const [publicGreetingComplete, setPublicGreetingComplete] = useState(false);
  const publicCardsRef = usePanelVisibility<HTMLDivElement>(runtimeConfig.mode !== 'public' || publicCardsOpen, '.public-controls__cards');
  const togglePublicCards = () => { setPublicTextInputOpen(false); setPublicCardsOpen(value => !value); };
  const publicTextPanelRef = usePanelVisibility<HTMLFormElement>(runtimeConfig.mode !== 'public' || publicTextInputOpen, '.public-controls__text');
  const [publicSubmitPending, setPublicSubmitPending] = useState(false);
  const publicSubmitPendingRef = useRef(false);
  useEffect(() => {
    const toggle = () => { setPublicCardsOpen(false); setPublicTextInputOpen(value => !value); };
    window.addEventListener('vayria-public-text-input', toggle);
    return () => window.removeEventListener('vayria-public-text-input', toggle);
  }, []);
  const networkState = useNetworkState(isExhibitionMode);
  const [spatialTargetRegistry] = useState(
    () => new SpatialTargetRegistry(),
  );

  const cardGame = useCardGamePrototype(runtimeConfig.mode === 'public' || runtimeConfig.worldMutationEnabled || runtimeConfig.manifestationEnabled, runtimeConfig.worldMutationEnabled);
  const {
    acceptReply,
    insertSlotCard,
    readCardContext,
    beginReply,
    clearReplyPresentation,
    presentReply,
    resetCards,
    resetGame,
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

  const [pendingCardStimulus, setPendingCardStimulus] = useState<{
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
  useEffect(()=>{if(!sharedWorld.enabled)return;const unlock=()=>{if(!isMuted)void prepare();};window.addEventListener('pointerdown',unlock,{once:true});window.addEventListener('keydown',unlock,{once:true});return()=>{window.removeEventListener('pointerdown',unlock);window.removeEventListener('keydown',unlock);};},[sharedWorld.enabled,isMuted,prepare]);
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
  const { backchannelAudioRef, backchannelVariantIndexRef, backchannelLoadingRef, preloadBackchannel } = useListeningBackchannels(runtimeConfig.mode !== 'public');

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
        playAudio: async (...args) => { if (!sharedConversationActive()) await play(...args); },
        stopAudio: () => { if (!sharedConversationActive()) stop(); },
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
        if (sharedConversationActive()) return;
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
    [backchannelAudioRef, backchannelLoadingRef, backchannelVariantIndexRef, handleInteractionTimelineEvent, playReaction, stopReaction],
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

  const { cardDropReactionControllerRef, cardReactionPlanIdsRef, cardDropReactionPlanIdsRef, nonSpeechTimerRef, handlePerformanceResult, handleReplyAccepted: acceptReplyPresentation, cancelActiveCardReactionPlan, executeNonSpeechPlan, cancelNonSpeechPlan } = usePerformancePresentation({ activePlanRef, setActivePlan, setActiveEmotionCue, setIsAutonomousLoopEnabled, playbackCoordinator, completePlan, acceptReply, handlePerformancePlan, sessionGeneration, sessionGenerationRef });

  const handleReplyAccepted = useCallback((ids: string[], revision?: number) => {
    acceptReplyPresentation(ids, revision);
    if (runtimeConfig.mode === 'public' && ids.length > 0) setPublicGreetingComplete(true);
  }, [acceptReplyPresentation]);

  const handleCardReplyDelivered = useCallback((ids: string[], revision?: number) => {
    handleReplyAccepted(ids, revision);
    if (!ids.length || revision === undefined) return;
    let next = autonomyStateRef.current;
    const cardReasons = next.reasons.filter(reason => reason.status === 'active' &&
      reason.decisionEvidenceIds.some(id => id.startsWith('card-evidence:') && Number(id.slice(14)) <= revision));
    for (const reason of cardReasons) next = resolveUsedReasons(next, [reason.id], reason.episodeId);
    next = completeInactiveEpisodes(next);
    autonomyStateRef.current = next;
    setAutonomyState(next);
    setPendingCardStimulus(current => (current?.cardContext.swapRevision ?? Infinity) <= revision ? null : current);
  }, [handleReplyAccepted, autonomyStateRef, setAutonomyState]);
  const {
    cancelAutonomous,
    changeCardsDuringTurn,
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
    createCardContinuationPlan: trigger => createPlanForTrigger(trigger),
    historyTurnLimit: 5,
    isExhibitionMode,
    isMuted,
    characterIdentity,
    programContext,
    getPerformerStateContext,
    onPerformanceCue: handlePerformanceCue,
    onVisualStatus: (eventId, code, generation) => visual.runtime.status(eventId, code, generation),
    onVisualIntent: (eventId, intent, ticket, generation) => {
      if(sharedWorld.enabled)return;
      if (runtimeConfig.mode === 'public' && runtimeConfig.manifestationEnabled) visual.runtime.dispatch(eventId, intent, ticket, generation);
    },
    onManifestation: (eventId, cardId) => {
      if (!runtimeConfig.manifestationEnabled || runtimeConfig.mode === 'public') return;
      manifestationRuntime.dispatch({ eventId, cardId, sessionId: manifestationRuntime.id,
        generation: manifestationRuntime.getSnapshot().generation, clientId: 'public-context' });
    },
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
    if (runtimeConfig.worldMutationEnabled && status === 'speaking' && worldRuntime.getSnapshot().phase === 'idle') worldRuntime.markReactionStarted();
  }, [status, worldRuntime]);
  useEffect(() => {
    if (runtimeConfig.mode !== 'public') return;
    const stop = () => { sharedReplyPlayback.stop(); void stopVoiceInput(); interruptCurrentTurn('router_control'); stopReaction(); playbackCoordinator.stop(); };
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
        interactionAvailable: isAvatarReady && (!isMuted || pendingCardStimulus !== null),
      }),
    [
      autonomyState,
      isAvatarReady,
      isAutonomousLoopEnabled,
      isCardSelectionActive,
      isMuted,
      pendingCardStimulus,
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
  const conversationStatusLabel =
    status === 'idle'
      ? getVoiceStatusLabel(isVoiceInputEnabled, voiceInputPhase)
      : STATUS_LABELS[status];
  const shouldShowReply =
    Boolean(reply) && (!isExhibitionMode || isSubtitleVisible);
  const voiceError = getVoiceErrorMessage(voiceInputErrorCode);
  const microphone = useExhibitionMicrophone({
    audioControl: { isMuted, lastAudibleVolume, volume },
    audioLabMode,
    audioLevel,
    effectiveThreshold,
    isSttProcessing,
    isVadSpeech,
    isVoiceInputEnabled,
    preloadBackchannel,
    prepare,
    startVoiceInput,
    stopVoiceInput,
    unmute,
    vadThreshold,
    voiceError,
  });
  const publicMicrophoneState = getMicrophoneState({
    transition: microphone.transition,
    error: voiceError,
    enabled: isVoiceInputEnabled,
    recognizing: isSttProcessing,
    speaking: isVadSpeech || voiceInputPhase === 'speech_detected',
    recovering: voiceInputPhase === 'recovering',
  });
  const conversationError = error || voiceValidationError || (runtimeConfig.mode === 'public' ? '' : voiceError);
  const shouldShowStatus =
    (!usesExhibitionUi || !shouldShowReply) &&
    !(runtimeConfig.mode === 'public' && (
      (status === 'idle' && !isMuted) ||
      (status === 'error' && Boolean(conversationError))
    ));

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
  const shouldShowAudioUnlockControl =
    !isExhibitionMode ||
    !isAudioUnlocked ||
    !isVoiceInputEnabled ||
    Boolean(voiceError);

  const resetSession = useCallback(() => {
    worldRuntime.reset();
    resetVisual();
    manifestationRuntime.reset();
    if (runtimeConfig.worldMutationEnabled || runtimeConfig.manifestationEnabled) resetGame();
    worldReactionKeyRef.current.clear();
    worldReactionPendingRef.current = false;
    worldReactionRunningRef.current = false;
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

    clearCardAttentionTimers();
    dragAttentionControllerRef.current.end();
    dragAttentionSpeedRef.current = null;
    cardAttentionEnergyControllerRef.current.clear();
    cardAttentionStartedAtRef.current = null;
    spatialTargetRegistry.clearTransient('game');
    setCardAttentionPhase(null);

    resetConversation();
    setVoiceValidationError('');
    resetRuntime();
    resetCards();
    cardDropReactionControllerRef.current.reset();
    cardDropReactionPlanIdsRef.current.clear();
    cardReactionPlanIdsRef.current.clear();
    activePlanRef.current = null;
    setActivePlan(null);
    setActiveEmotionCue(null);
    setAutonomousContext(INITIAL_AUTONOMOUS_CONTEXT);
    const initialAutonomyState = createInitialAutonomyState();
    autonomyStateRef.current = initialAutonomyState;
    setAutonomyState(initialAutonomyState);
    setPendingCardStimulus(null);
    setProgramPhase(DEFAULT_PROGRAM_CONTEXT.phase);
    setInput('');
    setIsAutonomousLoopEnabled(true);
    setSessionGeneration(nextGeneration);
  }, [resetVisual, manifestationRuntime, resetCards, resetGame, worldRuntime, stopVoiceInput, clearBargeInTimer, activeBargeInSegmentRef, bargeInStateRef, stopReaction, backchannelVariantIndexRef, nonSpeechTimerRef, clearCardAttentionTimers, dragAttentionControllerRef, dragAttentionSpeedRef, cardAttentionEnergyControllerRef, cardAttentionStartedAtRef, spatialTargetRegistry, setCardAttentionPhase, resetConversation, resetRuntime, cardDropReactionControllerRef, cardDropReactionPlanIdsRef, cardReactionPlanIdsRef, autonomyStateRef, setAutonomyState, dispatchBargeIn, setDucked]);

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
    if (!runtimeConfig.routerEnabled) return;
    try {
      if (routerAudioInputDeviceId) {
        localStorage.setItem(
          environmentStorageKey(ROUTER_AUDIO_INPUT_DEVICE_STORAGE_KEY),
          routerAudioInputDeviceId,
        );
      } else {
        localStorage.removeItem(environmentStorageKey(ROUTER_AUDIO_INPUT_DEVICE_STORAGE_KEY));
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
          if (sharedConversationActive()) return;
          void sendVoice(
            message,
            voiceCardContext,
            handleCardReplyDelivered,
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
    [recordVoiceSignal, routerSnapshot.gptInputGate, observeRouterSignal, recordAutonomyEvidence, dispatchBargeIn, activeBargeInSegmentRef, stopReaction, ttsPlaying, getPrimaryPlaybackAgeMs, source, rememberExplicitAlias, isBusy, evaluateVoiceParticipation, readCardContext, cardDropReactionControllerRef, cancelNonSpeechPlan, cancelActiveCardReactionPlan, createPlanForTrigger, isMuted, prepare, handleConversationInputReceived, sendVoice, handleCardReplyDelivered, notifyMeaningfulAutonomyEvent, readAutonomyEvidenceContext, interruptCurrentTurn, beginReply],
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
      const stimulus = pendingCardStimulus;
      if(sharedWorld.snapshot?.sharedConversation)return 'aborted' as AutonomousTurnOutcome;
      if(sharedWorld.enabled&&(!worldAccess()||worldAccess()!.until<=Date.now()))return 'aborted' as AutonomousTurnOutcome;

      if (
        !isCurrentSession() ||
        !isAutonomousLoopEnabled ||
        (runtimeConfig.routerEnabled &&
          (routerSnapshot.controlState !== 'idle' ||
            routerSnapshot.vayriaOutputGate === 'closed')) ||
        (isMuted && !stimulus) ||
        isBusy ||
        Boolean(activePlanRef.current) ||
        (runtimeConfig.worldMutationEnabled && (worldRuntime.getSnapshot().phase === 'ready' || worldRuntime.getSnapshot().source === 'autonomous'))
      ) {
        return 'aborted' as AutonomousTurnOutcome;
      }

      const candidate = options.candidate ?? autonomyCandidate;
      if (!candidate) return 'aborted' as AutonomousTurnOutcome;
      if (!allowExhibitionAutonomy(!!exhibitionRegistration, !!stimulus)) return 'aborted' as AutonomousTurnOutcome;
      setPendingCardStimulus(null);
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

      if (!isMuted && isExhibitionMode) {
        const audioReady = await prepare();
        if (!audioReady || !isCurrentSession()) {
          cancelPreactivatedPlan();
          return 'aborted' as AutonomousTurnOutcome;
        }
      } else if (!isMuted) {
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
        (isMuted && !stimulus) ||
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
        readCardContext(),
        autonomousContext,
        handleCardReplyDelivered,
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
    [sharedWorld.enabled, sharedWorld.snapshot?.sharedConversation, pendingCardStimulus, exhibitionRegistration, worldRuntime, sessionGeneration, isAutonomousLoopEnabled, routerSnapshot.controlState, routerSnapshot.vayriaOutputGate, isMuted, isBusy, autonomyCandidate, autonomyStateRef, setAutonomyState, createPlanForTrigger, getDirectionContribution, isExhibitionMode, beginReply, sendAutonomous, readCardContext, autonomousContext, handleCardReplyDelivered, cardDropReactionControllerRef, cardReactionPlanIdsRef, handlePerformancePlan, handlePerformanceResult, prepare, executeNonSpeechPlan],
  );

  const handleCardInserted = useCallback(
    (result: CardSwapResult) => {
      if(sharedWorld.enabled){void sharedWorld.insert(result.insertedCardId);return;}
      if (runtimeConfig.worldMutationEnabled) {
        worldReactionPendingRef.current = false;
        void worldRuntime.card(result.insertedCardId, result.brainCardIds);
      }
      if (runtimeConfig.mode === 'public') {
        if (!isMuted) void prepare();
        void runPublicAction(() => true);
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
      changeCardsDuringTurn(readCardContext());
      const reducedMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      const canStartCardDropReaction =
        activePlanRef.current === null && !isBusy && !isVadSpeech && !isSttProcessing;
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
      if (!isAutonomousLoopEnabled) return;
      setPendingCardStimulus({
        cardContext: {
          brainCardIds: result.brainCardIds,
          forcedCardId: result.forcedCardId,
          swapRevision: result.animationSequence,
        },
        contribution,
        programContext: {
          ...programContext,
          phase: 'after_card_change',
        },
      });
    },
    [sharedWorld, changeCardsDuringTurn, readCardContext, isVadSpeech, isSttProcessing, worldRuntime, activateCardSwap, cardAttentionEnergyControllerRef, cardDropReactionControllerRef, cardDropReactionPlanIdsRef, createPlanForTrigger, executeNonSpeechPlan, isAutonomousLoopEnabled, isBusy, isMuted, notifyMeaningfulAutonomyEvent, prepare, programContext, recordAutonomyEvidence, scheduleCardDefaultAttention, spatialTargetRegistry],
  );

  useEffect(() => {
    const receive=(event:Event)=>{
    const snapshot=(event as CustomEvent<import('./sharedWorld/useSharedWorld').WorldSnapshot>).detail;
    if(!sharedWorld.enabled||!snapshot)return;
    const access=worldAccess();
    if(!snapshot.sharedConversation&&access&&(!snapshot.host||snapshot.host.clientId!==access.clientId||snapshot.host.until<=snapshot.serverNow)){
      interruptCurrentTurn('router_control');stopReaction();playbackCoordinator.stop();void stopVoiceInput();
    }
    if(sharedEpochRef.current!==null&&sharedEpochRef.current!==snapshot.epoch){
      resetGame();resetCards();setPendingCardStimulus(null);
      sharedSequenceRef.current=-1;sharedOutcomeRef.current='';
    }
    sharedEpochRef.current=snapshot.epoch;
    const outcome=snapshot.outcomes.at(-1)??'';
    if(snapshot.sequence===sharedSequenceRef.current){
      if(!snapshot.sharedConversation&&outcome&&outcome!==sharedOutcomeRef.current){
        sharedOutcomeRef.current=outcome;
        recordAutonomyEvidence({id:`world-result:${snapshot.epoch}:${snapshot.revision}`,kind:'environment_change',at:Date.now(),semanticKey:'world:result',content:outcome,wakeConditions:['new_evidence'],reasonProposals:[{kind:'environment_change',content:outcome,semanticKey:'world:result',salience:.8}]});
        notifyMeaningfulAutonomyEvent('card_change');
        setPendingCardStimulus(current=>current??{cardContext:readCardContext(),contribution:{directionId:'wildcard',effects:[],constraints:[],semanticCues:[outcome],triggers:[]},programContext:{...programContext,phase:'after_card_change'}});
      }
      return;
    }
    sharedOutcomeRef.current=outcome;
    sharedSequenceRef.current=snapshot.sequence;
    const latest=snapshot.history.at(-1);if(!latest)return;
    const result=insertSlotCard(latest.cardId);if(!result)return;
    const contribution=activateCardSwap(result);
    if(snapshot.sharedConversation)return;
    recordAutonomyEvidence({id:`shared-world:${snapshot.epoch}:${latest.sequence}`,kind:'environment_change',at:Date.now(),semanticKey:`world:${latest.cardId}`,content:`世界にカードが加わった: ${latest.cardId}`,wakeConditions:['new_evidence','interaction_state_changed'],reasonProposals:[{kind:'environment_change',content:`カードの蓄積を受け止める: ${latest.cardId}`,semanticKey:`world:${latest.cardId}`,salience:.85}]});
    notifyMeaningfulAutonomyEvent('card_change');
    changeCardsDuringTurn(readCardContext());
    setPendingCardStimulus({cardContext:{brainCardIds:result.brainCardIds,forcedCardId:result.forcedCardId,swapRevision:result.animationSequence},contribution,programContext:{...programContext,phase:'after_card_change'}});
    };
    window.addEventListener('vayria-world-state',receive);return()=>window.removeEventListener('vayria-world-state',receive);
  },[sharedWorld.enabled,insertSlotCard,activateCardSwap,recordAutonomyEvidence,notifyMeaningfulAutonomyEvent,changeCardsDuringTurn,readCardContext,programContext,interruptCurrentTurn,stopReaction,playbackCoordinator,stopVoiceInput,resetGame,resetCards]);

  useEffect(() => {
    if (!runtimeConfig.manifestationEnabled || sharedWorld.enabled) return;
    visual.runtime.bind((id, description) => {
      recordAutonomyEvidence({ id: `visual:${id}`, kind: 'environment_change', at: Date.now(), semanticKey: `visual:${id}`, content: description, wakeConditions: ['new_evidence'], reasonProposals: [] });
    });
    bindManifestation(event => {
      if (runtimeConfig.mode === 'public') return true;
      const result = insertSlotCard(event.cardId);
      if (!result) return false;
      handleCardInserted(result);
      return true;
    }, (id, description) => {
      recordAutonomyEvidence({ id: `manifestation:${id}`, kind: 'environment_change', at: Date.now(), semanticKey: `manifestation:${id}`, content: description, wakeConditions: ['new_evidence', 'interaction_state_changed'], reasonProposals: [{ kind: 'environment_change', content: description, semanticKey: `manifestation:${id}`, salience: .85 }] });
      notifyMeaningfulAutonomyEvent('card_change');
    });
  }, [sharedWorld.enabled, visual.runtime, bindManifestation, insertSlotCard, handleCardInserted, recordAutonomyEvidence, notifyMeaningfulAutonomyEvent]);

  useEffect(() => {
    if (runtimeConfig.manifestationEnabled && ttsPlaying) manifestationRuntime.markAudioStarted();
  }, [ttsPlaying, manifestationRuntime]);

  useEffect(() => {
    if (!runtimeConfig.worldMutationEnabled) return;
    const key = `${worldSnapshot.generation}:${worldSnapshot.world.revision}:${worldSnapshot.phase === 'error' ? worldSnapshot.error : ''}`;
    if ((worldSnapshot.phase === 'pending' || worldSnapshot.phase === 'ready') && worldSnapshot.propDisplayedAt === null) return;
    if ((!worldSnapshot.world.revision && worldSnapshot.phase !== 'error') || worldReactionKeyRef.current.has(key)) return;
    worldReactionKeyRef.current.add(key);
    worldReactionPendingRef.current = true;
    const content = worldSnapshot.phase === 'error' ? '世界変換エラー。前の世界のまま。相棒として短く受け止める。' : `世界が実際に変わった。完成画像を観察して自然に反応する: ${worldSnapshot.event}`.slice(0, 120);
    recordAutonomyEvidence({ id: `world:${worldSnapshot.generation}:${worldSnapshot.world.revision}:${Date.now()}`, kind: 'environment_change', at: Date.now(), semanticKey: 'world:displayed', content, wakeConditions: ['new_evidence', 'floor_available'], reasonProposals: [{ kind: 'environment_change', content, semanticKey: 'world:displayed', salience: 0.98 }] });
  }, [worldSnapshot.generation, worldSnapshot.world.revision, worldSnapshot.phase, worldSnapshot.error, worldSnapshot.event, worldSnapshot.propDisplayedAt, recordAutonomyEvidence]);

  useEffect(() => {
    if (!runtimeConfig.worldMutationEnabled) return;
    const free = !isBusy && activePlanRef.current === null && !ttsPlaying && !isVadSpeech && !isSttProcessing && !document.hidden;
    if (free && !worldReactionRunningRef.current && worldRuntime.commitProps()) return;
    if (worldSnapshot.phase === 'ready' && free && !worldReactionRunningRef.current) { worldRuntime.commit(); return; }
    if (worldReactionPendingRef.current && !worldReactionRunningRef.current && free && isAvatarReady && !isMuted && isAutonomousLoopEnabled && autonomyCandidate) {
      worldReactionPendingRef.current = false;
      worldReactionRunningRef.current = true;
      const generation = sessionGenerationRef.current;
      void startAutonomous({ candidate: autonomyCandidate }).finally(() => {
        if (generation === sessionGenerationRef.current) worldReactionRunningRef.current = false;
      });
    }
  }, [worldSnapshot.phase, worldSnapshot.readyProps, worldSnapshot.world.revision, worldSnapshot.drive, isBusy, activePlan, ttsPlaying, isVadSpeech, isSttProcessing, isAvatarReady, isMuted, isAutonomousLoopEnabled, autonomyCandidate, startAutonomous, worldRuntime]);

  useEffect(() => {
    if (!runtimeConfig.worldMutationEnabled) return;
    const timer = window.setInterval(() => {
      const free = isAutonomousLoopEnabled && isAvatarReady && !isMuted && !isBusy && activePlanRef.current === null && !ttsPlaying && !isVadSpeech && !isSttProcessing && !isCardSelectionActive && !document.hidden && !worldReactionPendingRef.current && !worldReactionRunningRef.current && (!runtimeConfig.routerEnabled || (routerSnapshot.controlState === 'idle' && routerSnapshot.vayriaOutputGate === 'open'));
      worldRuntime.tick(free, zones.brain.map(card => card.id));
    }, 1000);
    return () => clearInterval(timer);
  }, [worldRuntime, isAutonomousLoopEnabled, isAvatarReady, isMuted, isBusy, ttsPlaying, isVadSpeech, isSttProcessing, isCardSelectionActive, routerSnapshot.controlState, routerSnapshot.vayriaOutputGate, zones.brain]);

  const handleVoiceToggle = microphone.handleVoiceToggle;

  useAutonomousTalk({
    cancelAutonomous,
    candidateKey: autonomyCandidateKey,
    candidateTelemetry: autonomyCandidateTelemetry,
    externalEventSignal: autonomyExternalEvent,
    hasCandidate: autonomyCandidate !== null,
    isBusy: isPerformerBusy || (runtimeConfig.worldMutationEnabled && (worldSnapshot.phase === 'ready' || worldSnapshot.readyProps > 0 || worldSnapshot.source === 'autonomous')),
    isVoiceActivityActive: isVadSpeech || isSttProcessing,
    isLoopEnabled: isAutonomousLoopEnabled && (runtimeConfig.mode !== 'public' || publicSessionActive),
    isMuted: isMuted && pendingCardStimulus === null,
    isReady:
      isAvatarReady && (!isExhibitionMode || isAudioUnlocked || (isMuted && pendingCardStimulus !== null)),
    onCandidate: startAutonomous,
    onGateEvent: emitAutonomyGateEvent,
    sessionGeneration,
    timing: autonomyTurnGateTiming,
    timingMode: runtimeConfig.autonomyTimingMode,
  });

  const submitMessage = async (message: string, greeting?: true, admitted = false): Promise<boolean> => {
    const text = message.trim();
    if (!text || isManualBusy || (!admitted && publicSubmitPendingRef.current)) return false;
    if (runtimeConfig.mode === 'public' && !admitted) {
      if (!isMuted) void prepare();
      publicSubmitPendingRef.current = true;
      setPublicSubmitPending(true);
      try { return await runPublicAction(() => submitMessage(text, greeting, true)); }
      finally { publicSubmitPendingRef.current = false; setPublicSubmitPending(false); }
    }
    if (admitted) setPublicSubmitPending(false);
    if(sharedWorld.snapshot?.sharedConversation){const accepted=await sharedWorld.send(text);if(accepted){setInput('');setPublicTextInputOpen(false);setPublicGreetingComplete(true);}return accepted;}
    if (
      runtimeConfig.routerEnabled &&
      routerSnapshot.vayriaOutputGate === 'closed' &&
      routerSnapshot.controlState !== 'human_override'
    ) {
      return false;
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
      text: text,
    };
    const identityForRequest = rememberExplicitAlias(text);
    let manualAutonomyEvidenceContext: AutonomyEvidenceContext | undefined;
    if (isContentBearingVoiceMessage(text)) {
      const semanticKey = `conversation:${text
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
        content: text,
        wakeConditions: ['new_evidence', 'floor_available'],
        reasonProposals: [
          {
            kind: 'conversation_continuation',
            content: text,
            semanticKey,
            salience: /[?？]/u.test(text) ? 0.9 : 0.68,
          },
        ],
      });
      notifyMeaningfulAutonomyEvent('viewer_speech');
      manualAutonomyEvidenceContext =
        readAutonomyEvidenceContext(nextAutonomyState, evidenceId) ?? undefined;
    }
    setAutonomousContext((current) =>
      recordViewerIntent(current, text, identityForRequest),
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
    if (runtimeConfig.mode === 'public') setPublicTextInputOpen(false);
    return await sendManual(
      text,
      manualCardContext,
      handleCardReplyDelivered,
      plan,
      identityForRequest,
      undefined,
      manualAutonomyEvidenceContext,
      greeting,
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitMessage(input);
  };

  const handleMuteToggle = () => {
    if (isMuted) {
      void prepare();
      unmute(volume > 0 ? volume : lastAudibleVolume);
    } else {
      stop();
      mute();
    }
  };

  const handleVolumeInput = (event: FormEvent<HTMLInputElement>) => {
    const inputVolume = Number(event.currentTarget.value) / 100;
    if (!Number.isFinite(inputVolume)) return;
    const nextVolume = Math.max(0, Math.min(inputVolume, 1));
    if (nextVolume === 0) {
      stop();
      setVolume(0);
      return;
    }

    if (isMuted) void prepare();
    setVolume(nextVolume);
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
      data-shared-world={sharedWorld.enabled} data-app-mode={runtimeConfig.mode} data-world-ui={runtimeConfig.worldMutationEnabled} data-manifestation-ui={runtimeConfig.manifestationEnabled}
      data-ui-mode={usesExhibitionUi ? 'exhibition' : 'local'}
      data-public-text-input={publicTextInputOpen}
      data-exhibition-state={exhibitionPresentationState}
    >
      {runtimeConfig.mode !== 'public' && !runtimeConfig.worldMutationEnabled && (shouldShowAudioUnlockControl || isExhibitionMode) && (
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
                <ExhibitionMicrophoneControl
                  controlRef={microphone.controlRef}
                  onDisclosureToggle={microphone.handleMicrophoneControlToggle}
                  onVadThresholdChange={handleVadThresholdChange}
                  onVoiceToggle={handleVoiceToggle}
                  view={microphone.view}
                />
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
              <MuteVolumeControls
                isMuted={isMuted}
                onMuteToggle={handleMuteToggle}
                onVolumeInput={handleVolumeInput}
                volume={volume}
              />
            )}
          </div>
        </header>
      )}

      <section className="avatar-area" aria-label="VRM character">
        {runtimeConfig.worldMutationEnabled && <WorldStage snapshot={worldSnapshot} runtime={worldRuntime} stage={stageRef} />}
        <VrmStage
          stageVariant={runtimeConfig.mode === 'public' || runtimeConfig.worldMutationEnabled || runtimeConfig.manifestationEnabled ? 'public' : 'default'}
          attentionReader={readAttention}
          emotion={displayEmotion}
          isExhibitionMode={usesExhibitionUi}
          listeningReaction={listeningReaction}
          mouthOpen={mouthOpen}
          onReady={handleAvatarReady}
          onScreenBounds={runtimeConfig.mode === 'public' ? setPublicAvatarBounds : undefined}
          horizontalOffset={runtimeConfig.mode === 'public' && publicSettingsOpen ? publicSettingsLayout.avatarOffset : 0}
          performancePlan={activePlan ?? undefined}
          ref={stageRef}
          sessionGeneration={sessionGeneration}
          spatialTargetRegistry={spatialTargetRegistry}
        />
        {isExhibitionMode && (
          <aside className="exhibition-copy" aria-label="展示案内">
            <p className="exhibition-copy__title">一枚替えると、どんな反応？</p>
            <p className="exhibition-copy__hint">
              カードでVayriaの話し方や連想が変わります。声を出さずに試せます。
            </p>
          </aside>
        )}
        {sharedWorld.enabled && <><SharedConversation onMotion={(asset,id)=>{void stageRef.current?.playReactionMotion(asset,id);}} snapshot={sharedWorld.snapshot} muted={isMuted} play={play} stop={stop} onEmotion={emotion=>setActiveEmotionCue({emotion,intensity:.7})}/><SharedWorldStage world={sharedWorld} stage={stageRef}/><WorldCards world={sharedWorld} compact expanded={publicCardsOpen} onToggle={togglePublicCards}/></>}{!sharedWorld.enabled && runtimeConfig.manifestationEnabled && runtimeConfig.mode === 'public' && <VisualStage runtime={visual.runtime} snapshot={visual.snapshot} stage={stageRef} />}{runtimeConfig.manifestationEnabled && runtimeConfig.mode !== 'public' && <ManifestationStage runtime={manifestationRuntime} snapshot={manifestationSnapshot} stage={stageRef} onSelection={setIsCardSelectionActive} onReset={handleSessionReset} onNewExperiment={() => { handleSessionReset(); newManifestationExperiment(); }} brain={zones.brain.map(card => card.id)} />}{(!runtimeConfig.manifestationEnabled || runtimeConfig.mode === 'public') && <div style={sharedWorld.enabled ? {display:"none"} : undefined} ref={publicCardsRef} id="public-card-panel" className={runtimeConfig.mode === 'public' ? 'public-card-panel' : undefined} data-open={publicCardsOpen}><CardGamePrototype
          isExchangeLocked={runtimeConfig.worldMutationEnabled && worldSnapshot.source === 'card' && (worldSnapshot.phase === 'pending' || worldSnapshot.phase === 'ready')}
          publicMicrophoneState={runtimeConfig.mode === 'public' ? publicMicrophoneState : undefined}
          key={sessionGeneration}
          game={cardGame}
          onAskQuestion={message => { void submitMessage(message); }}
          lastReply={!conversationError ? reply : undefined}
          isQuestionDisabled={isManualBusy || (runtimeConfig.routerEnabled && routerSnapshot.vayriaOutputGate === 'closed' && routerSnapshot.controlState !== 'human_override')}
          feedbackMessage={
            conversationError
              ? '返答を続けられませんでした。もう一度聞くか、最初からやり直せます。'
              : needsPlaybackGesture
                ? '音声の再生許可が必要です。下の「音声を再開」を押してください。'
                : isMuted
                  ? '音声はオフです。「今どんな気分？」と聞くと、字幕で返答を読めます。'
                  : status === 'idle'
                    ? zones.forcedCardId
                      ? 'カードを受け取りました。まだ返答がなければ、下のボタンで聞けます。'
                      : 'もう一枚替えても、ここで終えても大丈夫。'
                    : conversationStatusLabel
          }
          isResetLocked={isPerformerBusy && !runtimeConfig.worldMutationEnabled}
          onCardAttentionInput={handleCardAttentionInput}
          onCardDragPositionChange={handleCardDragPositionChange}
          onCardDragActiveChange={handleCardDragActiveChange}
          onCardInteraction={handleCardInteraction}
          onCardInserted={handleCardInserted}
          onSessionReset={handleSessionReset}
          onSelectionActiveChange={active => setIsCardSelectionActive(active && (runtimeConfig.mode !== 'public' || publicCardsOpen))}
          spatialTargetRegistry={spatialTargetRegistry}
        /></div>}
      </section>

      {runtimeConfig.manifestationEnabled && runtimeConfig.mode !== 'public' && <nav className="manifestation-actions" aria-label="会話の操作"><button onClick={() => { void handleVoiceToggle(); }} aria-pressed={isVoiceInputEnabled}>マイク</button><button onClick={() => setPublicTextInputOpen(value => !value)} aria-expanded={publicTextInputOpen}>文字で話す</button></nav>}
      {runtimeConfig.worldMutationEnabled && <WorldControls snapshot={worldSnapshot} runtime={worldRuntime} onReset={resetSession} isMuted={isMuted} onMute={handleMuteToggle} microphoneOn={isVoiceInputEnabled} onMicrophone={() => { void handleVoiceToggle(); }} onText={() => { void prepare(); setPublicTextInputOpen(value => !value); }} onNewExperiment={() => { resetSession(); void worldRuntime.newExperiment(); }} />}

      <section
        className={`conversation conversation--${status}`}
        aria-label="Character conversation"
        ref={registerChatTarget}
      >
        <div className="conversation-copy" aria-live="polite">
          {shouldShowReply && <p className="reply">{reply}</p>}
          {shouldShowStatus && (
            <p className="status">
              {isMuted && status === 'idle'
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
              {conversationError}
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

        <form id="public-text-panel" ref={runtimeConfig.mode === 'public' || runtimeConfig.worldMutationEnabled ? publicTextPanelRef : undefined} className="message-form" data-manifestation-open={publicTextInputOpen} onSubmit={handleSubmit}>
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
          sharedWorld={sharedWorld.enabled}
          queueStatus={sharedWorld.snapshot?.sharedConversation ? (sharedWorld.error || (sharedWorld.snapshot.conversationView?.slot ? (sharedWorld.snapshot.conversationView.slot.status==='running'?'返答を準備中…':`順番待ち ${sharedWorld.snapshot.conversationView.slot.position}`) : '')) : undefined}
          visualObjectPresent={runtimeConfig.manifestationEnabled && [...visual.snapshot.objects,...(visual.snapshot.ready??[])].some(o=>o.id!=='background')}
          generation={runtimeConfig.manifestationEnabled ? { enabled: visual.snapshot.enabled, busy: visual.busy, message: visual.message, toggle: visual.toggle } : undefined}
          settingsLayout={publicSettingsLayout}
          onSettingsOpenChange={setPublicSettingsOpen}
          cardsOpen={publicCardsOpen}
          textOpen={publicTextInputOpen}
          onCardsToggle={togglePublicCards}
          greetingComplete={publicGreetingComplete}
          greetingBusy={isManualBusy || publicSubmitPending}
          onGreeting={() => { void submitMessage('こんにちは', true); }}
          themePreference={themePreference}
          resolvedTheme={resolvedTheme}
          onThemeChange={setThemePreference}
          isMuted={isMuted}
          onMuteToggle={handleMuteToggle}
          microphoneOn={isVoiceInputEnabled}
          microphoneState={publicMicrophoneState}
          microphoneNotice={voiceInput.notice}
          microphoneLevel={microphone.displayedAudioLevel === null ? null : microphone.inputStrength}
          onMicrophoneToggle={() => { void handleVoiceToggle(); }}
        />
      )}
    </main>
  );
}
