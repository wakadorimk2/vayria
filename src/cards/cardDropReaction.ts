import { getCardPerformancePlanOverrides } from './cardMotionAssets.js';
import type {
  DirectionContribution,
  PerformanceResult,
  PerformerTrigger,
} from '../performer/types.js';

export const CARD_DROP_REACTION_MODES = ['baseline', 'candidate'] as const;

export type CardDropReactionMode =
  (typeof CARD_DROP_REACTION_MODES)[number];

export type CardDropReactionPhase =
  | 'idle'
  | 'reacting'
  | 'awaiting-reply'
  | 'reply-active';

export interface CardDropReactionState {
  activeCardId: string | null;
  animationSequence: number | null;
  phase: CardDropReactionPhase;
  reactionPlanId: string | null;
  replyPlanId: string | null;
}

export interface CardDropReactionStart {
  activeCardId: string;
  contribution: DirectionContribution;
  trigger: PerformerTrigger;
}

export interface CardDropSwapResult {
  animationSequence: number;
  brainCardIds: string[];
  ejectedCardId: string;
  forcedCardId: string;
  insertedCardId: string;
}

const INITIAL_STATE: CardDropReactionState = {
  activeCardId: null,
  animationSequence: null,
  phase: 'idle',
  reactionPlanId: null,
  replyPlanId: null,
};

function isCardDropReactionMode(
  value: unknown,
): value is CardDropReactionMode {
  return (
    typeof value === 'string' &&
    (CARD_DROP_REACTION_MODES as readonly string[]).includes(value)
  );
}

export function readCardDropReactionMode(
  search: string,
  environmentValue: unknown,
): CardDropReactionMode {
  const queryValue = new URLSearchParams(search).get('cardDropReaction');
  if (isCardDropReactionMode(queryValue)) return queryValue;
  if (isCardDropReactionMode(environmentValue)) return environmentValue;
  return 'baseline';
}

export function createCardDropReactionContribution(
  result: CardDropSwapResult,
  reducedMotion: boolean,
): DirectionContribution {
  const trigger: PerformerTrigger = {
    kind: 'external_stimulus',
    semanticCue: `card_inserted:${result.insertedCardId}`,
    metadata: { origin: 'wildcard-card-drop' },
  };

  return {
    directionId: 'wildcard-card-drop',
    effects: [],
    constraints: [],
    semanticCues: [trigger.semanticCue],
    triggers: [trigger],
    attentionTarget: 'game',
    planOverrides: getCardPerformancePlanOverrides(
      result.insertedCardId,
      reducedMotion,
    ),
  };
}

export class CardDropReactionController {
  private state: CardDropReactionState = { ...INITIAL_STATE };

  snapshot(): CardDropReactionState {
    return { ...this.state };
  }

  begin(
    result: CardDropSwapResult | null,
    mode: CardDropReactionMode,
    reducedMotion: boolean,
  ): CardDropReactionStart | null {
    if (!result || mode !== 'candidate') return null;
    if (this.state.animationSequence === result.animationSequence) return null;

    const contribution = createCardDropReactionContribution(
      result,
      reducedMotion,
    );
    const trigger = contribution.triggers[0];
    if (!trigger) return null;

    this.state = {
      activeCardId: result.insertedCardId,
      animationSequence: result.animationSequence,
      phase: 'reacting',
      reactionPlanId: null,
      replyPlanId: null,
    };
    return {
      activeCardId: result.insertedCardId,
      contribution,
      trigger,
    };
  }

  bindReactionPlan(planId: string): boolean {
    if (this.state.phase !== 'reacting') return false;
    this.state = { ...this.state, reactionPlanId: planId };
    return true;
  }

  settleReaction(
    planId: string,
    outcome: PerformanceResult['outcome'],
  ): boolean {
    if (this.state.reactionPlanId !== planId) return false;
    if (outcome !== 'completed') {
      this.reset();
      return true;
    }
    this.state = {
      ...this.state,
      phase: 'awaiting-reply',
      reactionPlanId: null,
    };
    return true;
  }

  handoffToReply(forcedCardId: string | null, planId: string): boolean {
    if (
      this.state.phase !== 'awaiting-reply' ||
      this.state.activeCardId === null ||
      this.state.activeCardId !== forcedCardId
    ) {
      return false;
    }
    this.state = { ...this.state, phase: 'reply-active', replyPlanId: planId };
    return true;
  }

  settleReply(planId: string): boolean {
    if (this.state.replyPlanId !== planId) return false;
    this.reset();
    return true;
  }

  supersede(): void {
    this.reset();
  }

  reset(): void {
    this.state = { ...INITIAL_STATE };
  }
}
