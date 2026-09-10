import { keyGreen, prepareObject, preparedVideos, releasePrepared } from './media';
import type { GeneratedObject } from './types';
export interface BenchmarkRecord {
  provider: 'fal' | 'runware'; mode: 'reused-base-video' | 'fresh-image-then-video' | 'fresh-image'; resolution: '480p' | '768p';
  trial: number; totalMs: number; success: boolean; error?: string; timings?: Record<string, number>;
  expansion?: 'balanced' | 'fast'; transport?: 'queue' | 'direct'; inputMode?: 'inline' | 'hosted'; delivery?: 'stored' | 'stream';
  trace?: GeneratedObject['trace'];
  quality: 'unreviewed';
  media?: GeneratedObject;
}
export function benchmarkSummary(records: BenchmarkRecord[]) {
  const groups = new Map<string, BenchmarkRecord[]>();
  for (const r of records) { const key = `${r.provider}/${r.mode}/${r.resolution}/${r.expansion ?? 'balanced'}/${r.transport ?? 'queue'}/${r.inputMode ?? 'inline'}/${r.delivery ?? 'stored'}`; groups.set(key, [...(groups.get(key) ?? []), r]); }
  return [...groups].map(([condition, rows]) => {
    const times = rows.filter(r => r.success).map(r => r.totalMs).sort((a, b) => a - b);
    const percentile = (p: number) => times.length ? times[Math.ceil(times.length * p) - 1] : null;
    return { condition, n: rows.length, successRate: times.length / rows.length, within5s: rows.filter(r => r.success && r.totalMs <= 5000).length / rows.length, p50: percentile(.5), p95: percentile(.95), quality: '未評価。少数試行のp95は参考値。自動採用しない。' };
  });
}
/** Browser wall time includes download, decode, keying and a painted frame. */
export async function runManifestationBenchmark(canvas: HTMLCanvasElement, signal: AbortSignal, onRecord: (records: BenchmarkRecord[]) => void, selection: 'all' | 'fal' | 'static' | 'runware' | 'runware-reused' | 'latency-ab' | 'latency-hosted' | 'latency-direct' = 'all', trials = 5) {
  const records: BenchmarkRecord[] = [];
  const configs: Pick<BenchmarkRecord, 'provider' | 'resolution' | 'mode' | 'expansion' | 'transport' | 'inputMode' | 'delivery'>[] = selection.startsWith('latency-') ? (selection === 'latency-ab' ? ['balanced', 'fast'] as const : ['fast'] as const).map(expansion => ({ provider: 'fal', resolution: '480p', mode: 'reused-base-video', expansion, transport: selection === 'latency-direct' ? 'direct' : 'queue', inputMode: selection === 'latency-ab' ? 'inline' : 'hosted', delivery: 'stored' })) : selection === 'static' ? [{ provider: 'fal', resolution: '480p', mode: 'fresh-image' }] : (selection === 'fal' ? ['fal'] as const : selection.startsWith('runware') ? ['runware'] as const : ['fal', 'runware'] as const).flatMap(provider => (['480p', '768p'] as const).flatMap(resolution => (['reused-base-video', 'fresh-image-then-video'] as const).map(mode => ({ provider, resolution, mode }))));
  const selectedConfigs = selection === 'runware-reused' ? configs.filter(c => c.mode === 'reused-base-video') : configs;
  const sessions = new Map<string, string>();
  for (let trial = 0; trial < Math.max(1, Math.min(5, trials)); trial++) for (const config of selectedConfigs) {
    signal.throwIfAborted();
    // Each condition is an explicitly separate experiment, still sharing the $10 ledger.
    const condition = JSON.stringify(config);
    if (!sessions.has(condition)) {
      const response = await fetch('/api/manifestation/experiments', { method: 'POST', signal });
      if (!response.ok) throw new Error('benchmark-experiment-failed');
      sessions.set(condition, (await response.json() as { experimentId: string }).experimentId);
    }
    const started = performance.now(); let media: GeneratedObject | null = null;
    try {
      const response = await fetch('/api/manifestation/generate', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ experimentId: sessions.get(condition), event: { eventId: crypto.randomUUID(), sessionId: 'benchmark', generation: 0, clientId: 'benchmark-browser', cardId: 'chicken' }, benchmark: { ...config, seed: 1000 + trial } }) });
      if (!response.ok) {
        const failure = await response.json() as { error: string; trace?: GeneratedObject['trace'] };
        const error = failure.error;
        if (failure.trace) media = { url: '', kind: 'video', composite: 'green-key', mode: config.mode, timings: {}, trace: failure.trace };
        if (error === 'provider-http-422' && config.expansion === 'fast') throw new Error(`STOP:fast-unsupported:${error}`);
        if (error.includes('budget') || error.includes('missing-') || error.includes('benchmark-disabled')) throw new Error(`STOP:${error}`);
        throw new Error(error);
      }
      media = await response.json() as GeneratedObject;
      if (media.trace) { media.trace.browserOrigin = started; media.trace.browser.responseReceived = performance.now() - started; }
      await prepareObject(media, signal);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('canvas');
      canvas.width = 256; canvas.height = 256;
      if (media.kind === 'video') {
        const video = preparedVideos.get(media.url);
        if (!video) throw new Error('video-unavailable');
        ctx.drawImage(video, 0, 0, 256, 256); const pixels = ctx.getImageData(0, 0, 256, 256); keyGreen(pixels.data); ctx.putImageData(pixels, 0, 0);
      } else { const image = new Image(); image.src = media.url; await image.decode(); ctx.clearRect(0, 0, 256, 256); ctx.drawImage(image, 0, 0, 256, 256); }
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (media.trace) media.trace.browser.firstFrameDraw = performance.now() - started;
      records.push({ ...config, trial, trace: media.trace, success: true, totalMs: performance.now() - started, timings: media.timings, quality: 'unreviewed', media });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed';
      records.push({ ...config, trial, success: false, totalMs: performance.now() - started, error: message, trace: media?.trace, quality: 'unreviewed' });
      if (message.startsWith('STOP:') || signal.aborted) { onRecord([...records]); return records; }
    } finally { if (media) releasePrepared(media.url); }
    onRecord([...records]);
  }
  return records;
}

