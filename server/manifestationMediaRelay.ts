import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GenerationTrace } from '../src/manifestation/types.js';
import { traceMark } from './manifestationTrace.js';

const tickets = new Map<string, { url: string; expires: number; eventId: string }>();
export function mediaHost(value: string) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !['fal.media', 'runware.ai'].some(d => u.hostname === d || u.hostname.endsWith(`.${d}`))) throw new Error('invalid-media-host');
  return u;
}
export function createMediaTicket(url: string, eventId: string) {
  mediaHost(url);
  for (const [id, item] of tickets) if (item.expires < Date.now()) tickets.delete(id);
  if (tickets.size >= 100) throw new Error('media-ticket-limit');
  const id = randomUUID(); tickets.set(id, { url, eventId, expires: Date.now() + 600_000 });
  return `/api/manifestation/media/${id}`;
}
export function saveTrace(eventId: string, trace: GenerationTrace, error?: string) {
  mkdirSync('.world-experiments/manifestation', { recursive: true });
  appendFileSync('.world-experiments/manifestation/latency.jsonl', JSON.stringify({ eventId, trace, error }) + '\n');
}
/** URL is server-owned. No credentials or user-provided upstream URL enter the relay. */
export async function relayMedia(req: IncomingMessage, res: ServerResponse, trace: GenerationTrace, fetchImpl = fetch) {
  const path = new URL(req.url!, 'http://localhost');
  const ticket = tickets.get(path.pathname.split('/').pop()!);
  if (!ticket || ticket.expires < Date.now()) { res.writeHead(410); res.end(); return; }
  const range = req.headers.range;
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) { res.writeHead(416); res.end(); return; }
  const controller = new AbortController();
  const abort = () => controller.abort(); res.on('close', abort);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
  let error: string | undefined;
  try {
    traceMark(trace, 'mediaFetchStart');
    const upstream = await fetchImpl(ticket.url, { headers: range ? { Range: range } : {}, signal, redirect: 'error' });
    traceMark(trace, 'mediaHeaders');
    if (upstream.status === 416) { res.writeHead(416); res.end(); return; }
    if (![200, 206].includes(upstream.status) || !upstream.body) throw new Error('media-download');
    if (Number(upstream.headers.get('content-length')) > 32_000_000) throw new Error('media-size');
    const contentRange = upstream.headers.get('content-range');
    if (upstream.status === 206 && !/^bytes \d+-\d+\/\d+$/.test(contentRange ?? '')) throw new Error('invalid-media-range');
    if (contentRange && Number(contentRange.split('/')[1]) > 32_000_000) throw new Error('media-size');
    const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
    for (const name of ['content-length', 'content-range']) { const value = upstream.headers.get(name); if (value) headers[name] = value; }
    const reader = upstream.body.getReader();
    const chunks: Buffer[] = []; let size = 0;
    const buffered = path.searchParams.get('buffered') === '1';
    const startsAtZero = upstream.status === 200 || /^bytes 0-/.test(contentRange ?? '');
    let sent = false;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (!size) traceMark(trace, 'mediaFirstByte');
        size += value.length; if (size > 32_000_000) throw new Error('media-size');
        chunks.push(Buffer.from(value));
        if (!buffered && (sent || size >= 12)) {
          if (!sent) {
            const first = Buffer.concat(chunks);
            if (startsAtZero && first.subarray(4, 8).toString() !== 'ftyp') throw new Error('invalid-video');
            res.writeHead(upstream.status, headers); sent = true;
            if (!res.write(first)) await once(res, 'drain', { signal });
          } else if (!res.write(value)) await once(res, 'drain', { signal });
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    traceMark(trace, 'mediaDownloadEnd');
    const bytes = Buffer.concat(chunks);
    if (startsAtZero && bytes.subarray(4, 8).toString() !== 'ftyp') throw new Error('invalid-video');
    if (buffered || !sent) { res.writeHead(upstream.status, headers); res.end(bytes); } else res.end();
    traceMark(trace, 'mediaRelayEnd');
    if (upstream.status === 200 || contentRange === `bytes 0-${size - 1}/${size}`) {
      mkdirSync('.world-experiments/manifestation/assets', { recursive: true });
      writeFileSync(`.world-experiments/manifestation/assets/${createHash('sha256').update(bytes).digest('hex')}.mp4`, bytes);
      traceMark(trace, 'mediaSaved');
    }
  } catch (e) {
    error = e instanceof Error ? e.message : 'media-relay';
    if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy();
  } finally { res.off('close', abort); saveTrace(ticket.eventId, trace, error); }
}
