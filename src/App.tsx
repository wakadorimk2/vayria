import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { VrmStage, type VrmStageHandle } from './avatar/VrmStage';
import { useAudioLipSync } from './audio/useAudioLipSync';
import { CardGamePrototype } from './cards/CardGamePrototype';
import { useCardGamePrototype } from './cards/useCardGamePrototype';
import { useAutonomousTalk } from './conversation/useAutonomousTalk';
import {
  useConversation,
  type AutonomousContext,
  type AutonomousDecision,
  type ChatCardContext,
} from './conversation/useConversation';
import type { CardSwapResult } from './cards/useCardGamePrototype';
import {
  CARD_INTERACTION_ATTENTION_DURATION_MS,
  shouldReactToCardInteraction,
} from './cards/cardReactions';
import { useWildcardDirection } from './cards/wildcardDirection';
import { usePerformerRuntime } from './performer/usePerformerRuntime';
import type {
  ConversationActionDecision,
  PerformancePlan,
  PerformanceResult,
  PerformerTrigger,
} from './performer/types';
import { runtimeConfig } from './runtimeConfig';
import { fetchListeningBackchannels } from './voice/backchannel';
import type { ListeningBackchannelAudio } from './voice/backchannelPolicy';
import {
  selectListeningBackchannelIndex,
} from './voice/backchannelPolicy';
import { useVoiceInput } from './voice/useVoiceInput';
import { AudioLabPanel } from './voice/AudioLabPanel';
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

type ExhibitionPresentationState = 'idle' | 'selecting' | 'reacting';

const AUDIO_SETTINGS_STORAGE_KEY = 'vayria.audio-settings.v1';
const LEGACY_AUDIO_SETTINGS_STORAGE_KEY = 'wildcard.audio-settings.v1';

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

function advanceAutonomousContext(
  current: AutonomousContext,
  decision: AutonomousDecision,
): AutonomousContext {
  if (decision.action === 'silence') return current;

  return {
    topic: decision.topic,
    topicTurns:
      decision.action === 'new_topic' || current.topic === null
        ? 1
        : current.topicTurns + 1,
  };
}

