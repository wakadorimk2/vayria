import { LimitError } from './ledger';
import { boundedBody } from './security';
import { isInputEvent, type GeneratedObject, type GenerationTrace } from '../src/manifestation/types';

export interface ManifestationEnv {
  ASSETS: Fetcher; FAL_KEY?: string; MANIFESTATION_ENABLED?: string;
  PUBLIC_BASE_PATH?: string; REQUIRE_PREVIEW_ACCESS?: string; PUBLIC_HOSTNAME: string; GENERATION_ENABLED: string;
}
type LedgerCall = <T>(op: string, args?: object) => Promise<T>;
export function mediaUrl(value: unknown) {
  const url = new URL(String(value));
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'))) throw new Error('invalid_media');
  return url.href;
}
export async function manifestation(request: Request, env: ManifestationEnv, visitor: string, session: string, ledger: LedgerCall) {
  if (env.MANIFESTATION_ENABLED !== 'true' || (env.PUBLIC_HOSTNAME !== 'vayria.me' || env.PUBLIC_BASE_PATH !== '/staging' || env.REQUIRE_PREVIEW_ACCESS !== 'true')) throw new LimitError('not_found', 0, 404);
  const path = new URL(request.url).pathname;
  const who = { visitor, id: session };
  if (path.startsWith('/api/manifestation/media/')) {
    if (request.method !== 'GET') throw new LimitError('method_not_allowed', 0, 405);
    const token = path.split('/').pop()!;
    if (!/^[a-f0-9-]{36}$/.test(token)) throw new LimitError('not_found', 0, 404);
    // The opaque ticket is bound to the authenticated visitor and a still-live session.
    const target = await ledger<string>('manifestationMedia', { visitor, token });
    const range = request.headers.get('Range');
    if (range && !/^bytes=(\d+-\d*|-\d+)$/.test(range)) throw new LimitError('invalid_range', 0, 416);
    const response = await fetch(mediaUrl(target), { headers: range ? { Range: range } : {}, redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
    if (![200, 206].includes(response.status) || !response.body || !response.headers.get('Content-Type')?.includes('video/mp4')) throw new LimitError('media_unavailable', 0, 502);
    const length = Number(response.headers.get('Content-Length'));
    if (length > 32 * 1024 * 1024) throw new LimitError('media_unavailable', 0, 502);
    const headers = new Headers({ 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const key of ['Content-Length', 'Content-Range', 'Accept-Ranges']) { const value = response.headers.get(key); if (value) headers.set(key, value); }
    let size = 0;
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      size += chunk.byteLength; if (size > 32 * 1024 * 1024) throw new Error('media_too_large'); controller.enqueue(chunk);
    } })), { status: response.status, headers });
  }
  if (request.method !== 'POST') throw new LimitError('method_not_allowed', 0, 405);
  if (path !== '/api/manifestation/generate') throw new LimitError('not_found', 0, 404);
  if (env.GENERATION_ENABLED !== 'true' || !env.FAL_KEY) throw new LimitError('generation_stopped', 0, 503);
  let input: { event?: unknown };
  try { input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 4096))); } catch { throw new LimitError('invalid_request', 0, 400); }
  if (!isInputEvent(input.event) || input.event.cardId !== 'chicken') throw new LimitError('invalid_request', 0, 400);
  const event = input.event;
  const token = crypto.randomUUID();
  const origin = performance.now();
  const trace: GenerationTrace = { origin, server: {}, browser: {}, requestIds: [], missing: ['queue boundaries are polling observations'] };
  const mark = (name: string) => { trace.server[name] = performance.now() - origin; };
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  const source = await env.ASSETS.fetch(new Request('https://assets/manifestation/chicken-source.png'));
  if (!source.ok) throw new LimitError('configuration_unavailable', 0, 503);
  const bytes = new Uint8Array(await source.arrayBuffer());
  const image = 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
  await ledger('manifestationBegin', { ...who, manifestationEvent: event, token });
  let outcome = 'provider_failure';
  try {
    const read = async (url: string, init?: RequestInit) => {
      const response = await fetch(url, { ...init, headers: { Authorization: `Key ${env.FAL_KEY}`, 'Content-Type': 'application/json' }, redirect: 'error', signal });
      trace.server.providerHttpStatus = response.status;
      if (!response.ok) throw new Error('provider_failure');
      return response.json() as Promise<Record<string, unknown>>;
    };
    mark('video.submitStart');
    const task = await read('https://queue.fal.run/minimax/h3-max-turbo/image-to-video', { method: 'POST', body: JSON.stringify({
      image_url: image, prompt: 'Locked camera, one cute chicken gently bobs and blinks in place. Keep the complete silhouette inside frame with a wide margin. Preserve the perfectly uniform green background, no floor, no camera movement, no cuts, no text, no additional subjects.',
      duration: 5, resolution: '480P', prompt_expansion_mode: 'fast', enable_safety_checker: true,
    }) });
    mark('video.submitAccepted');
    if (typeof task.request_id === 'string') trace.requestIds.push(task.request_id);
    const queueUrl = (value: unknown) => { const u = new URL(String(value)); if (u.origin !== 'https://queue.fal.run' || u.username || u.password) throw new Error('invalid_queue'); return u.href; };
    const statusUrl = queueUrl(task.status_url), resultUrl = queueUrl(task.response_url);
    while (true) {
      const status = await read(statusUrl);
      if (typeof status.status === 'string' && ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'].includes(status.status)) {
        trace.server['video.' + status.status] ??= performance.now() - origin;
      }
      if (status.status === 'COMPLETED') break;
      if (!['IN_QUEUE', 'IN_PROGRESS'].includes(String(status.status))) throw new Error('provider_failure');
      await new Promise(resolve => setTimeout(resolve, 150)); signal.throwIfAborted();
    }
    const result = await read(resultUrl); mark('video.responseReceived');
    const target = mediaUrl((result.video as { url?: unknown })?.url); mark('videoUrlAvailable');
    const inference = (result.timings as { inference?: unknown })?.inference;
    if (typeof inference === 'number' && Number.isFinite(inference)) trace.inferenceSeconds = inference;
    await ledger('manifestationComplete', { ...who, token, target });
    outcome = 'complete';
    return Response.json({ url: '/staging/api/manifestation/media/' + token, kind: 'video', composite: 'green-key', mode: 'reused-base-video', timings: {}, trace } satisfies GeneratedObject, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ code: 'manifestation_failed', trace }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  } finally { await ledger('manifestationFinish', { token, code: outcome, timings: trace.server }).catch(() => {}); }
}
