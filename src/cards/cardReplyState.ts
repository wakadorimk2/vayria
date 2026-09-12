interface CardReplyState {
  swapRevision: number;
  remainingInterferenceCount: number;
  activatedCardIds: string[];
  forcedCardId: string | null;
}

/** Only delivery for this exchange may consume its pending card. */
export function acceptCardReply<T extends CardReplyState>(state: T, activatedCardIds: string[], swapRevision: number | undefined, maximumInterferenceCount: number): T {
  if (swapRevision !== state.swapRevision || !activatedCardIds.length) return state;
  return {
    ...state,
    remainingInterferenceCount: maximumInterferenceCount,
    activatedCardIds: state.activatedCardIds.filter(id => activatedCardIds.includes(id)),
    forcedCardId: null,
  };
}
