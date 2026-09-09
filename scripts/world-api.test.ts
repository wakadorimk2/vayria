import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleRequest, localApiPlugin } from '../server/localApi.js';

test('world API is disabled outside local mode and understands HTTP/2 authority', async () => {
  for (const mode of ['local', 'public', 'exhibition'] as const) {
    const server = createServer((request, response) => {
      request.headers[':authority'] = request.headers.host;
      delete request.headers.host;
      void handleRequest(request, response, { mode, worldMutationEnabled: true });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const url = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${url}/api/world/experiments`, { method: 'POST', headers: { Origin: url } });
      assert.equal(response.status, mode === 'local' ? 503 : 404);
      assert.ok((await response.json()).error);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
test('Vite middleware dispatches world paths even when the feature is disabled', async () => {
  let middleware!: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  const plugin = localApiPlugin({ mode: 'public', worldMutationEnabled: false, ttsBackend: 'aivis-cloud' });
  const hook = plugin.configureServer;
  assert.equal(typeof hook, 'function');
  if (typeof hook !== 'function') return;
  hook.call({} as never, { middlewares: { use(fn: typeof middleware) { middleware = fn; } } } as never);
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(599); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/world/mutate`, { method: 'POST' });
    assert.equal(response.status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('streaming invalid requests produce a terminal NDJSON error without calling image generation', async () => {
  const config = { mode: 'local' as const, worldMutationEnabled: true, openAiApiKey: 'test-only-key' };
  const server = createServer((req, res) => { void handleRequest(req, res, config); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/world/mutate`, { method: 'POST', headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
    const event = JSON.parse((await response.text()).trim());
    assert.equal(event.type, 'error'); assert.equal(event.attempts, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
