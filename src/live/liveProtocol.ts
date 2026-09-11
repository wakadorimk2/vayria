/** A full placement, not a patch. Revision belongs to the card game, not the transport. */
export interface LiveCardContext {
  swapRevision: number;
  brainCardIds: string[];
  forcedCardId: string | null;
}

export type LivePhase = 'idle' | 'starting' | 'connected' | 'stopping' | 'error';
export const LIVE_HEARTBEAT_MS = 15_000;
export const LIVE_LEASE_MS = 45_000;
export const LIVE_CLOSE_TIMEOUT_MS = 15_000;
export const LIVE_MAX_SECONDS = 600;
export const LIVE_USD_PER_MINUTE = 0.05;

export function liveCostMicroYen(seconds: number, usdJpy: number): number {
  return Math.ceil(Math.max(15, seconds) * usdJpy * (LIVE_USD_PER_MINUTE * 1_000_000) / 60);
}

export function liveAvailable(base: string, previewRequired: string): boolean {
  return base === '/staging' && previewRequired === 'true';
}
