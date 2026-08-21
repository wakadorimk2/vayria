export type CardKind = 'concept' | 'mood' | 'effect';

export type CardState = 'normal' | 'selected' | 'active' | 'disabled';

export interface WildcardCardData {
  id: string;
  label: string;
  kind: CardKind;
  prompt: string;
}
