import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  coerceStreamObservation,
  handleStreamRequest,
  parseStreamObservation,
} from '../server/stream/streamBenchHandler.js';
import sharp from '../server/imageProcessing.js';
import {
  SEVEN_DAYS_TO_DIE_PROFILE,
  streamObservationSchema,
} from '../server/stream/gameProfiles.js';
import { resolveStreamVisionProvider } from '../server/stream/visionProviders.js';
import type { LocalApiConfig } from '../server/localApiSupport.js';
import {
  computeLumaDiff,
  isStaticFrame,
} from '../src/stream/staticFrameSkip.js';
import {
  buildStreamEvidence,
  isEventCooldownActive,
  meetsMinSignificance,
  streamEventSemanticKey,
} from '../src/stream/streamObserver.js';
import { STREAM_OBSERVE_PATH } from '../src/stream/streamContract.js';
import type { StreamObservation } from '../src/stream/streamContract.js';
import { StreamEpisodeTracker } from '../src/stream/streamEpisode.js';

// Real tiny images are required: the sheet endpoint composites frames.
const FAKE_IMAGE = await sharp({
  create: { width: 64, height: 36, channels: 3, background: '#203050' },
})
  .png()
  .toBuffer();

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
        const badWhich = await get(
          port,
          '/api/stream/vlm-bench/fixture-image?id=combat-zombie-enters&which=evil',
        );
        assert.equal(badWhich.status, 400);
        // No contact-sheet file exists, so the handler composes one.
        const sheet = await get(
          port,
          '/api/stream/vlm-bench/fixture-image?id=combat-zombie-enters&which=sheet',
        );
        assert.equal(sheet.status, 200);
        assert.equal(sheet.headers.get('content-type'), 'image/jpeg');
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

test('label endpoint writes meta.json and marks the fixture reviewed', async () => {
  const { root, cleanup } = makeFixtureRoot();
  try {
    const dir = join(root, 'combat-zombie-enters');
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        category: 'combat',
        expectedChanged: true,
        expectedEventKinds: ['enemy_visible'],
        labelDraft: { model: 'gpt-5-mini', reviewed: false },
      }),
    );
    await withServer(
      { streamBenchEnabled: true, streamBenchRoot: root },
      async (port) => {
        const saved = await post(port, '/api/stream/vlm-bench/label', {
          fixtureId: 'combat-zombie-enters',
          expectedChanged: false,
          expectedEventKinds: [],
          category: 'static',
          notes: 'Idle drift only.',
        });
        assert.equal(saved.status, 200);
        const body = (await saved.json()) as {
          fixture: { reviewed: boolean; expectedChanged: boolean };
        };
        assert.equal(body.fixture.reviewed, true);
        assert.equal(body.fixture.expectedChanged, false);
        const meta = JSON.parse(
          readFileSync(join(dir, 'meta.json'), 'utf8'),
        ) as { labelDraft: { reviewed: boolean } };
        assert.equal(meta.labelDraft.reviewed, true);
        const unknown = await post(port, '/api/stream/vlm-bench/label', {
          fixtureId: 'no-such-fixture',
          expectedChanged: true,
          expectedEventKinds: [],
          category: 'combat',
          notes: '',
        });
        assert.equal(unknown.status, 404);
        const badKind = await post(port, '/api/stream/vlm-bench/label', {
          fixtureId: 'combat-zombie-enters',
          expectedChanged: true,
          expectedEventKinds: ['not_a_kind'],
          category: 'combat',
          notes: '',
        });
        assert.equal(badKind.status, 400);
      },
    );
  } finally {
    cleanup();
  }
});

