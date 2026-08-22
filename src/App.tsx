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
import { useWildcardDirection } from './cards/wildcardDirection';
import { usePerformerRuntime } from './performer/usePerformerRuntime';
import type {
  PerformancePlan,
  PerformanceResult,
  PerformerTrigger,
} from './performer/types';
import { runtimeConfig } from './runtimeConfig';
import { fetchListeningBackchannels } from './voice/backchannel';
import {
  scheduleListeningBackchannel,
  selectListeningBackchannelIndex,
} from './voice/backchannelPolicy';
import { useVoiceInput } from './voice/useVoiceInput';
import { AudioLabPanel } from './voice/AudioLabPanel';
import { reduceBargeIn, type BargeInEvent } from './voice/bargeIn';
import {
  BARGE_IN_TIMEOUT_MS,
  clampVadThreshold,
  DEFAULT_VAD_THRESHOLD,
  isAudioLabMode,
  resolveInitialAudioLabMode,
  type AudioLabMode,
  type BargeInState,
} from './voice/audioLab.js';
import { useVoiceLab } from './voice/useVoiceLab';
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
    case 'insecure-context':
      return '音声入力にはHTTPS接続が必要です。VayriaをHTTPSで開いてください。';
    case 'audio-worklet-unsupported':
      return 'このブラウザーはPCM音声入力に対応していません。テキスト入力を利用してください。';
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
  const stageRef = useRef<VrmStageHandle>(null);
  const [stageMotionPort, setStageMotionPort] =
    useState<VrmStageHandle | null>(null);
  const nonSpeechTimerRef = useRef<number | null>(null);
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
  } = useAudioLipSync(volume);
  const [listeningReaction, setListeningReaction] =
    useState<ListeningReactionCue | undefined>();
  const [voiceValidationError, setVoiceValidationError] = useState('');
  const voiceEventHandlerRef = useRef<((event: VoiceInputEvent) => void) | null>(
    null,
  );
  const voiceReactionIdRef = useRef(0);
  const activeVoiceSegmentRef = useRef<string | null>(null);
  const backchannelAudioRef = useRef<ArrayBuffer[]>([]);
  const backchannelVariantIndexRef = useRef<number | null>(null);
  const backchannelLoadingRef = useRef<Promise<void> | null>(null);
  const backchannelTimerRef = useRef<number | null>(null);
  const bargeInTimerRef = useRef<number | null>(null);
  const bargeInStateRef = useRef<BargeInState>('idle');
  const [bargeInState, setBargeInState] = useState<BargeInState>('idle');
  const [bargeInTimeoutToken, setBargeInTimeoutToken] = useState(0);
  const [audioLabMode, setAudioLabMode] = useState<AudioLabMode>(
    () => resolveInitialAudioLabMode(runtimeConfig.audioLabEnabled),
  );
  const [vadThreshold, setVadThreshold] = useState(DEFAULT_VAD_THRESHOLD);
  const ttsPlaying = isSpeaking || isReactionPlaying;
  const voiceLab = useVoiceLab({
    enabled: runtimeConfig.audioLabEnabled,
    mode: audioLabMode,
    ttsPlaying,
  });
  const voiceInput = useVoiceInput({
    audioMode: audioLabMode,
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
  const playbackCoordinator = useMemo(
    () =>
      new PerformancePlaybackCoordinator({
        getMotionPort: () => stageMotionPort,
        playAudio: play,
        stopAudio: stop,
      }),
    [play, stageMotionPort, stop],
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
      if (result.outcome === 'failed') {
        setIsAutonomousLoopEnabled(false);
      }
      playbackCoordinator.stop();
      completePlan(result);
      activePlanRef.current = null;
      setActivePlan(null);
      setActiveEmotionCue(null);
    },
    [completePlan, playbackCoordinator],
  );

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
    });
  }, [handlePerformanceResult]);

  const {
    cancelAutonomous,
    error,
    interruptCurrentTurn,
    isBusy,
    isManualBusy,
    reply,
    resetConversation,
    sendAutonomous,
    sendManual,
    sendVoice,
    source,
    status,
  } = useConversation(playbackCoordinator, {
    historyLimit: 6,
    isMuted,
    onPerformanceCue: handlePerformanceCue,
    onPerformancePlan: handlePerformancePlan,
    onPerformanceResult: handlePerformanceResult,
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

      return transition;
    },
    [clearBargeInTimer, setDucked, ttsPlaying, voiceLab],
  );

  useEffect(() => {
    if (bargeInTimeoutToken === 0) return;
    dispatchBargeIn({ type: 'timeout' });
  }, [bargeInTimeoutToken, dispatchBargeIn]);

  useEffect(() => {
    if (audioLabMode === 'exhibition-mix' && ttsPlaying) return;
    if (bargeInStateRef.current !== 'ducked') return;
    dispatchBargeIn({ type: 'tts_stopped' });
  }, [audioLabMode, dispatchBargeIn, ttsPlaying]);

  useEffect(() => {
    if (audioLabMode === 'exhibition-mix') return;
    clearBargeInTimer();
    if (bargeInStateRef.current === 'idle') return;
    dispatchBargeIn({ type: 'reset' });
  }, [audioLabMode, clearBargeInTimer, dispatchBargeIn]);

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
    if (bargeInStateRef.current !== 'idle') {
      dispatchBargeIn({ type: 'reset' });
    } else {
      setDucked(false);
    }
    activeVoiceSegmentRef.current = null;
    setListeningReaction(undefined);
    backchannelVariantIndexRef.current = null;
    if (backchannelTimerRef.current !== null) {
      window.clearTimeout(backchannelTimerRef.current);
      backchannelTimerRef.current = null;
    }

    if (nonSpeechTimerRef.current !== null) {
      window.clearTimeout(nonSpeechTimerRef.current);
      nonSpeechTimerRef.current = null;
    }

    resetConversation();
    resetRuntime();
    resetTurn();
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
    stopVoiceInput,
  ]);

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

  const clearBackchannelTimer = useCallback(() => {
    if (backchannelTimerRef.current === null) return;
    window.clearTimeout(backchannelTimerRef.current);
    backchannelTimerRef.current = null;
  }, []);

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

  const handleVoiceEvent = useCallback(
    (event: VoiceInputEvent) => {
      switch (event.type) {
        case 'speech_started': {
          activeVoiceSegmentRef.current = event.segmentId;
          setVoiceValidationError('');
          const isBargeInCandidate =
            audioLabMode === 'exhibition-mix' && ttsPlaying;
          if (audioLabMode === 'exhibition-mix') {
            dispatchBargeIn({
              type: 'speech_started',
              ttsPlaying,
            });
          }
          voiceReactionIdRef.current += 1;
          setListeningReaction({
            id: voiceReactionIdRef.current,
            kind: 'nod',
            target: 'viewer',
          });
          clearBackchannelTimer();
          if (isBargeInCandidate) return;
          const segmentId = event.segmentId;
          const delayMs = scheduleListeningBackchannel();
          if (delayMs === null) return;
          backchannelTimerRef.current = window.setTimeout(() => {
            backchannelTimerRef.current = null;
            if (activeVoiceSegmentRef.current !== segmentId) return;
            const audioData = backchannelAudioRef.current;
            const variantIndex = selectListeningBackchannelIndex(
              audioData.length,
              backchannelVariantIndexRef.current,
            );
            if (variantIndex === null) return;
            const selectedAudio = audioData[variantIndex];
            if (!selectedAudio) return;
            void playReaction(selectedAudio).then((played) => {
              if (played) backchannelVariantIndexRef.current = variantIndex;
            });
          }, delayMs);
          return;
        }
        case 'speech_ended':
          clearBackchannelTimer();
          return;
        case 'utterance_finalized': {
          clearBackchannelTimer();
          activeVoiceSegmentRef.current = null;
          setListeningReaction(undefined);
          const message = event.text.trim();
          const acceptedForBargeIn =
            message.length > 0 && message.length <= MAX_VOICE_TEXT_LENGTH;
          const bargeInTransition =
            audioLabMode === 'exhibition-mix'
              ? dispatchBargeIn({
                  type: 'transcript_finalized',
                  accepted: acceptedForBargeIn,
                })
              : null;
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
          interruptCurrentTurn(
            bargeInTransition?.effects.includes('interrupt')
              ? 'voice_barge_in'
              : 'voice_interrupt',
          );
          if (bargeInTransition?.effects.includes('interrupt')) {
            dispatchBargeIn({ type: 'reset' });
          }
          const trigger: PerformerTrigger = {
            kind: 'viewer_message',
            text: message,
          };
          const plan = createPlanForTrigger(trigger);
          beginReply();
          if (!isMuted) void prepare();
          void sendVoice(message, readCardContext(), acceptReply, plan);
          return;
        }
        case 'recognition_stopped':
        case 'recognition_failed':
          clearBackchannelTimer();
          if (audioLabMode === 'exhibition-mix') {
            dispatchBargeIn({
              type:
                event.type === 'recognition_stopped'
                  ? 'recognition_stopped'
                  : 'recognition_failed',
            });
          }
          activeVoiceSegmentRef.current = null;
          setListeningReaction(undefined);
          return;
        case 'listening_started':
        case 'interim_transcript_updated':
          return;
      }
    },
    [
      acceptReply,
      beginReply,
      cancelNonSpeechPlan,
      clearBackchannelTimer,
      createPlanForTrigger,
      dispatchBargeIn,
      interruptCurrentTurn,
      isMuted,
      audioLabMode,
      playReaction,
      prepare,
      readCardContext,
      sendVoice,
      ttsPlaying,
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
        activePlanRef.current !== null
      ) {
        return false;
      }
      if (isExhibitionMode) {
        const audioReady = await prepare();
        if (!audioReady || !isCurrentSession()) return false;
      } else {
        void prepare();
      }
      if (
        !isCurrentSession() ||
        isMuted ||
        isBusy ||
        activePlanRef.current !== null
      ) {
        return false;
      }
      const trigger =
        options.trigger ?? ({ kind: 'idle_tick', elapsedMs: 0 } as const);
      const plan = createPlanForTrigger(
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
        acceptReply,
        plan,
      );
      if (!decision || !isCurrentSession()) return false;
      setAutonomousContext((current) =>
        advanceAutonomousContext(current, decision),
      );
      return true;
    },
    [
      acceptReply,
      autonomousContext,
      beginReply,
      createPlanForTrigger,
      executeNonSpeechPlan,
      getDirectionContribution,
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
    if (source === 'autonomous') cancelAutonomous();
    cancelNonSpeechPlan();
    const trigger: PerformerTrigger = {
      kind: 'viewer_message',
      text: trimmedInput,
    };
    const plan = createPlanForTrigger(trigger);
    beginReply();
    if (!isMuted) void prepare();
    setInput('');
    void sendManual(trimmedInput, readCardContext(), acceptReply, plan);
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
          attentionTarget={performer.state.attention.target}
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
          isInteractionLocked={isPerformerBusy}
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
          {reply && <p className="reply">{reply}</p>}
          <p className="status">
            {isMuted && status === 'idle'
              ? 'ミュート中です。テキスト会話は利用できます。'
              : conversationStatusLabel}
          </p>
          {conversationError && (
            <p className="conversation-error" role="alert">
              {conversationError}
            </p>
          )}
          {isVoiceInputEnabled && (
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
          bargeInState={bargeInState}
          effectiveThreshold={voiceInput.effectiveThreshold}
          isMicActive={isVoiceInputEnabled}
          isVoiceInputSupported={isVoiceInputSupported}
          isSttProcessing={voiceInput.isSttProcessing}
          isVadSpeech={voiceInput.isVadSpeech}
          mediaSettings={voiceInput.mediaSettings}
          mode={audioLabMode}
          onExport={voiceLab.downloadJsonl}
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
