export interface SemanticDialogueMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SemanticDialogueTurn {
  kind: 'dialogue_turn';
  user: string;
  assistant: string;
  committedAt: number;
}

export interface SemanticAssistantUtterance {
  kind: 'assistant_utterance';
  assistant: string;
  committedAt: number;
}

export type SemanticDialogueEntry =
  | SemanticDialogueTurn
  | SemanticAssistantUtterance;

export const DEFAULT_HISTORY_TURN_LIMIT = 5;
export const MAX_SEMANTIC_HISTORY_MESSAGES = 10;

function normalizeText(value: string): string {
  return value.trim();
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HISTORY_TURN_LIMIT;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

export class SemanticDialogueHistory {
  private readonly entries: SemanticDialogueEntry[] = [];
  private readonly limit: number;

  constructor(limit = DEFAULT_HISTORY_TURN_LIMIT) {
    this.limit = normalizeLimit(limit);
  }

  commitTurn(user: string, assistant: string, committedAt = Date.now()): void {
    const normalizedUser = normalizeText(user);
    const normalizedAssistant = normalizeText(assistant);
    if (!normalizedUser || !normalizedAssistant) return;

    this.entries.push({
      kind: 'dialogue_turn',
      user: normalizedUser,
      assistant: normalizedAssistant,
      committedAt,
    });
    this.trim();
  }

  appendAssistant(assistant: string, committedAt = Date.now()): void {
    const normalizedAssistant = normalizeText(assistant);
    if (!normalizedAssistant) return;

    this.entries.push({
      kind: 'assistant_utterance',
      assistant: normalizedAssistant,
      committedAt,
    });
    this.trim();
  }

  clear(): void {
    this.entries.length = 0;
  }

  snapshot(): readonly SemanticDialogueEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  toMessages(): SemanticDialogueMessage[] {
    const messages = this.entries.flatMap((entry) =>
      entry.kind === 'dialogue_turn'
        ? [
            { role: 'user' as const, content: entry.user },
            { role: 'assistant' as const, content: entry.assistant },
          ]
        : [{ role: 'assistant' as const, content: entry.assistant }],
    );
    return messages.slice(-MAX_SEMANTIC_HISTORY_MESSAGES);
  }

  private trim(): void {
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }
}

export function createSemanticDialogueHistory(
  limit = DEFAULT_HISTORY_TURN_LIMIT,
): SemanticDialogueHistory {
  return new SemanticDialogueHistory(limit);
}
