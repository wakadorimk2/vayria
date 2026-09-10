import { performance } from 'node:perf_hooks';
import type { GenerationTrace } from '../src/manifestation/types.js';
export function createGenerationTrace(): GenerationTrace {
  return { origin: performance.now(), server: {}, browser: {}, requestIds: [], missing: ['prompt expansion / encode / CDN publish internal timestamps unavailable'] };
}
export function traceMark(trace: GenerationTrace, name: string) { trace.server[name] = performance.now() - trace.origin; }
