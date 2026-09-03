import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  appendObservationRecord,
  getCapturePaths,
  initializeCaptureForTest,
  parseObservationCommand,
  readCaptureObservations,
  resolveCaptureSelection,
} from './exhibition-capture.mjs';
import {
  createCsv,
  exportCapture,
  parseExportArgs,
  summarizeCapture,
} from './exhibition-export.mjs';
import {
  parseObserveArgs,
  runObserver,
} from './exhibition-observe.mjs';

test('observation CLI selects a capture safely and supports latest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-exhibition-cli-'));
  try {
    const older = 'ex-20260822000000-abcdef12';
    const newer = 'ex-20260822000100-abcdef34';
    await initializeCaptureForTest(root, {
      captureId: older,
      startedAt: '2026-08-22T00:00:00.000Z',
    });
    await initializeCaptureForTest(root, {
      captureId: newer,
      startedAt: '2026-08-22T00:01:00.000Z',
    });

    assert.deepEqual(parseObserveArgs(['--latest'], { VAYRIA_PLAYCHECK_ROOT: root }), {
      captureId: null,
      latest: true,
      help: false,
      localRoot: root,
    });
    const selected = await resolveCaptureSelection({
      localRoot: root,
      latest: true,
    });
    assert.equal(selected.captureId, newer);
    await assert.rejects(
      resolveCaptureSelection({
        localRoot: root,
        captureId: '../escape',
      }),
      /Invalid exhibition capture ID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('observation commands validate notes, scores, and N/A reasons', () => {
  assert.deepEqual(parseObservationCommand('note 返答の間を観察'), {
    command: 'note',
    note: '返答の間を観察',
  });
  assert.deepEqual(parseObservationCommand('score timing 3'), {
    command: 'score',
    axis: 'timing',
    score: 3,
  });
  assert.deepEqual(
    parseObservationCommand('score emotion N/A 音声を確認できなかった'),
    {
      command: 'score',
      axis: 'emotion',
      score: 'N/A',
      reason: '音声を確認できなかった',
    },
  );
  assert.throws(
    () => parseObservationCommand('score unknown 2'),
    /Unknown rubric axis/,
  );
  assert.throws(
    () => parseObservationCommand('score timing 4'),
    /must be 0, 1, 2, 3, or N\/A/,
  );
  assert.throws(
    () => parseObservationCommand('score timing N/A'),
    /requires a reason/,
  );
  assert.throws(
    () => parseObservationCommand(`note ${'x'.repeat(501)}`),
    /500 characters or fewer/,
  );
});

test('LLM provider latency summary separates interactive sources', () => {
  const metadata = {
    schemaVersion: 1,
    captureId: 'ex-20260822000000-abcdef12',
    mode: 'exhibition',
    startedAt: '2026-08-22T00:00:00.000Z',
    finishedAt: null,
    status: 'active',
  };
  const providerDone = (source, elapsedMs) => ({
    captureId: metadata.captureId,
    event: 'llm_provider_done',
    at: '2026-08-22T00:00:01.000Z',
    source,
    elapsedMs,
  });
  const summary = summarizeCapture({
    metadata,
    observations: [],
    events: [
      providerDone('manual', 10),
      providerDone('manual', 20),
      providerDone('manual', 100),
      providerDone('voice', 30),
      providerDone('card_change', 40),
      providerDone('autonomous', 9_999),
    ],
  });

  assert.deepEqual(summary.runtime.llmProviderLatency, {
    voice: { count: 1, p50Ms: 30, p95Ms: 30 },
    manual: { count: 3, p50Ms: 20, p95Ms: 100 },
    card_change: { count: 1, p50Ms: 40, p95Ms: 40 },
  });
});

test('interactive pipeline latency separates normal, retry, and aborted turns', () => {
  const metadata = {
    schemaVersion: 1,
    captureId: 'ex-20260822000001-abcdef13',
    mode: 'exhibition',
    startedAt: '2026-08-22T00:00:00.000Z',
    finishedAt: null,
    status: 'active',
  };
  const turnEvents = (turnId, source, offset, extra = []) => [
    { event: 'input_received', at: `2026-08-22T00:00:0${offset}.900Z`, elapsedMs: 0, origin: 'client', turnId, source },
    { event: 'llm_start', at: `2026-08-22T00:00:0${offset}.100Z`, elapsedMs: 50, origin: 'client', turnId, source },
    { event: 'llm_provider_first_chunk', at: `2026-08-22T00:00:0${offset}.200Z`, elapsedMs: 800, origin: 'client', purpose: 'response-generation', callIndex: 1, retry: 0, turnId, source },
    { event: 'speech_unit_ready', at: `2026-08-22T00:00:0${offset}.300Z`, elapsedMs: 900, origin: 'client', turnId, source },
    { event: 'tts_start', at: `2026-08-22T00:00:0${offset}.400Z`, elapsedMs: 905, origin: 'client', turnId, source },
    { event: 'tts_first_audio', at: `2026-08-22T00:00:0${offset}.500Z`, elapsedMs: 1300, origin: 'client', turnId, source },
    { event: 'playback_started', at: `2026-08-22T00:00:0${offset}.600Z`, elapsedMs: 1310, origin: 'client', turnId, source },
    ...extra.map((event) => ({ ...event, turnId, source })),
  ];
  const summary = summarizeCapture({
    metadata,
    observations: [],
    events: [
      ...turnEvents('normal-1', 'voice', 1),
      ...turnEvents('retry-1', 'voice', 3, [
        { event: 'llm_provider_done', at: '2026-08-22T00:00:04.500Z', retry: 1 },
      ]),
      ...turnEvents('aborted-1', 'card_change', 5, [
        { event: 'turn_aborted', at: '2026-08-22T00:00:06.500Z' },
      ]),
      {
        event: 'input_received',
        at: '2026-08-22T00:00:07.000Z',
        elapsedMs: 0,
        origin: 'client',
        turnId: 'card-change-mixed',
        source: 'autonomous',
      },
      {
        event: 'llm_provider_first_chunk',
        at: '2026-08-22T00:00:07.700Z',
        elapsedMs: 700,
        origin: 'server',
        turnId: 'card-change-mixed',
        source: 'card_change',
      },
      { event: 'llm_start', at: '2026-08-22T00:00:09.900Z', elapsedMs: 50, origin: 'client', turnId: 'card-change-mixed', source: 'autonomous' },
      { event: 'llm_provider_first_chunk', at: '2026-08-22T00:00:09.800Z', elapsedMs: 700, origin: 'client', purpose: 'response-generation', callIndex: 1, retry: 0, turnId: 'card-change-mixed', source: 'autonomous' },
      {
        event: 'speech_unit_ready',
        at: '2026-08-22T00:00:07.800Z',
        elapsedMs: 800,
        origin: 'client',
        turnId: 'card-change-mixed',
        source: 'autonomous',
      },
      { event: 'tts_start', at: '2026-08-22T00:00:09.700Z', elapsedMs: 805, origin: 'client', turnId: 'card-change-mixed', source: 'autonomous' },
      {
        event: 'tts_first_audio',
        at: '2026-08-22T00:00:08.100Z',
        elapsedMs: 1100,
        origin: 'client',
        turnId: 'card-change-mixed',
        source: 'autonomous',
      },
      {
        event: 'playback_started',
        at: '2026-08-22T00:00:08.110Z',
        elapsedMs: 1110,
        origin: 'client',
        turnId: 'card-change-mixed',
        source: 'autonomous',
      },
    ],
  });

  const voiceNormal = summary.runtime.interactivePipelineLatency.voice.normal;
  assert.equal(voiceNormal.inputToProviderRequestMs.p50Ms, 50);
  assert.equal(voiceNormal.providerRequestToFirstChunkMs.p50Ms, 750);
  assert.deepEqual(voiceNormal.inputToProviderFirstChunkMs, {
    count: 1,
    p50Ms: 800,
    p95Ms: 800,
  });
  assert.equal(voiceNormal.providerFirstChunkToSpeechUnitMs.p50Ms, 100);
  assert.equal(voiceNormal.speechUnitToTtsRequestMs.p50Ms, 5);
  assert.equal(voiceNormal.ttsRequestToFirstAudioMs.p50Ms, 395);
  assert.equal(voiceNormal.speechUnitToTtsFirstAudioMs.p50Ms, 400);
  assert.equal(voiceNormal.ttsFirstAudioToPlaybackMs.p50Ms, 10);
  assert.equal(voiceNormal.inputToPlaybackMs.p50Ms, 1310);
  assert.equal(
    summary.runtime.interactivePipelineLatency.voice.retry.inputToPlaybackMs.count,
    1,
  );
  assert.equal(
    summary.runtime.interactivePipelineLatency.card_change.aborted.inputToPlaybackMs.count,
    1,
  );
  assert.equal(
    summary.runtime.interactivePipelineLatency.card_change.normal.inputToPlaybackMs.p50Ms,
    1110,
  );
  assert.equal(
    summary.runtime.interactivePipelineLatency.manual.normal.inputToPlaybackMs.count,
    0,
  );
});

test('observer CLI saves notes, numeric scores, and N/A reasons without deleting data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-exhibition-observe-'));
  const captureId = 'ex-20260822000200-abcdef56';
  try {
    await initializeCaptureForTest(root, { captureId });
    const output = { isTTY: false, chunks: [], write(value) { this.chunks.push(value); } };
    const result = await runObserver({
      localRoot: root,
      captureId,
      input: Readable.from([
        'note 画面を邪魔せず観察できた\n',
        'score timing 2\n',
        'score emotion N/A 音声確認なし\n',
        'exit\n',
      ]),
      output,
      now: () => '2026-08-22T00:02:01.000Z',
    });
    assert.equal(result.savedCount, 3);
    const observations = await readCaptureObservations(root, captureId);
    assert.equal(observations.length, 3);
    assert.equal(observations[0].note, '画面を邪魔せず観察できた');
    assert.equal(observations[1].score, 2);
    assert.equal(observations[2].score, 'N/A');
    assert.equal(observations[2].reason, '音声確認なし');
    assert.match(output.chunks.join(''), /保存しました/);
    await assert.doesNotReject(readFile(getCapturePaths(root, captureId).metadataPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('export keeps incomplete captures and makes JSON and CSV counts agree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-exhibition-export-'));
  const captureId = 'ex-20260822000300-abcdef78';
  try {
    await initializeCaptureForTest(root, {
      captureId,
      startedAt: '2026-08-22T00:03:00.000Z',
      status: 'active',
    });
    const paths = getCapturePaths(root, captureId);
    await writeFile(
      paths.eventsPath,
      [
        {
          captureId,
          event: 'llm_done',
          at: '2026-08-22T00:03:01.000Z',
          origin: 'server',
          turnId: 'turn-1',
          source: 'manual',
          elapsedMs: 100,
        },
        {
          captureId,
          event: 'tts_ready',
          at: '2026-08-22T00:03:02.000Z',
          origin: 'server',
          turnId: 'turn-1',
          source: 'manual',
          durationMs: 250,
        },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8',
    );
    await appendObservationRecord(
      root,
      captureId,
      { command: 'note', note: '自然, もう一度確認' },
      '2026-08-22T00:03:03.000Z',
    );
    await appendObservationRecord(
      root,
      captureId,
      { command: 'score', axis: 'timing', score: 2 },
      '2026-08-22T00:03:04.000Z',
    );
    await appendObservationRecord(
      root,
      captureId,
      { command: 'score', axis: 'emotion', score: 'N/A', reason: '音声なし' },
      '2026-08-22T00:03:05.000Z',
    );

    const result = await exportCapture({
      localRoot: root,
      captureId,
      generatedAt: '2026-08-22T00:04:00.000Z',
    });
    assert.equal(result.summary.capture.status, 'active');
    assert.equal(result.summary.runtime.eventCount, 2);
    assert.equal(result.summary.runtime.turnCount, 1);
    assert.deepEqual(result.summary.runtime.eventTypes, {
      llm_done: 1,
      tts_ready: 1,
    });
    assert.equal(result.summary.runtime.latency.averageMs, 175);
    assert.equal(result.summary.runtime.latency.p95Ms, 250);
    assert.equal(result.summary.observations.noteCount, 1);
    assert.equal(result.summary.observations.scoreCount, 2);
    assert.equal(result.summary.observations.axisScores.timing.average, 2);
    assert.deepEqual(result.summary.observations.axisScores.emotion.naReasons, ['音声なし']);
    assert.equal(result.summary.rowCount, 5);

    const csv = await readFile(result.rowsPath, 'utf8');
    assert.equal(csv.trim().split(/\r?\n/).length, 6);
    assert.match(csv, /"自然, もう一度確認"/);
    assert.match(csv, /runtime,.*llm_done/);
    assert.match(csv, /observation,.*score/);
    assert.match(
      await readFile(paths.eventsPath, 'utf8'),
      /llm_done/,
      'raw runtime JSONL remains after export',
    );
    assert.deepEqual(parseExportArgs(['--latest'], { VAYRIA_PLAYCHECK_ROOT: root }), {
      captureId: null,
      latest: true,
      help: false,
      localRoot: root,
      outputDir: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CSV generation escapes commas and preserves the same row set', () => {
  const csv = createCsv({
    metadata: {
      captureId: 'ex-20260822000400-abcdef90',
      mode: 'exhibition',
    },
    events: [],
    observations: [
      {
        captureId: 'ex-20260822000400-abcdef90',
        at: '2026-08-22T00:04:00.000Z',
        type: 'note',
        note: 'a,b',
      },
    ],
  });
  assert.match(csv, /"a,b"/);
  assert.equal(csv.trim().split(/\r?\n/).length, 2);
});

test('CSV keeps the legacy columns in place and appends provider telemetry', () => {
  const csv = createCsv({
    metadata: {
      captureId: 'ex-20260822000500-abcdef12',
      mode: 'exhibition',
    },
    events: [],
    observations: [],
  });
  const [header] = csv.trim().split(/\r?\n/);
  const legacyColumns = [
    'recordType',
    'captureId',
    'at',
    'event',
    'observationType',
    'origin',
    'requestId',
    'source',
    'turnId',
    'elapsedMs',
    'durationMs',
    'activeRequests',
    'audioBytes',
    'emotion',
    'phase',
    'reason',
    'interactionAction',
    'axis',
    'score',
    'note',
  ];

  assert.deepEqual(header.split(',').slice(0, legacyColumns.length), legacyColumns);
  assert.deepEqual(header.split(',').slice(legacyColumns.length), [
    'provider',
    'model',
    'purpose',
    'callIndex',
    'retry',
  ]);
});
