/** Context for continuing the same answer after a card exchange. */
export interface CardContinuation {
  deliveredText: string;
  acknowledgementDelivered: boolean;
}

export const MAX_SPEECH_UNIT_INDEX = 15;

/** Split text at language boundaries, never at an arbitrary character count. */
export function splitSpeechAtBoundaries(text: string): string[] {
  const units = Array.from(new Intl.Segmenter('ja', { granularity: 'sentence' }).segment(text),
    part => part.segment.trim()).filter(Boolean);
  return units.length <= 8 ? units : [...units.slice(0, 7), units.slice(7).join('')];
}

export function isCardContinuation(value: unknown): value is CardContinuation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(key => key === 'deliveredText' || key === 'acknowledgementDelivered') &&
    typeof record.deliveredText === 'string' && record.deliveredText.length <= 4000 &&
    typeof record.acknowledgementDelivered === 'boolean';
}
