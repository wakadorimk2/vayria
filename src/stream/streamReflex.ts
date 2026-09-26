import {
  STREAM_REFLEX_PATH,
  type StreamObservation,
  type StreamReflexJudgement,
  type StreamReflexKind,
  type StreamReflexResult,
} from './streamContract.js';

// Client side of the reflex ("spinal cord") layer. Jev picks only the
// reaction class; the wording is a fixed clip lookup, never generated.
export const REFLEX_UTTERANCES: Record<
  Exclude<StreamReflexKind, 'none'>,
  string
> = {
  surprise: 'えっ',
  danger: 'やばっ',
  pain: 'いたっ',
  relief: 'あぶな……',
  death: 'あーっ',
};

export function buildReflexState(
  observation: StreamObservation,
  episodeSummary: string | null,
): Record<string, unknown> {
  return {
    game: '7 Days to Die',
    scene: `${observation.scene.setting}, ${observation.scene.timeOfDay}${
      observation.scene.bloodMoon ? ', Blood Moon' : ''
    }`,
    player: `${observation.player.activity}, health ${observation.player.healthState}`,
    events: observation.events
      .map((event) => event.summary.trim())
      .filter((summary) => summary.length > 0)
      .slice(0, 4),
    ...(observation.changeSummary
      ? { change: observation.changeSummary }
      : {}),
    ...(episodeSummary
      ? { combat: 'active', episode: episodeSummary }
      : {}),
  };
}

export async function postReflex(
  state: Record<string, unknown>,
): Promise<StreamReflexJudgement | null> {
  const response = await fetch(STREAM_REFLEX_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return null;
  const result = (await response.json()) as StreamReflexResult;
  if (result.error || !result.judgement) return null;
  return result.judgement;
}
