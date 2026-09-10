import { createGenerationTrace, traceMark } from './manifestationTrace.js';
import { createMediaTicket, relayMedia, saveTrace } from './manifestationMediaRelay.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { LocalApiConfig } from './localApiSupport.js';
import { ManifestationLedger } from './manifestationLedger.js';
import { generateManifestation } from './manifestationProvider.js';
import { isInputEvent } from '../src/manifestation/types.js';

const services = new WeakMap<LocalApiConfig, { ledger: ManifestationLedger; active: number }>();
export async function handleManifestationRequest(req: IncomingMessage, res: ServerResponse, config: LocalApiConfig) {
  const json = (status: number, body: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } };
  if (!config.manifestationEnabled || config.mode === 'public' || config.worldMutationEnabled) return json(404, { error: 'not-found' });
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const root = resolve('.world-experiments/manifestation');
  if (req.method === 'GET' && /^\/api\/manifestation\/media\/[\w-]{36}$/.test(path)) return relayMedia(req, res, createGenerationTrace());
  if (req.method === 'GET' && /^\/api\/manifestation\/assets\/[a-f0-9]{64}\.(png|mp4)$/.test(path)) {
    try {
      const data = readFileSync(resolve(root, 'assets', path.split('/').pop()!));
      res.writeHead(200, { 'Content-Type': path.endsWith('.png') ? 'image/png' : 'video/mp4', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
    } catch { json(404, { error: 'not-found' }); }
    return;
  }
  if (req.method !== 'POST') return json(405, { error: 'method' });
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== (req.headers.host ?? req.headers[':authority'])) return json(403, { error: 'origin' }); }
    catch { return json(403, { error: 'origin' }); }
  }
  let service = services.get(config);
  if (!service) { service = { ledger: new ManifestationLedger(root, config.manifestationBudgetLimitUsd ?? 10), active: 0 }; services.set(config, service); }
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.manifestationBenchmarkEnabled ? 150000 : 10000)]);
  let started = false; let eventId = 'unaccepted'; let failure: string | undefined;
  const trace = createGenerationTrace(); traceMark(trace, 'inputAccepted');
  try {
    let body = '';
    for await (const chunk of req) { body += String(chunk); if (Buffer.byteLength(body) > 4096) return json(413, { error: 'size' }); }
    if (path === '/api/manifestation/experiments') return json(200, { experimentId: service.ledger.createExperiment() });
    if (path !== '/api/manifestation/generate') return json(404, { error: 'not-found' });
    const payload = JSON.parse(body) as { experimentId: string; event: unknown; benchmark?: { provider: 'fal' | 'runware'; mode: 'reused-base-video' | 'fresh-image-then-video' | 'fresh-image'; resolution: '480p' | '768p'; expansion?: 'balanced' | 'fast'; transport?: 'queue' | 'direct'; inputMode?: 'inline' | 'hosted'; delivery?: 'stored' | 'stream'; seed?: number } };
    if (!isInputEvent(payload.event) || payload.event.cardId !== 'chicken' || typeof payload.experimentId !== 'string') return json(400, { error: 'input' });
    if (service.active >= 2) return json(429, { error: 'busy' });
    if (!config.manifestation) return json(503, { error: 'configuration' });
    if ((payload.benchmark?.provider ?? config.manifestation.provider) === 'runware' && !config.manifestationRunwareEnabled) return json(503, { error: 'runware-disabled' });
    if (payload.benchmark && (!config.manifestationBenchmarkEnabled || !['fal', 'runware'].includes(payload.benchmark.provider) || !['reused-base-video', 'fresh-image-then-video', 'fresh-image'].includes(payload.benchmark.mode) || !['480p', '768p'].includes(payload.benchmark.resolution))) return json(400, { error: 'benchmark-disabled-or-invalid' });
    const b = payload.benchmark;
    if (b && ((b.expansion !== undefined && !['balanced', 'fast'].includes(b.expansion)) || (b.transport !== undefined && !['queue', 'direct'].includes(b.transport)) || (b.inputMode !== undefined && !['inline', 'hosted'].includes(b.inputMode)) || (b.delivery !== undefined && !['stored', 'stream'].includes(b.delivery)) || (b.seed !== undefined && !Number.isSafeInteger(b.seed)))) return json(400, { error: 'invalid-benchmark-options' });
    eventId = payload.event.eventId;
    service.ledger.accept(payload.experimentId, payload.event.eventId);
    service.active++; started = true;
    const result = await generateManifestation({ ...config.manifestation, ...payload.benchmark }, usd => service!.ledger.reserve(payload.experimentId, usd), signal, fetch, trace);
    if (result.kind === 'video') result.replayUrl = createMediaTicket(result.url, eventId);
    if ((payload.benchmark?.delivery ?? config.manifestation.delivery) === 'stream' && result.kind === 'video') {
      result.url = result.replayUrl!; traceMark(trace, 'responseReady'); return json(200, result);
    }
    const remote = new URL(result.url);
    if (remote.protocol !== 'https:' || !['fal.media', 'runware.ai'].some(domain => remote.hostname === domain || remote.hostname.endsWith(`.${domain}`))) throw new Error('invalid-media-host');
    traceMark(trace, 'mediaFetchStart');
    const response = await fetch(remote, { signal, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('media-download');
    traceMark(trace, 'mediaHeaders');
    const chunks: Buffer[] = []; let total = 0;
    const reader = response.body.getReader();
    try {
      while (true) { const { value, done } = await reader.read(); if (done) break; if (!total) traceMark(trace, 'mediaFirstByte'); total += value.length; if (total > 32_000_000) { await reader.cancel(); throw new Error('media-size'); } chunks.push(Buffer.from(value)); }
    } finally { reader.releaseLock(); }
    traceMark(trace, 'mediaDownloadEnd');
    const bytes = Buffer.concat(chunks);
    if (result.kind === 'image') {
      const { data, info } = await sharp(bytes, { limitInputPixels: 4096 * 4096 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let transparent = 0, opaque = 0;
      for (let i = 3; i < data.length; i += info.channels) { if (data[i] < 16) transparent++; if (data[i] > 240) opaque++; }
      if (transparent / (info.width * info.height) < .15 || opaque / (info.width * info.height) < .03) throw new Error('invalid-alpha');
    } else if (bytes.subarray(4, 8).toString() !== 'ftyp') throw new Error('invalid-video');
    traceMark(trace, 'mediaValidationEnd');
    const file = `${createHash('sha256').update(bytes).digest('hex')}.${result.kind === 'image' ? 'png' : 'mp4'}`;
    mkdirSync(resolve(root, 'assets'), { recursive: true }); writeFileSync(resolve(root, 'assets', file), bytes);
    result.url = `/api/manifestation/assets/${file}`;
    result.timings.downloadCompletedAt = Date.now();
    traceMark(trace, 'mediaSaved'); traceMark(trace, 'responseReady');
    json(200, result);
  } catch (error) { failure = error instanceof Error ? error.message : 'generation-failed'; json(503, { error: failure, trace }); }
  finally { if (started) saveTrace(eventId, trace, failure); if (started) service.active--; res.off('close', abort); }
}
