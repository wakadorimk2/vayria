// Jev (TypeSafe AI "System One") client for the stream reflex layer.
// One round trip evaluates a small typed decision — which involuntary
// reaction fits the moment and how strong it is. Jev never generates
// prose; the reflex layer maps the judgement to a fixed vocal clip.

import {
  STREAM_REFLEX_KINDS,
  type StreamReflexJudgement,
  type StreamReflexKind,
} from '../../src/stream/streamContract.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 5_000;

export class JevRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'JevRequestError';
  }
}

interface JevAnswerMap {
  answers?: {
    reflex?: {
      type?: string;
      choice?: string;
      confidence?: number;
    };
    intensity?: {
      type?: string;
      score?: number;
      confidence?: number;
    };
  };
  model?: string;
}

function isReflexKind(value: unknown): value is StreamReflexKind {
  return (
    typeof value === 'string' &&
    (STREAM_REFLEX_KINDS as readonly string[]).includes(value)
  );
}

export async function evaluateStreamReflex(
  state: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ judgement: StreamReflexJudgement; model: string; latencyMs: number }> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  const linked = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    const response = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        state,
        model: JEV_MODEL,
        questions: {
          reflex: {
            type: 'choice',
            instructions:
              'An AI companion watches a live 7 Days to Die session beside the player. Pick the involuntary sound a startled friend would make at THIS moment. When the state says combat is active or enemies are present, that is danger — not routine.',
            criteria: {
              none: 'Routine play; nothing worth reacting to',
              surprise: 'Something unexpected just appeared or happened',
              danger: 'Enemies are visible or a fight is underway; the player is in trouble',
              pain: 'The player just took damage or is being hurt',
              relief: 'The danger just passed or the situation clearly recovered',
              death: 'The player just died or is dying',
            },
          },
          intensity: {
            type: 'score',
            instructions:
              'Rate how strongly the moment deserves a vocal reaction, based on stakes and surprise.',
            criteria: ['negligible', 'mild', 'strong', 'extreme'],
          },
        },
      }),
      signal: linked,
    });
    if (!response.ok) {
      throw new JevRequestError(
        `Jev request failed with HTTP ${response.status}.`,
        response.status,
      );
    }
    const body = (await response.json()) as JevAnswerMap;
    const choice = body.answers?.reflex?.choice;
    const score = body.answers?.intensity?.score;
    const confidence = body.answers?.reflex?.confidence;
    if (
      !isReflexKind(choice) ||
      typeof score !== 'number' ||
      typeof confidence !== 'number'
    ) {
      throw new JevRequestError('Jev returned an unexpected answer shape.', null);
    }
    return {
      judgement: {
        kind: choice,
        intensity: Math.min(1, Math.max(0, score / 3)),
        confidence: Math.min(1, Math.max(0, confidence)),
      },
      model: body.model ?? JEV_MODEL,
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}
