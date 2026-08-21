export type CardKind = 'concept' | 'mood' | 'effect';

export type CardState = 'normal' | 'selected' | 'active' | 'disabled';

export type CardMotion =
  | 'none'
  | 'dragging'
  | 'drop-target'
  | 'pending-insertion'
  | 'inserted'
  | 'ejected';

export interface WildcardCardData {
  id: string;
  label: string;
  kind: CardKind;
  prompt: string;
}
