import { createGenerationMeasurements, type Measurements } from './diagnostics';
import { PublicUsage } from './usage';
import { LimitError, type Kind, type Limits } from './ledger';
import { boundedBody, cookie, ipKey, sign, verify, wavSeconds } from './security';
import { generate } from './generation';
import { llmExecutionScope } from '../server/llmExecutionScope';
import { synthesizeAivisCloudSpeech } from '../server/tts/aivisCloud';
import { RequestError } from '../server/localApiSupport';
import { readChatRequest, readCardPreviewRequest } from '../server/chatValidation';
import { normalizeEmotion, VOICE_STYLE_BY_EMOTION } from '../src/character/emotion';
export { PublicUsage };

interface Env {
  ASSETS: Fetcher; USAGE: DurableObjectNamespace;
  COOKIE_SECRET: string; IP_SECRET: string; ADMIN_SECRET: string;
  OPENAI_API_KEY: string; AIVIS_API_KEY: string; AIVIS_MODEL_UUID: string;
  AIVIS_SPEAKER_UUID: string;
  TURNSTILE_SECRET: string; TURNSTILE_SITE_KEY: string;
  GENERATION_ENABLED: string; PUBLIC_HOSTNAME: string;
  REQUIRE_PREVIEW_ACCESS: string; PREVIEW_SECRET: string;
  SERVE_PLACEHOLDER?: string;
  PUBLIC_BASE_PATH?: string;
}
type Visitor = { id: string; exp: number; purpose: 'visitor' };
type Ticket = { exp: number; purpose: 'tts'; visitor: string; session: string; nonce: string; text: string; emotion: string };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const previewRedirect = (base: string, ticket?: string) => new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Vayria</title><a href="${base}/">Vayriaを開く</a></html>`, {
  status: 303,
  headers: { Location: `${base}/`, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    ...(ticket ? { 'Set-Cookie': `${base ? '__Host-vayria-staging-preview' : '__Host-vayria-preview'}=${ticket}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` } : {}) },
});
async function ledger<T>(env: Env, op: string, args: object = {}): Promise<T> {
  const response = await env.USAGE.get(env.USAGE.idFromName('public-ledger-v1')).fetch('https://ledger/', {
    method: 'POST', body: JSON.stringify({ op, ...args }),
  });
  const result = await response.json() as { code: string; retryAt: number };
  if (!response.ok) throw new LimitError(result.code, result.retryAt, response.status);
  return result as T;
}
async function body(request: Request) {
  try { return JSON.parse(new TextDecoder().decode(await boundedBody(request, 65536))) as Record<string, unknown>; }
  catch (error) { if (error instanceof LimitError) throw error; throw new LimitError('invalid_request', 0, 400); }
}
async function codeHash(code: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const base = env.PUBLIC_BASE_PATH ?? '';
  if (base !== '' && base !== '/staging') return json({ code: 'configuration_unavailable' }, 503);
  if (base) {
    if (url.hostname === 'staging.vayria.me') {
      const destination = `https://vayria.me/staging${url.pathname}${url.search}`;
      if (!['GET', 'HEAD'].includes(request.method)) return json({ code: 'staging_url_moved', url: destination }, 409);
      return new Response(null, { status: 302, headers: { Location: destination, 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === base) return new Response(null, { status: 308, headers: { Location: `${base}/${url.search}`, 'Cache-Control': 'no-store' } });
    if (!url.pathname.startsWith(base + '/')) return json({ code: 'not_found' }, 404);
    url.pathname = url.pathname.slice(base.length);
    request = new Request(url, request);
  }
  const visitorCookie = base ? '__Host-vayria-staging' : '__Host-vayria';
  const previewCookie = base ? '__Host-vayria-staging-preview' : '__Host-vayria-preview';
  if (env.SERVE_PLACEHOLDER === 'true') return url.pathname.startsWith('/api/') ? json({ code: 'generation_stopped' }, 503) : env.ASSETS.fetch(request);
  if (env.REQUIRE_PREVIEW_ACCESS === 'true' && url.pathname !== '/api/admin') {
    const access = await verify<{ exp: number; purpose: string }>(cookie(request, previewCookie), env.PREVIEW_SECRET);
    // Never pass the form endpoint to Static Assets, including on repeated submissions.
    if (url.pathname === '/preview' && access?.purpose === 'preview') {
      if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({ code: 'invalid_origin' }, 403);
      return previewRedirect(base);
    }
    if (access?.purpose !== 'preview') {
      if (url.pathname === '/preview' && request.method === 'POST' && request.headers.get('Origin') === url.origin) {
        const form = new URLSearchParams(new TextDecoder().decode(await boundedBody(request, 1024)));
        // The preview credential is a random signed ticket, never an API credential.
        const provided = await verify<{ exp: number; purpose: string }>(form.get('ticket') ?? '', env.PREVIEW_SECRET);
        if (provided?.purpose === 'preview') return previewRedirect(base, form.get('ticket')!);
      }
      if (url.pathname.startsWith('/api/')) return json({ code: 'preview_access_required' }, 403);
      return new Response('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex"><title>Vayria 検証環境</title><style>body{margin:0;padding:24px;font:16px system-ui;background:#201c30;color:#f4efe6}form{max-width:360px}input,button{box-sizing:border-box;font:inherit;min-height:44px}input{display:block;width:100%;margin:12px 0}button{padding:8px 24px}</style><h1>Vayria 検証環境</h1><form method="post" action="/preview"><label>検証用アクセスチケット <input name="ticket" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false"></label><button>開く</button></form></html>'.replace('action="/preview"', `action="${base}/preview"`), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
  }
  if (!url.pathname.startsWith('/api/')) {
    if (/^\/exhibition\/?$/.test(url.pathname)) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = '/';
      const response = await env.ASSETS.fetch(new Request(assetUrl, request));
      const headers = new Headers(response.headers);
      headers.set('X-Robots-Tag', 'noindex');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return env.ASSETS.fetch(request);
  }
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) throw new LimitError('invalid_origin', 0, 403);
  if (url.pathname === '/api/admin' && request.method === 'POST') {
    const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
    const auth = await verify<{ exp: number; purpose: string }>(token, env.ADMIN_SECRET);
    if (auth?.purpose !== 'admin') throw new LimitError('unauthorized', 0, 401);
    const input = await body(request);
    if (input.op === 'report') return json(await ledger(env, 'report'));
    if (input.op === 'exhibition-create') return json(await ledger(env, 'exhibition-create', {
      event: input.event, starts: input.starts, expires: input.expires, budget: input.budget,
    }));
    if (input.op === 'exhibition-code') {
      const code = crypto.randomUUID().replaceAll('-', '');
      const result = await ledger<object>(env, 'exhibition-code', { event: input.event, hash: await codeHash(code) });
      return json({ ...result, code });
    }
    if (input.op === 'exhibition-revoke' && typeof input.visitor === 'string') return json(await ledger(env, 'exhibition-revoke', { visitor: input.visitor }));
    if (input.op === 'exhibition-stop' && typeof input.event === 'string') return json(await ledger(env, 'exhibition-stop', { event: input.event }));
    if (input.op !== 'configure' || (input.stopped !== undefined && typeof input.stopped !== 'boolean')) throw new LimitError('invalid_request', 0, 400);
    return json(await ledger(env, 'configure', { patch: input.patch, stopped: input.stopped }));
  }
  const known = ['/api/session', '/api/chat', '/api/card-preview', '/api/transcribe', '/api/tts', '/api/exhibition/enroll', '/api/exhibition/next'];
  if (!known.includes(url.pathname)) return json({ code: 'not_found' }, 404);
  let visitor = await verify<Visitor>(cookie(request, visitorCookie), env.COOKIE_SECRET);
  if (visitor?.purpose !== 'visitor') visitor = null;
  if (url.pathname === '/api/session' && request.method === 'GET') {
    const fresh = !visitor;
    visitor ??= { id: crypto.randomUUID(), exp: Date.now() + 90 * 86400000, purpose: 'visitor' };
    const response = json({ ...await ledger<object>(env, 'status', { visitor: visitor.id }), cookieReady: !fresh,
      enabled: env.GENERATION_ENABLED === 'true', siteKey: env.TURNSTILE_SITE_KEY });
    if (fresh) response.headers.set('Set-Cookie', `${visitorCookie}=${await sign(visitor, env.COOKIE_SECRET)}; Path=/; Max-Age=7776000; Secure; HttpOnly; SameSite=Strict`);
    return response;
  }
  if (!visitor) throw new LimitError('cookie_required', 0, 403);
  const id = request.headers.get('X-Vayria-Session') ?? '';
  const who = { visitor: visitor.id, id };
  if (url.pathname === '/api/exhibition/next' && request.method === 'POST') {
    const input = await body(request);
    return json(await ledger(env, 'exhibition-next', { visitor: visitor.id, requestId: input.requestId, epoch: input.epoch }));
  }
  if (url.pathname === '/api/exhibition/enroll' && request.method === 'POST') {
    await ledger(env, 'attempt', { ip: `enroll:${await ipKey(request, env.IP_SECRET)}` });
    const input = await body(request);
    if (typeof input.code !== 'string' || !/^[a-f0-9]{32}$/.test(input.code)) throw new LimitError('exhibition_code_invalid', 0, 403);
    return json(await ledger(env, 'exhibition-enroll', { visitor: visitor.id, hash: await codeHash(input.code) }));
  }
  if (url.pathname === '/api/session' && request.method === 'DELETE') return json(await ledger(env, 'end', who));
  if (request.method !== 'POST') return json({ code: 'method_not_allowed' }, 405);
  if (env.GENERATION_ENABLED !== 'true') throw new LimitError('generation_stopped', 0, 503);
  if (url.pathname === '/api/session') {
    const ip = await ipKey(request, env.IP_SECRET);
    const status = await ledger<{ session: unknown; exhibition: unknown }>(env, 'status', { visitor: visitor.id });
    await ledger(env, 'attempt', { ip: status.exhibition ? `exhibition:${visitor.id}` : ip });
    if (status.exhibition) {
      const input = await body(request);
      return json(await ledger(env, 'start', { visitor: visitor.id, ip, id: crypto.randomUUID(), epoch: input.epoch }));
    }
    if (status.session) return json(status);
    const input = await body(request);
    if (typeof input.token !== 'string' || input.token.length > 2048) throw new LimitError('challenge_required', 0, 403);
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: input.token }), signal: AbortSignal.timeout(10000),
    });
    const challenge = await result.json() as { success: boolean; hostname: string; action: string };
    if (!result.ok || !challenge.success || challenge.hostname !== env.PUBLIC_HOSTNAME || challenge.action !== 'session') throw new LimitError('challenge_failed', 0, 403);
    return json(await ledger(env, 'start', { visitor: visitor.id, ip, id: crypto.randomUUID() }));
  }
  if (!env.OPENAI_API_KEY || !env.AIVIS_API_KEY || !env.AIVIS_MODEL_UUID) throw new LimitError('configuration_unavailable', 0, 503);
  const audio = url.pathname === '/api/transcribe' ? await boundedBody(request, 640044) : null;
  const input = audio ? {} : await body(request);
  if (url.pathname === '/api/chat') readChatRequest(input);
  if (url.pathname === '/api/card-preview') readCardPreviewRequest(input);
  let ticket: Ticket | null = null;
  if (url.pathname === '/api/tts') {
    ticket = await verify<Ticket>(String(input.ticket ?? ''), env.COOKIE_SECRET);
    if (!ticket || ticket.purpose !== 'tts' || ticket.visitor !== visitor.id || ticket.session !== id) throw new LimitError('invalid_ticket', 0, 403);
  }
  const preview = url.pathname === '/api/card-preview';
  const cardReaction = input.mode === 'autonomous' && typeof input.forcedCardId === 'string' &&
    typeof input.programContext === 'object' && input.programContext !== null &&
    (input.programContext as Record<string, unknown>).phase === 'after_card_change';
  const kind: Kind = audio ? 'transcribe' : ticket ? 'tts' : preview || cardReaction ? 'card' : input.mode === 'autonomous' ? 'autonomous' : 'user';
  const job = crypto.randomUUID();
  const amount = audio ? wavSeconds(audio) : ticket ? Array.from(ticket.text).length : 0;
  let admission: { limits: Limits; expires: number };
  try { admission = await ledger(env, 'begin', { ...who, kind, job, amount, ticket: ticket?.nonce }); }
  catch (error) {
    if (error instanceof LimitError) await ledger(env, 'reject', { kind, code: error.code }).catch(() => {});
    throw error;
  }
  const { limits, expires } = admission;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, Math.min(90000, expires - Date.now())))]);
  const reserve = async (amount: number) => { const charge = crypto.randomUUID(); await ledger(env, 'reserve', { ...who, job, charge, amount: Math.ceil(amount) }); return charge; };
  const measurements: Measurements = {};
  let streaming = false;
  let outcome = 'provider_failure';
  try {
    if (audio) {
      // Per-minute pricing is only an estimate. Reserve the documented model context/output ceiling.
      const charge = await reserve((16000 * 1.25 + 2000 * 5) * limits.usdJpy);
      const form = new FormData(); form.set('model', 'gpt-4o-mini-transcribe'); form.set('language', 'ja');
      form.set('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'speech.wav');
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form, signal });
      if (!response.ok) throw new LimitError('provider_unavailable', 0, 502);
      const result = await response.json() as { text: string; usage?: { input_tokens?: number; output_tokens?: number } };
      if (Number.isSafeInteger(result.usage?.input_tokens) && Number.isSafeInteger(result.usage?.output_tokens)) {
        await ledger(env, 'settle', { charge, amount: Math.ceil((result.usage!.input_tokens! * 1.25 + result.usage!.output_tokens! * 5) * limits.usdJpy) });
      }
      outcome = 'complete'; return json({ text: result.text });
    }
    if (ticket) {
      // Keep the conservative reservation when the provider does not report billable usage.
      await reserve(ticket.text.length * 440 / 10000 * 1e6);
      const ttsStarted = performance.now();
      try {
        const speech = await synthesizeAivisCloudSpeech({ apiKey: env.AIVIS_API_KEY, modelUuid: env.AIVIS_MODEL_UUID, speakerUuid: env.AIVIS_SPEAKER_UUID,
          text: ticket.text, styleName: VOICE_STYLE_BY_EMOTION[normalizeEmotion(ticket.emotion)], speakingRate: 1.15, pitch: 0, emotionalIntensity: 1, tempoDynamics: 1, signal });
        try {
          const reader = speech.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
          while (true) { const part = await reader.read(); if (part.done) break; if (part.value.length) measurements.ttsFirstByteMs ??= performance.now() - ttsStarted; speech.markFirstAudioReceived(); size += part.value.length;
            if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new LimitError('provider_unavailable', 0, 502); } chunks.push(part.value); }
          outcome = 'complete'; return new Response(new Blob(chunks as Uint8Array<ArrayBuffer>[], { type: speech.contentType }), { headers: { 'Content-Type': speech.contentType, 'Cache-Control': 'no-store' } });
        } finally { speech.dispose(); }
      } finally { measurements.ttsTotalMs = performance.now() - ttsStarted; }
    }
    const execution: NonNullable<ReturnType<typeof llmExecutionScope.getStore>> = { execute: async (llmRequest, run) => {
      // UTF-8 bytes plus framing safely overestimate token count for this fixed text-only request.
      const bytes = new TextEncoder().encode(JSON.stringify({ static: llmRequest.staticPrompt, dynamic: llmRequest.dynamicPrompt,
        history: llmRequest.history, message: llmRequest.userMessage, output: llmRequest.output })).length + 2048;
      const charge = await reserve((bytes * .05 + llmRequest.maxOutputTokens * .4) * limits.usdJpy);
      const result = await run();
      if (result.responses?.usage.inputTokens !== undefined && result.responses.usage.outputTokens !== undefined) await ledger(env, 'settle', { charge, amount: Math.ceil((result.responses.usage.inputTokens * .05 + result.responses.usage.outputTokens * .4) * limits.usdJpy) });
      return result;
    } };
    const issue = (text: string, emotion: unknown) => sign({ purpose: 'tts', visitor: visitor.id, session: id, nonce: crypto.randomUUID(), text, emotion: normalizeEmotion(emotion), exp: Date.now() + 60000 }, env.COOKIE_SECRET);
    if (input.streamSpeech === true && !preview) {
      streaming = true;
      const abort = new AbortController();
      const generation = createGenerationMeasurements();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (value: object) => controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
          let queue = Promise.resolve(); let rejected = false;
          void (async () => {
            try {
              const response = await llmExecutionScope.run(execution, () => generate(input, false, env.OPENAI_API_KEY,
                AbortSignal.any([signal, abort.signal]), { onStateRejected() { rejected = true; }, onDeliveryMetadataRejected() { rejected = true; }, onSpeechUnit(index, text, candidate) {
                  generation.firstSpeechUnit();
                  queue = queue.then(async () => { send({ type: 'speech_unit', index, text, ttsTicket: await issue(text, candidate.emotion),
                    response: input.mode === 'voice' ? { ...candidate, interactionAction: candidate.voiceAction } : candidate }); });
                  void queue.catch(() => abort.abort());
                } }, generation));
              await queue;
              send({ type: 'state', internalDelta: 'internalDelta' in response ? response.internalDelta : { reasonUpdates: [] }, rejected });
              send({ type: 'done', response });
              outcome = 'complete';
            } catch (error) {
              if (error instanceof LimitError) outcome = error.code;
              if (!abort.signal.aborted) send({ type: 'error', error: '会話を完了できませんでした。',
                code: error instanceof LimitError ? error.code : 'generation_failed', retryAt: error instanceof LimitError ? error.retryAt : 0 });
            }
            finally { generation.finish(); Object.assign(measurements, generation.values); await ledger(env, 'finish', { job, measurements, code: abort.signal.aborted || request.signal.aborted ? 'cancelled' : signal.aborted ? 'timeout' : outcome }).catch(() => {}); if (!abort.signal.aborted) controller.close(); }
          })();
        }, cancel() { abort.abort(); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
    }
    const generation = createGenerationMeasurements();
    let response: Awaited<ReturnType<typeof generate>>;
    try { response = await llmExecutionScope.run(execution, () => generate(input, preview, env.OPENAI_API_KEY, signal, null, generation)); }
    finally { generation.finish(); Object.assign(measurements, generation.values); }
    const text = 'text' in response && typeof response.text === 'string' ? response.text : '';
    const result = json({ ...response, ttsTicket: text ? await issue(text, response.emotion) : undefined });
    outcome = 'complete'; return result;
  } catch (error) { if (error instanceof LimitError) outcome = error.code; throw error;
  } finally { if (!streaming) await ledger(env, 'finish', { job, measurements, code: request.signal.aborted ? 'cancelled' : signal.aborted ? 'timeout' : outcome }).catch(() => {}); }
}
export default { async fetch(request: Request, env: Env) {
  try {
    const response = await handle(request, env);
    const location = response.headers.get('Location');
    const base = env.PUBLIC_BASE_PATH;
    if (base === '/staging' && location?.startsWith('/') && !location.startsWith('//') && location !== base && !location.startsWith(base + '/')) {
      const headers = new Headers(response.headers); headers.set('Location', base + location);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  }
  catch (error) {
    if (error instanceof RequestError) return json({ code: 'invalid_request' }, 400);
    const known = error instanceof LimitError;
    const response = json({ code: known ? error.code : 'service_unavailable', retryAt: known ? error.retryAt : 0 }, known ? error.status : 503);
    if (known && error.retryAt) response.headers.set('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))));
    return response;
  }
} } satisfies ExportedHandler<Env>;
