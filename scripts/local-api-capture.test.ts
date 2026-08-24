import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  localApiPlugin,
  parseVoiceAssistantResponse,
} from '../server/localApi.js';
import {
  readExhibitionCaptureMetadata,
  readExhibitionEvents,
} from '../server/exhibitionCaptureStore.js';
import {
  readPlaycheckRecords,
} from '../server/playcheckStore.js';

interface FakeServer {
  middlewares: {
    use(handler: Middleware): void;
  };
  httpServer: EventEmitter;
}

type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

function createFakeServer(): {
  server: FakeServer;
  handlers: Middleware[];
} {
  const handlers: Middleware[] = [];
  const server: FakeServer = {
    middlewares: {
      use(handler) {
        handlers.push(handler);
      },
    },
    httpServer: new EventEmitter(),
  };
  return { server, handlers };
}

test('voice assistant response keeps action, text, and card contracts together', () => {
  const brainCardIds = ['card-a'];
  const listen = parseVoiceAssistantResponse(
    JSON.stringify({
      voiceAction: 'listen',
      backchannelCue: 'none',
      text: '',
      emotion: 'neutral',
      activatedCards: [],
    }),
    brainCardIds,
    'card-a',
    'えっと',
  );
  assert.equal(listen.voiceAction, 'listen');
  assert.equal(listen.text, '');
  assert.deepEqual(listen.activatedCards, []);

  const backchannel = parseVoiceAssistantResponse(
    JSON.stringify({
      voiceAction: 'backchannel',
      backchannelCue: 'un',
      text: '',
      emotion: 'neutral',
      activatedCards: [],
    }),
    brainCardIds,
    'card-a',
    'うん',
  );
  assert.equal(backchannel.voiceAction, 'backchannel');
  assert.equal(backchannel.backchannelCue, 'un');

  const takeFloor = parseVoiceAssistantResponse(
    JSON.stringify({
      voiceAction: 'take_floor',
      backchannelCue: 'none',
      text: 'それは面白いですわ',
      emotion: 'joy',
      activatedCards: ['card-a'],
    }),
    brainCardIds,
    'card-a',
    '展示について聞きたいです',
  );
  assert.equal(takeFloor.voiceAction, 'take_floor');
  assert.equal(takeFloor.text, 'それは面白いですわ');
  assert.deepEqual(takeFloor.activatedCards, ['card-a']);

  assert.throws(
    () =>
      parseVoiceAssistantResponse(
        JSON.stringify({
          voiceAction: 'listen',
          backchannelCue: 'none',
          text: '',
          emotion: 'neutral',
          activatedCards: [],
        }),
        brainCardIds,
        null,
        '展示について聞きたいです',
      ),
    /take_floor/,
  );
});

async function waitForCaptureId(root: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const entries = await readdir(join(root, 'exhibition'), {
        withFileTypes: true,
      });
      const capture = entries.find((entry) => entry.isDirectory());
      if (capture) return capture.name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error('Exhibition capture was not initialized.');
}

async function postEvent(
  handler: Middleware,
  body: object,
  headers: Record<string, string> = {},
): Promise<number> {
  const request = Object.assign(
    Readable.from([JSON.stringify(body)]),
    {
      method: 'POST',
      url: '/api/events',
      headers,
    },
  ) as unknown as IncomingMessage;
  let statusCode = 0;
  let resolveEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const response = {
    writeHead(status: number) {
      statusCode = status;
    },
    end() {
      resolveEnded();
    },
  } as unknown as ServerResponse;
  handler(request, response, () => undefined);
  await Promise.race([
    ended,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    }),
  ]);
  return statusCode;
}

function configurePlugin(
  config: Parameters<typeof localApiPlugin>[0],
  fake: FakeServer,
): void {
  const plugin = localApiPlugin(config);
  if (!plugin.configureServer || typeof plugin.configureServer !== 'function') {
    throw new Error('local API plugin has no configureServer hook.');
  }
  const configureServer = plugin.configureServer as unknown as (
    server: FakeServer,
  ) => void;
  configureServer(fake);
}

test('exhibition local API captures safe events and keeps Playcheck raw priority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-local-api-capture-'));
  try {
    const fake = createFakeServer();
    configurePlugin(
      {
        aivisBaseUrl: 'not-a-url',
        playcheckRoot: root,
        exhibitionCaptureEnabled: true,
      },
      fake.server,
    );
    const captureId = await waitForCaptureId(root);
    assert.equal(fake.handlers.length, 1);

    assert.equal(
      await postEvent(fake.handlers[0], {
        at: '2026-08-22T00:00:00.000Z',
        elapsedMs: 10,
        event: 'input_received',
        source: 'manual',
        turnId: 'turn-1',
      }),
      204,
    );

    const runId = 'pc-20260822-abcdef12';
    assert.equal(
      await postEvent(
        fake.handlers[0],
        {
          at: '2026-08-22T00:00:01.000Z',
          elapsedMs: 20,
          event: 'turn_completed',
          source: 'manual',
          turnId: 'turn-1',
        },
        { 'x-performer-run-id': runId },
      ),
      204,
    );
    assert.equal(
      await postEvent(fake.handlers[0], {
        at: '2026-08-22T00:00:02.000Z',
        elapsedMs: 30,
        event: 'autonomy_gate',
        source: 'autonomous',
        turnId: 'autonomy-gate-1',
        gateEvent: 'turn_completed',
        gatePhase: 'refractory',
        transition: 'entered_refractory',
        candidateEpisodeId: 'episode-1',
        candidateReasonIds: ['reason-1'],
        candidateEvidenceIds: ['evidence-1'],
        usedReasonIds: ['reason-1'],
        createdReasonIds: ['reason-2'],
        resolvedReasonIds: ['reason-1'],
        externalAction: 'speak',
        nextEligibleAt: 18_000,
        delayMs: 8_000,
      }),
      204,
    );

    const events = await readExhibitionEvents(root, captureId);
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'input_received');
    assert.equal(events[1].event, 'autonomy_gate');
    assert.deepEqual(events[1].usedReasonIds, ['reason-1']);
    assert.deepEqual(events[1].createdReasonIds, ['reason-2']);
    assert.deepEqual(events[1].resolvedReasonIds, ['reason-1']);
    assert.deepEqual(events[1].candidateEvidenceIds, ['evidence-1']);
    assert.equal('message' in events[0], false);
    assert.equal('history' in events[0], false);
    assert.equal('apiKey' in events[0], false);
    assert.equal(
      (await readPlaycheckRecords(root, runId)).length,
      1,
    );

    fake.server.httpServer.emit('close');
    const metadata = await readExhibitionCaptureMetadata(root, captureId);
    assert.equal(metadata.status, 'completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('normal local API configuration does not create exhibition files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-local-api-no-capture-'));
  try {
    const fake = createFakeServer();
    configurePlugin(
      {
        aivisBaseUrl: 'not-a-url',
        playcheckRoot: root,
        exhibitionCaptureEnabled: false,
      },
      fake.server,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await assert.rejects(
      readFile(join(root, 'exhibition'), 'utf8'),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
