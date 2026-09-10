import { publicErrorMessage } from './errors';
import { runtimeConfig } from '../runtimeConfig';
export type PublicStatus = { session: { id: string; expires: number } | null; remainingDay: number; remainingMonth: number;
  enabled?: boolean; siteKey?: string; cookieReady?: boolean; stopped?: boolean };
let session: PublicStatus['session'] = null;
let active = false;
let cancellation = new AbortController();
const tickets = new Map<string, string[]>();
function rememberTicket(text: string, ticket: string) {
  const key = text.trim();
  tickets.set(key, [...(tickets.get(key) ?? []), ticket]);
}
const listeners = new Set<() => void>();
export const subscribePublic = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const publicActive = () => active;
// Requested by explicit card, text, or microphone actions; never by page load.
let sessionRequestHandler: (() => Promise<boolean>) | null = null;
export function registerPublicSessionRequest(handler: () => Promise<boolean>) {
  sessionRequestHandler = handler;
  return () => { if (sessionRequestHandler === handler) sessionRequestHandler = null; };
}
export async function requestPublicSession(): Promise<boolean> {
  if (runtimeConfig.mode !== 'public') return true;
  if (document.hidden) return false;
  if (active && session && session.expires > Date.now()) return true;
  return sessionRequestHandler ? sessionRequestHandler() : false;
}
export function activatePublic(value: PublicStatus['session']) {
  session = value; active = !!value; cancellation.abort(); cancellation = new AbortController(); tickets.clear();
  for (const listener of listeners) listener();
  window.dispatchEvent(new Event(active ? 'vayria-public-start' : 'vayria-public-stop'));
}
export function pausePublic() { activatePublic(null); }
export const publicSessionId = () => session?.id ?? '';
let ttsQueue = Promise.resolve();
export async function publicFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (runtimeConfig.mode !== 'public' || !path.endsWith('/api/tts')) return performFetch(path, init);
  const sessionId = publicSessionId();
  const response = ttsQueue.then(() => {
    if (publicSessionId() !== sessionId || init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return performFetch(path, init);
  });
  ttsQueue = response.then(() => {}, () => {});
  return response;
}
async function performFetch(path: string, init: RequestInit = {}, continuationRetries = 0): Promise<Response> {
  if (runtimeConfig.mode !== 'public') return fetch(path, init);
  if (!active || !session || session.expires <= Date.now() || document.hidden) {
    pausePublic(); return Response.json({ code: 'session_required', error: publicErrorMessage({ code: 'session_required' }) }, { status: 401 });
  }
  const headers = new Headers(init.headers); headers.set('X-Vayria-Session', session.id);
  let body = init.body;
  if (/\/api\/(chat|card-preview)$/.test(path)) tickets.clear();
  if (path.endsWith('/api/tts') && typeof body === 'string') {
    const input = JSON.parse(body); const key = String(input.text).trim(); const ticket = tickets.get(key)?.shift();
    if (!ticket) return Response.json({ code: 'invalid_ticket', error: publicErrorMessage({ code: 'invalid_ticket' }) }, { status: 403 });
    if (!tickets.get(key)?.length) tickets.delete(key);
    body = JSON.stringify({ ticket });
  }
  const signal = AbortSignal.any([cancellation.signal, ...(init.signal ? [init.signal] : [])]);
  let response: Response;
  try { response = await fetch(path, { ...init, body, headers, credentials: 'same-origin',
    signal });
  } catch (error) {
    if (signal.aborted) throw error;
    response = Response.json({ code: 'network_error' }, { status: 503 });
  }
  if (response.ok && /\/api\/(chat|card-preview)$/.test(path)) {
    if (response.headers.get('Content-Type')?.startsWith('application/x-ndjson') && response.body) {
      let pending = '';
      const inspect = (line: string) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const value = JSON.parse(line); if (value.ttsTicket && value.text) rememberTicket(value.text, value.ttsTicket);
        if (value.type === 'error') { value.error = publicErrorMessage(value); window.dispatchEvent(new CustomEvent('vayria-public-error', { detail: value })); }
        return JSON.stringify(value); };
      const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, Uint8Array>({
        transform(chunk, controller) {
          pending += chunk; let index: number;
          while ((index = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, index); pending = pending.slice(index + 1);
            controller.enqueue(new TextEncoder().encode((line.trim() ? inspect(line) : line) + '\n')); }
        }, flush(controller) { if (pending.trim()) { controller.enqueue(new TextEncoder().encode(inspect(pending))); } },
      })).getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) controller.close(); else controller.enqueue(part.value);
          } catch (error) {
            if (signal.aborted) { controller.error(error); return; }
            const reason = { type: 'error', code: error instanceof SyntaxError ? 'generation_failed' : 'network_error' };
            const value = { ...reason, error: publicErrorMessage(reason) };
            window.dispatchEvent(new CustomEvent('vayria-public-error', { detail: value }));
            controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
            controller.close();
          }
        },
        cancel(reason) { return reader.cancel(reason); },
      });
      const streamHeaders = new Headers(response.headers);
      streamHeaders.delete('content-length'); streamHeaders.delete('content-encoding');
      return new Response(stream, { status: response.status, headers: streamHeaders });
    }
    const result = await response.clone().json();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (Array.isArray(result.ttsTickets)) {
      for (const unit of result.ttsTickets) {
        if (typeof unit.text === 'string' && typeof unit.ttsTicket === 'string') rememberTicket(unit.text, unit.ttsTicket);
      }
    } else if (result.ttsTicket && result.text) rememberTicket(result.text, result.ttsTicket);
  }
  if (!response.ok) {
    const reason = await response.clone().json().catch(() => ({}));
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    // The cancelled request may still be releasing its server-side session lock.
    if (reason.code === 'busy' && continuationRetries < 2 && path.endsWith('/api/chat') &&
      typeof init.body === 'string' && JSON.parse(init.body).cardContinuation) {
      await new Promise<void>((resolve, reject) => {
        const delay = Number.isFinite(reason.retryAt) ? Math.max(0, Math.min(1000, reason.retryAt - Date.now())) : 1000;
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, delay);
        function cancel() { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new DOMException('Aborted', 'AbortError')); }
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      });
      return performFetch(path, init, continuationRetries + 1);
    }
    window.dispatchEvent(new CustomEvent('vayria-public-error', { detail: { ...reason, source: path } }));
    const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
    return Response.json({ ...reason, error: publicErrorMessage(reason) }, { status: response.status, headers });
  }
  return response;
}
