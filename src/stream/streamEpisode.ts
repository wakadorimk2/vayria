import type { StreamObservation } from './streamContract.js';

// Deterministic short-term memory over raw observations.
// High-frequency combat observations are folded into one episode whose
// trend ("escalating", "thinning out", "wound down") is what Vayria can
// actually talk about — raw event lists only produce flat narration.

export type EpisodeSignificance = 'low' | 'medium' | 'high';

export type EpisodeTransitionKind =
  | 'episode_start'
  | 'episode_end'
  | 'damage_taken'
  | 'health_critical'
  | 'player_died'
  | 'threat_rising'
  | 'threat_falling';

export interface EpisodeTransition {
  kind: EpisodeTransitionKind;
  at: number;
  // Short factual English line, same style as VLM event summaries.
  detail: string;
  significance: EpisodeSignificance;
}

interface IntensitySample {
  at: number;
  score: number;
}

interface CombatEpisode {
  startedAt: number;
  lastUrgentAt: number;
  damageCount: number;
  deaths: number;
  worstHealth: string;
  enemySightings: number;
  samples: IntensitySample[];
  lastTrend: 'rising' | 'falling' | 'stable';
  lastTrendAt: number;
}

const URGENT_EVENT_WEIGHTS: Record<string, number> = {
  combat: 3,
  enemy_visible: 2,
  player_damaged: 3,
  player_died: 5,
};
const HEALTH_RANK: Record<string, number> = {
  unknown: 0,
  ok: 1,
  hurt: 2,
  critical: 3,
  dead: 4,
};

const EPISODE_END_GAP_MS = 8_000;
const TREND_RECENT_MS = 4_000;
const TREND_PREVIOUS_MS = 8_000;
const TREND_SAMPLE_KEEP_MS = 12_000;
const TREND_MIN_EMIT_GAP_MS = 5_000;

function sumScore(samples: readonly IntensitySample[], from: number, to: number): number {
  let total = 0;
  for (const sample of samples) {
    if (sample.at >= from && sample.at < to) total += sample.score;
  }
  return total;
}

export function isUrgentEventKind(kind: string): boolean {
  return kind in URGENT_EVENT_WEIGHTS;
}

export class StreamEpisodeTracker {
  private episode: CombatEpisode | null = null;

  get inCombat(): boolean {
    return this.episode !== null;
  }

  reset(): void {
    this.episode = null;
  }

  ingest(observation: StreamObservation, at: number): EpisodeTransition[] {
    const transitions: EpisodeTransition[] = [];
    const score = observation.events.reduce(
      (total, event) => total + (URGENT_EVENT_WEIGHTS[event.kind] ?? 0),
      0,
    );
    const health = observation.player.healthState;
    const urgent =
      score > 0 || health === 'critical' || health === 'dead';

    if (!this.episode && !urgent) return transitions;
    if (!this.episode) {
      this.episode = {
        startedAt: at,
        lastUrgentAt: at,
        damageCount: 0,
        deaths: 0,
        // Baseline, not the trigger observation's value: a first-frame
        // death or critical hit must still emit its transition.
        worstHealth: 'ok',
        enemySightings: 0,
        samples: [],
        lastTrend: 'stable',
        lastTrendAt: 0,
      };
      const trigger =
        observation.events.find((event) => isUrgentEventKind(event.kind))
          ?.summary ?? 'Enemies engaged';
      transitions.push({
        kind: 'episode_start',
        at,
        detail: `Combat began: ${trigger}`,
        significance: 'medium',
      });
    }

    const episode = this.episode;
    if (urgent) episode.lastUrgentAt = at;
    episode.samples.push({ at, score });
    episode.samples = episode.samples.filter(
      (sample) => at - sample.at <= TREND_SAMPLE_KEEP_MS,
    );

    for (const event of observation.events) {
      if (event.kind === 'enemy_visible') episode.enemySightings += 1;
      if (event.kind === 'player_damaged') {
        episode.damageCount += 1;
        transitions.push({
          kind: 'damage_taken',
          at,
          detail: `Player took a hit (${episode.damageCount} so far this fight)`,
          significance: 'medium',
        });
      }
    }

    const healthRank = HEALTH_RANK[health] ?? 0;
    const worstRank = HEALTH_RANK[episode.worstHealth] ?? 0;
    if (healthRank > worstRank) {
      episode.worstHealth = health;
      if (health === 'critical' && episode.deaths === 0) {
        transitions.push({
          kind: 'health_critical',
          at,
          detail: 'Player health is critical',
          significance: 'high',
        });
      }
      if (health === 'dead' && episode.deaths === 0) {
        episode.deaths += 1;
        transitions.push({
          kind: 'player_died',
          at,
          detail: 'Player died during the fight',
          significance: 'high',
        });
      }
    }

    const trend = this.readTrend(episode, at);
    if (
      trend !== 'stable' &&
      trend !== episode.lastTrend &&
      at - episode.lastTrendAt >= TREND_MIN_EMIT_GAP_MS
    ) {
      transitions.push({
        kind: trend === 'rising' ? 'threat_rising' : 'threat_falling',
        at,
        detail:
          trend === 'rising'
            ? 'The fight is escalating'
            : 'Enemies are thinning out',
        significance: 'medium',
      });
      episode.lastTrend = trend;
      episode.lastTrendAt = at;
    }

    if (!urgent && at - episode.lastUrgentAt >= EPISODE_END_GAP_MS) {
      transitions.push({
        kind: 'episode_end',
        at,
        detail: `Combat wound down after ${Math.round(
          (episode.lastUrgentAt - episode.startedAt) / 1000,
        )}s: ${episode.damageCount} hits taken, worst health ${episode.worstHealth}`,
        significance: 'medium',
      });
      this.episode = null;
    }

    return transitions;
  }

  // One-line rolling summary for the prompt's stream context.
  describe(at: number): string | null {
    const episode = this.episode;
    if (!episode) return null;
    const elapsed = Math.max(0, Math.round((at - episode.startedAt) / 1000));
    return `Ongoing combat episode: ${elapsed}s elapsed, ${episode.damageCount} hits taken, worst health ${episode.worstHealth}, threat ${this.readTrend(episode, at)}.`;
  }

  private readTrend(
    episode: CombatEpisode,
    at: number,
  ): 'rising' | 'falling' | 'stable' {
    const recent = sumScore(episode.samples, at - TREND_RECENT_MS, at);
    const previous = sumScore(
      episode.samples,
      at - TREND_PREVIOUS_MS,
      at - TREND_RECENT_MS,
    );
    if (recent >= Math.max(3, previous * 1.5) && recent > previous) {
      return 'rising';
    }
    if (previous >= 3 && recent <= previous * 0.5) return 'falling';
    return 'stable';
  }
}
