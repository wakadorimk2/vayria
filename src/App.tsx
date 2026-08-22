import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { VrmStage } from './avatar/VrmStage';
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

const STATUS_LABELS = {
  idle: '話しかけてください。',
  thinking: '考えています…',
  synthesizing: '返答音声を作っています…',
  speaking: '話しています。',
  error: '処理を完了できませんでした。',
} as const;

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
  const { isMuted, lastAudibleVolume, volume } = audioControl;
  const isExhibitionMode = runtimeConfig.mode === 'exhibition';
  const cardGame = useCardGamePrototype();
  const { acceptReply, beginReply, zones } = cardGame;
  const performer = usePerformerRuntime();
  const wildcardDirection = useWildcardDirection(zones);
  const {
    completePlan,
    createPlan,
    getNextAutonomousDelay: getRuntimeAutonomousDelay,
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
  const nonSpeechTimerRef = useRef<number | null>(null);
  const {
    isAudioUnlocked,
    mouthOpen,
    play,
    prepare,
    stop,
  } = useAudioLipSync(volume);

  const handlePerformancePlan = useCallback((plan: PerformancePlan) => {
    activePlanRef.current = plan;
    setActivePlan(plan);
  }, []);

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
      completePlan(result);
      if (activePlanRef.current?.planId !== result.planId) return;
      activePlanRef.current = null;
      setActivePlan(null);
      setActiveEmotionCue(null);
    },
    [completePlan],
  );

  const executeNonSpeechPlan = useCallback(
    (plan: PerformancePlan) => {
      handlePerformancePlan(plan);
      if (nonSpeechTimerRef.current !== null) {
        window.clearTimeout(nonSpeechTimerRef.current);
      }
      nonSpeechTimerRef.current = window.setTimeout(() => {
        nonSpeechTimerRef.current = null;
        handlePerformanceResult({
          planId: plan.planId,
          completedAt: Date.now(),
          outcome: 'completed',
          trigger: plan.trigger,
          intent: plan.intent,
        });
      }, plan.preReaction?.leadBeforeSpeechMs ?? 0);
      return false;
    }, [handlePerformancePlan, handlePerformanceResult]);

  const {
    cancelAutonomous,
    error,
    isBusy,
    isManualBusy,
    reply,
    sendAutonomous,
    sendManual,
    source,
    status,
  } = useConversation(play, stop, {
    historyLimit: 6,
    isMuted,
    onPerformanceCue: handlePerformanceCue,
    onPerformancePlan: handlePerformancePlan,
    onPerformanceResult: handlePerformanceResult,
  });
  const displayEmotion = activeEmotionCue?.emotion ?? performer.state.emotion.value;
  const isPerformerBusy = isBusy || activePlan !== null;
  const exhibitionPresentationState: ExhibitionPresentationState = isPerformerBusy
    ? 'reacting'
    : isCardSelectionActive
      ? 'selecting'
      : 'idle';
  const trimmedInput = input.trim();
  const volumePercent = Math.round(volume * 100);

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

  const startAutonomous = useCallback(
    async (options: {
      cardContextOverride?: ChatCardContext;
      contribution?: ReturnType<typeof getDirectionContribution>;
      trigger?: PerformerTrigger;
    } = {}) => {
      if (isMuted || isBusy || activePlanRef.current !== null) return false;
      if (isExhibitionMode) {
        const audioReady = await prepare();
        if (!audioReady) return false;
      } else {
        void prepare();
      }
      if (isMuted || isBusy || activePlanRef.current !== null) return false;
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
      if (!decision) return false;
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
      isExhibitionMode,
      isBusy,
      isMuted,
      prepare,
      readCardContext,
      sendAutonomous,
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
      if (isMuted || isBusy) return;
      void startAutonomous({
        cardContextOverride: {
          brainCardIds: result.brainCardIds,
          forcedCardId: result.forcedCardId,
        },
        contribution,
        trigger,
      });
    },
    [activateCardSwap, isBusy, isMuted, startAutonomous],
  );

  const getNextAutonomousDelay = useCallback(
    () =>
      getRuntimeAutonomousDelay([
        getDirectionContribution({ kind: 'idle_tick', elapsedMs: 0 }),
      ]),
    [getDirectionContribution, getRuntimeAutonomousDelay],
  );

  useAutonomousTalk({
    cancelAutonomous,
    getNextAutonomousDelay,
    isBusy: isPerformerBusy,
    isMuted,
    isReady:
      isAvatarReady && (!isExhibitionMode || isAudioUnlocked),
    onIdleTick: startAutonomous,
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedInput || isManualBusy) return;
    if (source === 'autonomous') cancelAutonomous();
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

  const handleExhibitionAudioUnlock = () => {
    if (isMuted) {
      handleMuteToggle();
      return;
    }
    void prepare();
  };

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
    setIsAvatarReady(true);
  }, [prepare]);

  return (
    <main
      className="app-shell"
      data-app-mode={runtimeConfig.mode}
      data-exhibition-state={exhibitionPresentationState}
    >
      {(!isExhibitionMode || !isAudioUnlocked) && (
        <header className="app-title">
          {!isExhibitionMode && <span>Vayria</span>}
          <div
            className="audio-controls"
            aria-label="音声コントロール"
            role="group"
          >
            {isExhibitionMode ? (
              <button
                aria-label={
                  isMuted ? '音声をオンにする' : '音声を有効化する'
                }
                className="audio-unlock-button"
                onClick={handleExhibitionAudioUnlock}
                title="最初の音声再生を有効にします"
                type="button"
              >
                {isMuted ? '音声をオンにする' : '音声を有効化'}
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
          mouthOpen={mouthOpen}
          onReady={handleAvatarReady}
          performancePlan={activePlan ?? undefined}
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
              : STATUS_LABELS[status]}
          </p>
          {error && (
            <p className="conversation-error" role="alert">
              {error}
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
          <button disabled={!trimmedInput || isManualBusy} type="submit">
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
