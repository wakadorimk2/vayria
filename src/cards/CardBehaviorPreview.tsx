import { useCallback, useEffect, useRef, useState } from 'react';
import { VrmStage } from '../avatar/VrmStage';
import { useAudioLipSync } from '../audio/useAudioLipSync';
import type { Emotion } from '../character/emotion';
import type { PerformancePlan, PerformanceResult } from '../performer/types';
import { usePerformerRuntime } from '../performer/usePerformerRuntime';
import { cardPool } from './cardPool';
import {
  CARD_REACTION_AXES,
  CARD_REACTION_MODIFIER_FIELDS,
  CARD_REACTION_PROFILES,
  CARD_REACTION_UNMAPPED_FIELDS,
  createCardPreviewContribution,
  M1_INITIAL_BRAIN_CARD_IDS,
  type CardReactionModifierKey,
  type CardReactionProfile,
} from './cardReactions';
import { useCardPreviewConversation } from './useCardPreviewConversation';
import { WildcardCard } from './WildcardCard';
import type { DirectionModifiers } from '../performer/types';
import type { WildcardCardData } from './cardTypes';

const STATUS_LABELS = {
  idle: 'カードを選んでください。',
  thinking: 'カードの反応を考えています…',
  synthesizing: '返答音声を作っています…',
  speaking: 'カードの反応を話しています。',
  error: '実演を完了できませんでした。',
} as const;

const MODIFIER_LABELS: Readonly<Record<CardReactionModifierKey, string>> = {
  responseDelayMs: '返答遅延',
  initiative: '自律発話の積極性',
  emotionalInertia: '感情の残りやすさ',
  speechFragmentation: '発話の断片化',
  callbackTendency: '話題の呼び戻し',
  gazeDirectness: '視線の直接性',
  attentionStrength: '注目の強さ',
  energy: 'エネルギー',
  ttsRateScale: '話速補正',
  ttsIntonationScale: '抑揚補正',
  idleMotionWeight: 'アイドル動作',
  headYawBias: '首振り補正',
  semanticBiases: '意味の手がかり',
};

function formatSignedNumber(value: number): string {
  if (value === 0) return '0';
  return `${value > 0 ? '+' : ''}${Number(value.toFixed(2))}`;
}

function formatModifierValue(
  key: CardReactionModifierKey,
  value: DirectionModifiers[CardReactionModifierKey],
): string {
  if (key === 'semanticBiases') {
    return Array.isArray(value) && value.length ? value.join('、') : '中立';
  }

  if (typeof value !== 'number') return '中立';
  if (key === 'responseDelayMs') return `${formatSignedNumber(value)} ms`;
  return formatSignedNumber(value);
}