test('event-kinds endpoint lists the profile event kinds', async () => {
  await withServer(
    { streamBenchEnabled: true, streamBenchRoot: tmpdir() },
    async (port) => {
      const response = await get(port, '/api/stream/vlm-bench/event-kinds');
      assert.equal(response.status, 200);
      const body = (await response.json()) as { eventKinds: string[] };
      assert.ok(body.eventKinds.includes('enemy_visible'));
    },
  );
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
  for (const id of [
    'openai-nano',
    'openai-mini',
    'gemini-flash-lite',
    'groq-vision',
    'deepseek-vision',
  ]) {
    assert.ok(resolveStreamVisionProvider(id));
  }
  assert.equal(resolveStreamVisionProvider('nope'), null);
});

const postImage = (port: number, path: string, body: Buffer) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: new Uint8Array(body),
  });

test('observe endpoint is gated by stream mode or bench flag', async () => {
  // Neither stream mode nor bench enabled: hidden.
  await withServer({}, async (port) => {
    const response = await postImage(port, STREAM_OBSERVE_PATH, FAKE_IMAGE);
    assert.equal(response.status, 404);
  });
  // Stream mode alone enables the endpoint.
  await withServer({ mode: 'stream' }, async (port) => {
    const response = await postImage(port, STREAM_OBSERVE_PATH, FAKE_IMAGE);
    // No deepseek key configured in this harness -> 503, not 404.
    assert.equal(response.status, 503);
  });
  // Public mode never exposes it.
  await withServer(
    { mode: 'public', streamBenchEnabled: true },
    async (port) => {
      const response = await postImage(port, STREAM_OBSERVE_PATH, FAKE_IMAGE);
      assert.equal(response.status, 404);
    },
  );
});

test('observe endpoint validates method, provider and content type', async () => {
  await withServer({ mode: 'stream' }, async (port) => {
    const wrongMethod = await fetch(
      `http://127.0.0.1:${port}${STREAM_OBSERVE_PATH}`,
    );
    assert.equal(wrongMethod.status, 405);
    const badProvider = await postImage(
      port,
      `${STREAM_OBSERVE_PATH}?provider=nope`,
      FAKE_IMAGE,
    );
    assert.equal(badProvider.status, 400);
    const badDetail = await postImage(
      port,
      `${STREAM_OBSERVE_PATH}?detail=ultra`,
      FAKE_IMAGE,
    );
    assert.equal(badDetail.status, 400);
    const wrongType = await post(
      port,
      STREAM_OBSERVE_PATH,
      { not: 'an image' },
    );
    assert.equal(wrongType.status, 400);
  });
});

test('luma diff detects static frames at the threshold boundary', () => {
  const base = new Uint8ClampedArray(64).fill(128);
  assert.equal(computeLumaDiff(base, new Uint8ClampedArray(base)), 0);
  const shifted = new Uint8ClampedArray(base);
  // 2.55/255 = 0.01 mean diff when all pixels shift by ~2.55.
  shifted.fill(128 + 5);
  assert.ok(Math.abs(computeLumaDiff(base, shifted) - 5 / 255) < 1e-9);
  // diff == threshold counts as a change: the frame is still sent.
  assert.equal(isStaticFrame(0.02), false);
  assert.equal(isStaticFrame(0.021), false);
  assert.equal(isStaticFrame(0.019), true);
  assert.equal(isStaticFrame(0.03, 0.02), false);
});

test('stream event semantic keys normalize unknown kinds', () => {
  assert.equal(streamEventSemanticKey('enemy_visible'), 'game:7dtd:enemy_visible');
  assert.equal(streamEventSemanticKey('combat'), 'game:7dtd:combat');
  assert.equal(streamEventSemanticKey('not_a_kind'), 'game:7dtd:other');
});

