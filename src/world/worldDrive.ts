import type { WorldState } from './worldState.js';
export interface WorldDrive { score: number; threshold: number; curiosity: number; tension: number; boredom: number; eligible: boolean }
export function sampleWorldDrive(world: WorldState, now: number, lastActionAt: number, lastInputAt: number, noise = 0.5): WorldDrive {
  const age = Math.max(0, (now - lastActionAt) / 1000);
  const curiosity = world.nextInterest ? 0.42 : 0;
  const tension = world.absurdityLevel * 0.045;
  const boredom = Math.min(0.15, Math.max(0, (now - lastInputAt) / 120000) * 0.15);
  const wave = Math.sin(now / 5700) * 0.2 + Math.sin(now / 13700) * 0.09;
  const score = curiosity + tension + boredom + wave + (noise - 0.5) * 0.1 - Math.max(0, 1 - age / 30) * 0.65;
  const threshold = 0.55 + Math.sin(now / 19300) * 0.1;
  return { score, threshold, curiosity, tension, boredom, eligible: world.revision > 0 && !!world.nextInterest && age >= 10 && score > threshold };
}
