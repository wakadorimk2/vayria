import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { LocalApiConfig } from './localApiSupport.js';
import { createWorldProvider } from './worldProvider.js';
import { WorldService, WorldServiceError } from './worldService.js';

const services = new WeakMap<LocalApiConfig, WorldService>();
export async function handleWorldRequest(request: IncomingMessage, response: ServerResponse, config: LocalApiConfig): Promise<void> {
  const json = (status: number, value: unknown) => { if (response.destroyed) return; response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  if (config.mode !== 'local' || !config.worldMutationEnabled) return json(404, { error: 'Not found.' });
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method === 'GET' && /^\/api\/world\/assets\/[a-f0-9]{64}\.png$/.test(path)) {
    try { const bytes = readFileSync(resolve('.world-experiments/assets', path.split('/').pop()!)); response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable' }); response.end(bytes); return; }
    catch { return json(404, { error: 'Not found.' }); }
  }
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  const origin = request.headers.origin;
  const authority = request.headers.host ?? request.headers[':authority'];
  if (origin) {
    try { if (new URL(origin).host !== authority) return json(403, { error: 'Origin mismatch.' }); }
    catch { return json(403, { error: 'Invalid origin.' }); }
  }
  if (!config.openAiApiKey) return json(503, { error: 'OPENAI_API_KEY がありません。:op 起動を使用してください。' });
  let service = services.get(config);
  if (!service) { service = new WorldService(resolve('.world-experiments'), createWorldProvider(config.openAiApiKey)); services.set(config, service); }
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.on('close', abort);
  try {
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 256000) return json(413, { error: 'Request too large.' });
    }
    if (path === '/api/world/experiments') return json(200, service.createExperiment());
    if (path !== '/api/world/mutate') return json(404, { error: 'Not found.' });
    let value: unknown;
    try { value = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON.' }); }
    if (request.headers.accept?.includes('application/x-ndjson')) {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      await service.mutate(value, controller.signal, event => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); });
      response.end();
    } else json(200, await service.mutate(value, controller.signal));
  } catch (error) {
    if (response.headersSent) { if (!response.destroyed) response.end(`${JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : '世界変換に失敗しました。', attempts: error instanceof WorldServiceError ? error.attempts : 0 })}\n`); return; }
    json(error instanceof WorldServiceError ? error.status : 500, { error: error instanceof Error ? error.message : '世界変換に失敗しました。', attempts: error instanceof WorldServiceError ? error.attempts : undefined });
  } finally { response.off('close', abort); }
}