export default function App() {
  const [input, setInput] = useState('');
  const [isAvatarReady, setIsAvatarReady] = useState(false);
  const [isCardSelectionActive, setIsCardSelectionActive] = useState(false);
  const [cardAttentionTarget, setCardAttentionTarget] = useState<
    'game' | null
  >(null);
  const [audioControl, setAudioControl] = useState(readAudioControlState);
  const [autonomousContext, setAutonomousContext] =
    useState<AutonomousContext>({ topic: null, topicTurns: 0 });
  const [isAutonomousLoopEnabled, setIsAutonomousLoopEnabled] =
    useState(true);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const { isMuted, lastAudibleVolume, volume } = audioControl;
  const isExhibitionMode = runtimeConfig.mode === 'exhibition';
  const cardGame = useCardGamePrototype();
  const { acceptReply, beginReply, resetTurn, zones } = cardGame;
  const performer = usePerformerRuntime();
  const wildcardDirection = useWildcardDirection(zones);
  const {
    completePlan,
    createPlan,
    getNextAutonomousDelay: getRuntimeAutonomousDelay,
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
  const [voiceValidationError, setVoiceValidationError] = useState('');
  const voiceEventHandlerRef = useRef<((event: VoiceInputEvent) => void) | null>(
    null,
  );
  const voiceReactionIdRef = useRef(0);
  const activeBargeInSegmentRef = useRef<string | null>(null);
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
  const effectiveAudioEndpointMs = getEffectiveAudioEndpointMs(
    audioLabMode,
    audioEndpointMs,
  );
  const ttsPlaying = isSpeaking || isReactionPlaying;
  const voiceLab = useVoiceLab({
    enabled: runtimeConfig.audioLabEnabled,
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
    isEnabled: isVoiceInputEnabled,
    isSupported: isVoiceInputSupported,
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

      if (decision.action !== 'backchannel') {
        setListeningReaction(undefined);
        return;
      }

      setListeningReaction({
        id: reactionId,
        kind: 'nod',
        target: 'viewer',
      });
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
    clearSubtitle,
    error,
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
    onPerformanceCue: handlePerformanceCue,
    onPerformancePlan: handlePerformancePlan,
    onPerformanceResult: handlePerformanceResult,
    onInteractionAction: handleInteractionAction,
    onInteractionTimelineEvent: handleInteractionTimelineEvent,
  });

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
  const exhibitionAudioActionLabel = voiceError
    ? '音声とマイクを再試行'
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
    setAutonomousContext({ topic: null, topicTurns: 0 });
    setInput('');
    setIsAutonomousLoopEnabled(true);
    setSessionGeneration(nextGeneration);
  }, [
    clearBargeInTimer,
    dispatchBargeIn,
    resetConversation,
    resetRuntime,
    resetTurn,
    setDucked,
    stopReaction,
    stopVoiceInput,
  ]);

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
      recordVoiceSignal(event);
      switch (event.type) {
        case 'speech_started': {
          clearSubtitle();
          // Speech detection is only a candidate. Final text decides turn handoff.
          const isBargeInCandidate = ttsPlaying;
          if (isBargeInCandidate) {
            activeBargeInSegmentRef.current = event.segmentId;
          } else {
            activeBargeInSegmentRef.current = null;
          }
          stopReaction();
          stageRef.current?.stopReactionMotion();
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
          return;
        case 'utterance_finalized': {
          stopReaction();
          stageRef.current?.stopReactionMotion();
          setListeningReaction(undefined);
          const message = event.text.trim();
          const candidateSegmentId = activeBargeInSegmentRef.current;
          activeBargeInSegmentRef.current = null;
          const acceptedForBargeIn = isConfirmedBargeInTranscript(message);
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
          cancelNonSpeechPlan();
          cancelActiveCardReactionPlan();
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
      clearSubtitle,
      createPlanForTrigger,
      dispatchBargeIn,
      handleReplyAccepted,
      interruptCurrentTurn,
      isBusy,
      isMuted,
      prepare,
      recordVoiceSignal,
      readCardContext,
      sendVoice,
      ttsPlaying,
      stopReaction,
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
      contribution?: ReturnType<typeof getDirectionContribution>;
      trigger?: PerformerTrigger;
    } = {}) => {
      const expectedSessionGeneration = sessionGeneration;
      const isCurrentSession = () =>
        expectedSessionGeneration === sessionGenerationRef.current;

      if (
        !isCurrentSession() ||
        !isAutonomousLoopEnabled ||
        isMuted ||
        isBusy ||
        Boolean(activePlanRef.current)
      ) {
        return false;
      }

      const trigger =
        options.trigger ?? ({ kind: 'idle_tick', elapsedMs: 0 } as const);
      const isForcedCardTurn =
        options.contribution?.directionId === 'wildcard' &&
        options.cardContextOverride?.forcedCardId !== null &&
        options.cardContextOverride?.forcedCardId !== undefined;
      const preactivatedPlan: PerformancePlan | null = isForcedCardTurn
        ? createPlanForTrigger(
            trigger,
            options.contribution ?? getDirectionContribution(trigger),
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
          return false;
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
        return false;
      }
      const plan =
        preactivatedPlan ??
        createPlanForTrigger(
          trigger,
          options.contribution ?? getDirectionContribution(trigger),
        );
      if (plan.intent !== 'speak') {
        return executeNonSpeechPlan(plan);
      }
      beginReply();
      const decision = await sendAutonomous(
        options.cardContextOverride ?? readCardContext(),
        autonomousContext,
        handleReplyAccepted,
        plan,
      );
      if (!decision || !isCurrentSession()) return false;
      setAutonomousContext((current) =>
        advanceAutonomousContext(current, decision),
      );
      return true;
    },
    [
      autonomousContext,
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
      sendAutonomous,
      sessionGeneration,
    ],
  );

  const handleCardInserted = useCallback(
    (result: CardSwapResult) => {
      const trigger: PerformerTrigger = {
        kind: 'external_stimulus',
        semanticCue: `something_changed:${result.insertedCardId}`,
        metadata: { origin: 'wildcard' },
      };
      const contribution = activateCardSwap(result);
      if (!isAutonomousLoopEnabled || isMuted || isBusy) return;
      void startAutonomous({
        cardContextOverride: {
          brainCardIds: result.brainCardIds,
          forcedCardId: result.forcedCardId,
        },
        contribution,
        trigger,
      });
    },
    [
      activateCardSwap,
      isAutonomousLoopEnabled,
      isBusy,
      isMuted,
      startAutonomous,
    ],
  );

  const getNextAutonomousDelay = useCallback(
    () =>
      getRuntimeAutonomousDelay([
        getDirectionContribution({ kind: 'idle_tick', elapsedMs: 0 }),
      ]),
    [getDirectionContribution, getRuntimeAutonomousDelay],
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
    getNextAutonomousDelay,
    isBusy: isPerformerBusy,
    isVoiceInputActive: isVoiceInputEnabled,
    isLoopEnabled: isAutonomousLoopEnabled,
    isMuted,
    isReady:
      isAvatarReady && (!isExhibitionMode || isAudioUnlocked),
    onIdleTick: startAutonomous,
    sessionGeneration,
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedInput || isManualBusy) return;
    setIsAutonomousLoopEnabled(true);
    stopReaction();
    stageRef.current?.stopReactionMotion();
    if (source === 'autonomous') cancelAutonomous();
    cancelNonSpeechPlan();
    cancelActiveCardReactionPlan();
    const trigger: PerformerTrigger = {
      kind: 'viewer_message',
      text: trimmedInput,
    };
    const plan = createPlanForTrigger(trigger);
    if (!plan.actionDecision || plan.actionDecision.action === 'take_floor') {
      beginReply();
    }
    if (!isMuted) void prepare();
    setInput('');
    void sendManual(trimmedInput, readCardContext(), handleReplyAccepted, plan);
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
      {shouldShowAudioUnlockControl && (
        <header className="app-title">
          {!isExhibitionMode && <span>Vayria</span>}
          <div
            className="audio-controls"
            aria-label="音声コントロール"
            role="group"
          >
            {isExhibitionMode ? (
              <button
                aria-label={`${exhibitionAudioActionLabel}する`}
                className="audio-unlock-button"
                onClick={handleExhibitionAudioUnlock}
                title={`${exhibitionAudioActionLabel}します`}
                type="button"
              >
                {exhibitionAudioActionLabel}
              </button>
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
          attentionTarget={
            activePlan !== null
              ? performer.state.attention.target
              : cardAttentionTarget ?? performer.state.attention.target
          }
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
          onSessionReset={resetSession}
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