function ModifierList({
  fields,
  modifiers,
}: {
  fields: readonly CardReactionModifierKey[];
  modifiers: Partial<DirectionModifiers>;
}) {
  const entries = fields.flatMap((field) => {
    const value = modifiers[field];
    return value === undefined ? [] : [{ field, value }];
  });

  if (entries.length === 0) {
    return <p className="card-behavior-preview__neutral">中立</p>;
  }

  return (
    <dl className="card-behavior-preview__modifier-list">
      {entries.map(({ field, value }) => (
        <div key={field}>
          <dt>{MODIFIER_LABELS[field]}</dt>
          <dd>{formatModifierValue(field, value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReactionDetails({
  card,
  profile,
}: {
  card: WildcardCardData;
  profile: CardReactionProfile;
}) {
  return (
    <section
      aria-labelledby="card-behavior-detail-title"
      className="card-behavior-preview__details"
    >
      <p className="card-behavior-preview__eyebrow">確認</p>
      <h2 id="card-behavior-detail-title">{card.label}</h2>
      <p className="card-behavior-preview__card-kind">{card.kind}</p>
      <p className="card-behavior-preview__prompt">{card.prompt}</p>

      <div className="card-behavior-preview__axis-grid">
        {CARD_REACTION_AXES.map((axis) => (
          <section key={axis.id}>
            <h3>{axis.label}</h3>
            <p>{profile.axisSummaries[axis.id]}</p>
            <ModifierList
              fields={CARD_REACTION_MODIFIER_FIELDS[axis.id]}
              modifiers={profile.modifiers}
            />
          </section>
        ))}
      </div>

      <section className="card-behavior-preview__other-values">
        <h3>未分類のRuntime値</h3>
        <ModifierList
          fields={CARD_REACTION_UNMAPPED_FIELDS}
          modifiers={profile.modifiers}
        />
      </section>

      <p className="card-behavior-preview__lifecycle">
        通常の脳内効果は背景強度0.2です。交換直後は強制強度1.0で30秒かけて減衰し、発話を要求します。
      </p>
    </section>
  );
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = () => setPrefersReducedMotion(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return prefersReducedMotion;
}

export function CardBehaviorPreview() {
  const [selectedCardId, setSelectedCardId] = useState<string>(
    M1_INITIAL_BRAIN_CARD_IDS[0],
  );
  const [audioUnlockRequired, setAudioUnlockRequired] = useState(false);
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState<PerformancePlan | null>(null);
  const [activeEmotionCue, setActiveEmotionCue] = useState<{
    emotion: Emotion;
    intensity: number;
  } | null>(null);
  const activePlanRef = useRef<PerformancePlan | null>(null);
  const selectionGenerationRef = useRef(0);
  const prefersReducedMotion = usePrefersReducedMotion();
  const { mouthOpen, play, prepare, stop } = useAudioLipSync(1);
  const performer = usePerformerRuntime();
  const {
    completePlan,
    createPlan,
  } = performer;

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

  const preview = useCardPreviewConversation(play, stop, {
    onPerformanceCue: handlePerformanceCue,
    onPerformancePlan: handlePerformancePlan,
    onPerformanceResult: handlePerformanceResult,
  });
  const {
    cancelPreview,
    error: previewError,
    isBusy: isPreviewBusy,
    reply: previewReply,
    startPreview,
    status: previewStatus,
  } = preview;

  const selectedCard =
    cardPool.find((card) => card.id === selectedCardId) ?? cardPool[0];
  const selectedProfile = CARD_REACTION_PROFILES[selectedCard.id];
  const displayEmotion =
    activeEmotionCue?.emotion ?? performer.state.emotion.value;
  const isBusy = isPreviewBusy || activePlan !== null;

  const runPreview = useCallback(
    (cardId: string) => {
      const contribution = createCardPreviewContribution(cardId);
      const trigger = contribution.triggers[0];
      if (!trigger) return;
      const plan = createPlan(trigger, [contribution]);
      void startPreview(cardId, plan);
    },
    [createPlan, startPreview],
  );

  const selectCard = useCallback(
    async (cardId: string) => {
      selectionGenerationRef.current += 1;
      const selectionGeneration = selectionGenerationRef.current;
      setSelectedCardId(cardId);
      setPendingCardId(cardId);
      setAudioUnlockRequired(false);
      cancelPreview();

      const audioReady = await prepare();
      if (selectionGeneration !== selectionGenerationRef.current) return;
      if (!audioReady) {
        setAudioUnlockRequired(true);
        return;
      }

      setPendingCardId(null);
      runPreview(cardId);
    }, [cancelPreview, prepare, runPreview]);

  const unlockAudioAndRun = useCallback(async () => {
    const cardId = pendingCardId ?? selectedCard.id;
    const selectionGeneration = selectionGenerationRef.current;
    const audioReady = await prepare();
    if (!audioReady || selectionGeneration !== selectionGenerationRef.current) {
      setAudioUnlockRequired(true);
      return;
    }
    setAudioUnlockRequired(false);
    setPendingCardId(null);
    runPreview(cardId);
  }, [pendingCardId, prepare, runPreview, selectedCard.id]);

  const statusLabel = audioUnlockRequired
    ? '音声を有効化すると実演を開始します。'
    : previewStatus === 'error'
      ? STATUS_LABELS.error
      : STATUS_LABELS[previewStatus];

  return (
    <section
      aria-labelledby="card-behavior-preview-title"
      className="card-behavior-preview"
    >
      <header className="card-behavior-preview__header">
        <div>
          <p className="card-behavior-preview__eyebrow">M1 #2 / CARD BEHAVIOR</p>
          <h1 id="card-behavior-preview-title">Card Pool 実演</h1>
          <p className="card-behavior-preview__intro">
            カードを選ぶと、選択カードを強く反映したVRM反応、発話、音声を再生します。
          </p>
        </div>
        <a className="card-behavior-preview__back-link" href="/">
          会話画面へ戻る
        </a>
      </header>

      <div className="card-behavior-preview__layout">
        <section
          aria-label="カード反応のVRM実演"
          className="card-behavior-preview__stage-panel"
        >
          <div className="card-behavior-preview__stage">
            <VrmStage
              attentionTarget={performer.state.attention.target}
              emotion={displayEmotion}
              motionScale={prefersReducedMotion ? 0 : 1}
              mouthOpen={mouthOpen}
              performancePlan={activePlan ?? undefined}
            />
            <div className="card-behavior-preview__stage-overlay">
              <span className="card-behavior-preview__selected-label">
                選択中: {selectedCard.label}
              </span>
              <p aria-live="polite">{statusLabel}</p>
              {previewReply && (
                <p className="card-behavior-preview__reply">「{previewReply}」</p>
              )}
              {previewError && (
                <p className="card-behavior-preview__error" role="alert">
                  {previewError}
                </p>
              )}
              {audioUnlockRequired && (
                <button
                  className="card-behavior-preview__audio-button"
                  onClick={() => void unlockAudioAndRun()}
                  type="button"
                >
                  音声を有効化して実演
                </button>
              )}
            </div>
          </div>
        </section>

        {selectedProfile && (
          <ReactionDetails card={selectedCard} profile={selectedProfile} />
        )}
      </div>

      <section
        aria-labelledby="card-pool-title"
        className="card-pool-preview card-behavior-preview__pool"
      >
        <header className="card-pool-preview__header">
          <p className="card-behavior-preview__eyebrow">SELECT</p>
          <h2 id="card-pool-title">Card Pool</h2>
          <p className="card-behavior-preview__pool-hint">
            {isBusy
              ? '実演中でも別のカードを選ぶと、現在の実演を置き換えます。'
              : 'カードをタップ、またはキーボードで選択してください。'}
          </p>
        </header>
        <div aria-label="Card Poolのカード" className="card-grid">
          {cardPool.map((card) => (
            <WildcardCard
              card={card}
              key={card.id}
              onSelect={() => void selectCard(card.id)}
              state={card.id === selectedCard.id ? 'selected' : 'normal'}
            />
          ))}
        </div>
      </section>
    </section>
  );
}