test('stream evidence respects significance floor and cooldown', () => {
  const high = {
    kind: 'enemy_visible',
    summary: '  A zombie entered the room.  ',
    significance: 'high' as const,
  };
  const evidence = buildStreamEvidence(high, 1000);
  assert.ok(evidence);
  assert.equal(evidence.semanticKey, 'game:7dtd:enemy_visible');
  assert.equal(evidence.content, 'A zombie entered the room.');
  assert.equal(evidence.reasonProposals[0].salience, 0.85);
  assert.equal(
    buildStreamEvidence({ ...high, significance: 'low' }, 1000),
    null,
  );
  assert.equal(
    buildStreamEvidence({ ...high, significance: 'low' }, 1000, 'low') !== null,
    true,
  );
  assert.equal(meetsMinSignificance('medium', 'high'), false);
  assert.equal(meetsMinSignificance('high', 'medium'), true);
  // Cooldown: fired at 1000, cooldown 5000 -> active until 6000.
  assert.equal(isEventCooldownActive(1000, 5999, 5000), true);
  assert.equal(isEventCooldownActive(1000, 6000, 5000), false);
  assert.equal(isEventCooldownActive(undefined, 6000, 5000), false);
});

function makeObservation(
  overrides: Partial<StreamObservation> = {},
): StreamObservation {
  return {
    changed: true,
    changeSummary: '',
    events: [],
    scene: { setting: 'outdoor', timeOfDay: 'day', bloodMoon: false },
    player: { activity: 'walking', healthState: 'ok' },
    ...overrides,
  };
}

test('episode tracker folds combat events into one episode with transitions', () => {
  const tracker = new StreamEpisodeTracker();
  const combat = (
    kind: string,
    health: StreamObservation['player']['healthState'] = 'ok',
  ) =>
    makeObservation({
      events: [{ kind, summary: `${kind} seen`, significance: 'medium' }],
      player: { activity: 'fighting', healthState: health },
    });

  // Calm observation: no episode, no transitions.
  assert.deepEqual(tracker.ingest(makeObservation(), 0), []);
  assert.equal(tracker.inCombat, false);

  // First urgent event starts the episode.
  const start = tracker.ingest(combat('enemy_visible'), 1_000);
  assert.equal(tracker.inCombat, true);
  assert.deepEqual(
    start.map((t) => t.kind),
    ['episode_start'],
  );

  // Damage inside the episode counts hits.
  const hit = tracker.ingest(combat('player_damaged', 'hurt'), 3_000);
  assert.deepEqual(
    hit.map((t) => t.kind),
    ['damage_taken'],
  );

  // Critical health emits a high-significance transition; by now the
  // sustained fight also reads as escalating.
  const critical = tracker.ingest(combat('combat', 'critical'), 5_000);
  assert.deepEqual(
    critical.map((t) => t.kind),
    ['health_critical', 'threat_rising'],
  );
  assert.equal(
    critical.find((t) => t.kind === 'health_critical')?.significance,
    'high',
  );

  // The rolling summary describes the episode state.
  const summary = tracker.describe(6_000);
  assert.ok(summary?.includes('1 hits taken'));
  assert.ok(summary?.includes('critical'));

  // Quiet after the end-gap closes the episode exactly once
  // (last urgent observation was at t=5000; the gap is 8s).
  const end = tracker.ingest(makeObservation(), 13_500);
  assert.deepEqual(
    end.map((t) => t.kind),
    ['episode_end'],
  );
  assert.equal(tracker.inCombat, false);
  assert.equal(tracker.describe(14_000), null);
  assert.deepEqual(tracker.ingest(makeObservation(), 14_000), []);
  assert.deepEqual(tracker.ingest(makeObservation(), 20_000), []);
});

test('episode tracker stays silent on routine scenes and dies once', () => {
  const tracker = new StreamEpisodeTracker();
  const death = makeObservation({
    events: [{ kind: 'player_died', summary: 'Player died', significance: 'high' }],
    player: { activity: 'dead', healthState: 'dead' },
  });
  const first = tracker.ingest(death, 1_000);
  assert.ok(first.some((t) => t.kind === 'episode_start'));
  assert.ok(first.some((t) => t.kind === 'player_died'));
  // A second dead observation does not repeat the death.
  const second = tracker.ingest(death, 2_000);
  assert.equal(second.some((t) => t.kind === 'player_died'), false);
});