/** Paired replay of one remote video. No generation or paid provider request. */
export async function replayDelivery(canvas: HTMLCanvasElement, source: GeneratedObject, signal: AbortSignal, onRecord: (records: BenchmarkRecord[]) => void) {
  if (!source.replayUrl) throw new Error('replay-unavailable');
  const records: BenchmarkRecord[] = [];
  for (let trial = 0; trial < 5; trial++) for (const buffered of (trial % 2 ? [false, true] : [true, false])) {
    signal.throwIfAborted();
    const start = performance.now();
    const media: GeneratedObject = { ...source, url: source.replayUrl + `?replay=${crypto.randomUUID()}` + (buffered ? '&buffered=1' : ''), trace: { origin: 0, browserOrigin: start, server: {}, browser: {}, missing: ['Replay: no generation'], requestIds: [] } };
    try {
      await prepareObject(media, signal);
      const video = preparedVideos.get(media.url), ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!video || !ctx) throw new Error('replay-video');
      canvas.width = 256; canvas.height = 256;
      ctx.drawImage(video, 0, 0, 256, 256); const pixels = ctx.getImageData(0, 0, 256, 256); keyGreen(pixels.data); ctx.putImageData(pixels, 0, 0);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      media.trace!.browser.firstFrameDraw = performance.now() - start;
      records.push({ provider: 'fal', mode: 'reused-base-video', resolution: '480p', delivery: buffered ? 'stored' : 'stream', trial, success: true, totalMs: performance.now() - start, trace: media.trace, quality: 'unreviewed' });
    } catch (e) { records.push({ provider: 'fal', mode: 'reused-base-video', resolution: '480p', delivery: buffered ? 'stored' : 'stream', trial, success: false, totalMs: performance.now() - start, trace: media.trace, error: String(e), quality: 'unreviewed' }); }
    finally { releasePrepared(media.url); }
    onRecord([...records]);
  }
}
