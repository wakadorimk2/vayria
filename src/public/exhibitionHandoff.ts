import { environmentStorageKey } from '../storageKey';
export type HandoffRequest = { requestId: string; epoch: number };
const pendingKey = environmentStorageKey('vayria-exhibition-handoff');
export const hasPendingHandoff = (storage: Pick<Storage, 'getItem'>) => storage.getItem(pendingKey) !== null;
export function readHandoff(storage: Pick<Storage, 'getItem'>): HandoffRequest | null {
  const raw = storage.getItem(pendingKey);
  if (!raw) return null;
  const value = JSON.parse(raw) as HandoffRequest;
  if (!value || typeof value.requestId !== 'string' || !Number.isSafeInteger(value.epoch)) throw new Error('Invalid pending handoff');
  return value;
}
export function prepareHandoff(storage: Pick<Storage, 'getItem' | 'setItem'>, epoch: number): HandoffRequest {
  const request = readHandoff(storage) ?? { requestId: crypto.randomUUID(), epoch };
  storage.setItem(pendingKey, JSON.stringify(request));
  return request;
}
export function completeHandoff(storage: Pick<Storage, 'removeItem'>) { storage.removeItem(pendingKey); }

// A card reaction uses the autonomy machinery too. Only a fresh card stimulus may enter it at an exhibit.
export const allowExhibitionAutonomy = (exhibition: boolean, hasCardStimulus: boolean) => !exhibition || hasCardStimulus;
