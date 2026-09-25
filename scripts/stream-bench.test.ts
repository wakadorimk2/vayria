import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  coerceStreamObservation,
  handleStreamRequest,
  parseStreamObservation,
} from '../server/stream/streamBenchHandler.js';
import {
  SEVEN_DAYS_TO_DIE_PROFILE,
  streamObservationSchema,
} from '../server/stream/gameProfiles.js';
import { resolveStreamVisionProvider } from '../server/stream/visionProviders.js';
import type { LocalApiConfig } from '../server/localApiSupport.js';

// PNG magic bytes are enough for the fixture-image endpoint (no decode there).
const FAKE_IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeFixtureRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'vayria-stream-bench-'));
  const valid = join(root, 'combat-zombie-enters');
  mkdirSync(valid);
  writeFileSync(join(valid, 'before.png'), FAKE_IMAGE);
  writeFileSync(join(valid, 'after.png'), FAKE_IMAGE);
  writeFileSync(
    join(valid, 'meta.json'),
    JSON.stringify({
      category: 'combat',
      expectedChanged: true,
      expectedEventKinds: ['enemy_visible'],
    }),
  );
  const incomplete = join(root, 'missing-frames');
  mkdirSync(incomplete);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function withServer(
  config: LocalApiConfig,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((request, response) => {
    void handleStreamRequest(request, response, config).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolvePromise) =>
    server.listen(0, '127.0.0.1', resolvePromise),
  );
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

const get = (port: number, path: string) =>
  fetch(`http://127.0.0.1:${port}${path}`);
const post = (port: number, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('stream bench returns 404 when disabled', async () => {
  await withServer({}, async (port) => {
    const response = await get(port, '/api/stream/vlm-bench/fixtures');
    assert.equal(response.status, 404);
  });
});

test('fixture listing returns only directories with both frames', async () => {
  const { root, cleanup } = makeFixtureRoot();
  try {
    await withServer(
      { streamBenchEnabled: true, streamBenchRoot: root },
      async (port) => {
        const response = await get(port, '/api/stream/vlm-bench/fixtures');
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          fixtures: { id: string; expectedChanged: boolean | null }[];
        };
        assert.deepEqual(
          body.fixtures.map((fixture) => fixture.id),
          ['combat-zombie-enters'],
        );
        assert.equal(body.fixtures[0].expectedChanged, true);
      },
    );
  } finally {
    cleanup();
  }
});

test('fixture-image serves frame bytes and rejects bad input', async () => {
  const { root, cleanup } = makeFixtureRoot();
  try {
    await withServer(
      { streamBenchEnabled: true, streamBenchRoot: root },
      async (port) => {
        const ok = await get(
          port,
          '/api/stream/vlm-bench/fixture-image?id=combat-zombie-enters&which=before',
        );
        assert.equal(ok.status, 200);
        assert.equal(ok.headers.get('content-type'), 'image/png');
        const missing = await get(
          port,
          '/api/stream/vlm-bench/fixture-image?id=missing-frames&which=before',
        );
        assert.equal(missing.status, 404);
        const traversal = await get(
          port,
          '/api/stream/vlm-bench/fixture-image?id=..&which=before',
        );
        assert.equal(traversal.status, 404);
      },
    );
  } finally {
    cleanup();
  }
});

test('bench run validates the request before provider calls', async () => {
  const { root, cleanup } = makeFixtureRoot();
  try {
    await withServer(
      { streamBenchEnabled: true, streamBenchRoot: root },
      async (port) => {
        const badFixture = await post(port, '/api/stream/vlm-bench', {
          fixtureId: '../escape',
          providerId: 'openai-nano',
        });
        assert.equal(badFixture.status, 400);
        const badProvider = await post(port, '/api/stream/vlm-bench', {
          fixtureId: 'combat-zombie-enters',
          providerId: 'not-a-provider',
        });
        assert.equal(badProvider.status, 400);
        const unknownFixture = await post(port, '/api/stream/vlm-bench', {
          fixtureId: 'no-such-fixture',
          providerId: 'openai-nano',
        });
        assert.equal(unknownFixture.status, 404);
        const noKey = await post(port, '/api/stream/vlm-bench', {
          fixtureId: 'combat-zombie-enters',
          providerId: 'openai-nano',
        });
        assert.equal(noKey.status, 503);
      },
    );
  } finally {
    cleanup();
  }
});

test('parseStreamObservation distinguishes JSON errors from schema errors', () => {
  assert.deepEqual(parseStreamObservation('not json'), {
    jsonOk: false,
    observation: null,
  });
  const valid = {
    changed: true,
    changeSummary: 'A zombie appeared.',
    events: [{ kind: 'enemy_visible', summary: 'Zombie in view', significance: 'high' }],
    scene: { setting: 'outdoor', timeOfDay: 'day', bloodMoon: false },
    player: { activity: 'walking', healthState: 'ok' },
  };
  const parsed = parseStreamObservation(JSON.stringify(valid));
  assert.equal(parsed.jsonOk, true);
  assert.deepEqual(parsed.observation, valid);
  const wrongShape = parseStreamObservation(JSON.stringify({ changed: 'yes' }));
  assert.equal(wrongShape.jsonOk, true);
  assert.equal(wrongShape.observation, null);
  const badEvent = parseStreamObservation(
    JSON.stringify({ ...valid, events: [{ kind: 1 }] }),
  );
  assert.equal(badEvent.observation, null);
});

test('coerceStreamObservation tolerates extra significance limits', () => {
  const observation = coerceStreamObservation({
    changed: false,
    changeSummary: '',
    events: [],
    scene: { setting: 'menu', timeOfDay: 'unknown', bloodMoon: false },
    player: { activity: 'idle in menu', healthState: 'unknown' },
  });
  assert.ok(observation);
  assert.equal(observation.changed, false);
});

test('observation schema covers the contract enums', () => {
  const schema = streamObservationSchema(SEVEN_DAYS_TO_DIE_PROFILE) as {
    properties: Record<string, Record<string, unknown>>;
  };
  assert.ok(schema.properties.changed);
  const events = schema.properties.events as {
    items: { properties: { kind: { enum: string[] } } };
  };
  assert.ok(events.items.properties.kind.enum.includes('enemy_visible'));
});

test('all advertised providers resolve', () => {
  for (const id of ['openai-nano', 'groq-vision', 'gemini-flash-lite']) {
    assert.ok(resolveStreamVisionProvider(id));
  }
  assert.equal(resolveStreamVisionProvider('nope'), null);
});
