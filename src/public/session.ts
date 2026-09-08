import { runtimeConfig } from '../runtimeConfig';
export type PublicStatus = { session: { id: string; expires: number } | null; remainingDay: number; remainingMonth: number;
  enabled?: boolean; siteKey?: string; cookieReady?: boolean; stopped?: boolean };
let session: PublicStatus['session'] = null;
let active = false;
let cancellation = new AbortController();
const tickets = new Map<string, string>();
const listeners = new Set<() => void>();
export const subscribePublic = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const publicActive = () => active;
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
async function performFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (runtimeConfig.mode !== 'public') return fetch(path, init);
  if (!active || !session || session.expires <= Date.now() || document.hidden) {
    pausePublic(); return Response.json({ code: 'session_required', error: '会話を始めるを押してください。' }, { status: 401 });
  }
  const headers = new Headers(init.headers); headers.set('X-Vayria-Session', session.id);
  let body = init.body;
  if (path.endsWith('/api/tts') && typeof body === 'string') {
    const input = JSON.parse(body); const ticket = tickets.get(String(input.text).trim());
    if (!ticket) return Response.json({ code: 'invalid_ticket' }, { status: 403 });
    tickets.delete(String(input.text).trim()); body = JSON.stringify({ ticket });
  }
  const response = await fetch(path, { ...init, body, headers, credentials: 'same-origin',
    signal: AbortSignal.any([cancellation.signal, ...(init.signal ? [init.signal] : [])]) });
  if (response.ok && /\/api\/(chat|card-preview)$/.test(path)) {
    if (response.headers.get('Content-Type')?.startsWith('application/x-ndjson') && response.body) {
      let pending = '';
      const inspect = (line: string) => { const value = JSON.parse(line); if (value.ttsTicket && value.text) tickets.set(value.text.trim(), value.ttsTicket);
        if (value.type === 'error') window.dispatchEvent(new CustomEvent('vayria-public-error', { detail: value })); };
      return new Response(response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, Uint8Array>({
        transform(chunk, controller) {
          pending += chunk; let index: number;
          while ((index = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, index); pending = pending.slice(index + 1);
            if (line.trim()) inspect(line); controller.enqueue(new TextEncoder().encode(line + '\n')); }
        }, flush(controller) { if (pending.trim()) { inspect(pending); controller.enqueue(new TextEncoder().encode(pending)); } },
      })), { status: response.status, headers: response.headers });
    }
    const result = await response.clone().json();
    if (result.ttsTicket && result.text) tickets.set(result.text.trim(), result.ttsTicket);
  }
  if (!response.ok) {
    const reason = await response.clone().json().catch(() => ({}));
    window.dispatchEvent(new CustomEvent('vayria-public-error', { detail: reason }));
  }
  return response;
}
