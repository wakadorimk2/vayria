import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUBRIC_AXES } from './playcheck.mjs';
import {
  readCaptureData,
  resolveCaptureSelection,
  resolveLocalRoot,
} from './exhibition-capture.mjs';

const CSV_COLUMNS = [
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
  'provider',
  'model',
  'purpose',
  'callIndex',
  'retry',
  'unitIndex',
  'characterCount',
  'profile',
  'apiEndpoint',
  'cacheMode',
  'cacheKeyVersion',
  'cacheStatus',
  'requestedTier',
  'actualTier',
  'actualModel',
  'inputTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
  'staticPrefixChars',
  'dynamicContextChars',
  'schemaBytes',
  'historyItemCount',
  'historyChars',
  'requestBytes',
  'warmup',
  'fallbackReason',
];

function average(values) {
  if (values.length === 0) return null;
  return Number(
    (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2),
  );
}

function timestampValues(records) {
  return records
    .map((record) => ({ value: Date.parse(record.at), at: record.at }))
    .filter(({ value }) => Number.isFinite(value))
    .sort((left, right) => left.value - right.value);
}

function summarizeLatency(events) {
  const values = events
    .map((event) =>
      typeof event.durationMs === 'number'
        ? event.durationMs
        : event.elapsedMs,
    )
    .filter(
      (value) =>
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0,
    )
    .sort((left, right) => left - right);
  if (values.length === 0) {
    return {
      count: 0,
      minMs: null,
      maxMs: null,
      averageMs: null,
      p95Ms: null,
    };
  }
  const p95Index = Math.max(0, Math.ceil(values.length * 0.95) - 1);
  return {
    count: values.length,
    minMs: values[0],
    maxMs: values.at(-1),
    averageMs: average(values),
    p95Ms: values[p95Index],
  };
}

function summarizeLlmProviderLatency(events) {
  const interactiveSources = ['voice', 'manual', 'card_change'];
  return Object.fromEntries(
    interactiveSources.map((source) => {
      const values = events
        .filter(
          (event) =>
            event.event === 'llm_provider_done' &&
            event.source === source &&
            event.warmup !== 1,
        )
        .map((event) => event.elapsedMs)
        .filter(
          (value) =>
            typeof value === 'number' &&
            Number.isFinite(value) &&
            value >= 0,
        )
        .sort((left, right) => left - right);
      const p50Index = Math.max(0, Math.ceil(values.length * 0.5) - 1);
      const p95Index = Math.max(0, Math.ceil(values.length * 0.95) - 1);
      return [
        source,
        {
          count: values.length,
          p50Ms: values[p50Index] ?? null,
          p95Ms: values[p95Index] ?? null,
        },
      ];
    }),
  );
}

function summarizeLlmCacheProfiles(events) {
  const abortedTurns = new Set(
    events
      .filter(
        (event) =>
          event.event === 'turn_aborted' && typeof event.turnId === 'string',
      )
      .map((event) => event.turnId),
  );
  const groups = new Map();
  for (const event of events) {
    if (event.event !== 'llm_provider_done') continue;
    if (!Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) continue;
    const group = {
      source: event.source ?? 'unknown',
      purpose: event.purpose ?? 'unknown',
      profile: event.profile ?? 'unknown',
      cacheStatus: event.cacheStatus ?? 'unknown',
      tier: event.actualTier ?? event.requestedTier ?? 'unknown',
      retry: Number.isInteger(event.retry) ? event.retry : 0,
      fallback: typeof event.fallbackReason === 'string',
      warmup: event.warmup === 1,
      aborted:
        typeof event.turnId === 'string' && abortedTurns.has(event.turnId),
    };
    const key = JSON.stringify(group);
    const values = groups.get(key) ?? { ...group, values: [] };
    values.values.push(event.elapsedMs);
    groups.set(key, values);
  }
  return [...groups.values()]
    .map(({ values, ...group }) => ({
      ...group,
      count: values.length,
      p50Ms: nearestRank(values, 0.5),
      p95Ms: nearestRank(values, 0.95),
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function nearestRank(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizePipelineMetric(values) {
  return {
    count: values.length,
    p50Ms: nearestRank(values, 0.5),
    p95Ms: nearestRank(values, 0.95),
  };
}

function firstClientEventElapsed(events, eventName) {
  const elapsedValues = events
    .filter(
      (event) =>
        event.event === eventName &&
        event.origin === 'client' &&
        Number.isInteger(event.elapsedMs) &&
        event.elapsedMs >= 0,
    )
    .map((event) => event.elapsedMs)
    .sort((left, right) => left - right);
  return elapsedValues[0] ?? null;
}

function firstClientEventDuration(events, eventName) {
  const values = events
    .filter(
      (event) =>
        event.event === eventName &&
        event.origin === 'client' &&
        Number.isInteger(event.durationMs) &&
        event.durationMs >= 0,
    )
    .map((event) => event.durationMs)
    .sort((left, right) => left - right);
  return values[0] ?? null;
}

function segmentDuration(from, to) {
  return from !== null && to !== null && to >= from ? to - from : null;
}

function summarizeInteractivePipeline(events) {
  const interactiveSources = ['voice', 'manual', 'card_change'];
  const groups = ['normal', 'retry', 'aborted'];
  const metricNames = [
    'inputToProviderRequestMs',
    'providerRequestToFirstChunkMs',
    'inputToProviderFirstChunkMs',
    'providerFirstChunkToSpeechUnitMs',
    'speechUnitToTtsRequestMs',
    'ttsRequestToFirstAudioMs',
    'speechUnitToTtsFirstAudioMs',
    'ttsFirstAudioToPlaybackMs',
    'inputToPlaybackMs',
    'continuationQueueGapMs',
  ];
  const turns = new Map();
  for (const event of events) {
    if (typeof event.turnId !== 'string') continue;
    const turn = turns.get(event.turnId) ?? { events: [] };
    turn.events.push(event);
    turns.set(event.turnId, turn);
  }

  const result = Object.fromEntries(
    interactiveSources.map((source) => [
      source,
      Object.fromEntries(
        groups.map((group) => [
          group,
          Object.fromEntries(metricNames.map((name) => [name, []])),
        ]),
      ),
    ]),
  );

  for (const turn of turns.values()) {
    const source =
      turn.events.find(
        (event) =>
          event.event.startsWith('llm_provider_') &&
          interactiveSources.includes(event.source),
      )?.source ??
      turn.events.find((event) => interactiveSources.includes(event.source))?.source;
    if (!source) continue;
    const aborted = turn.events.some((event) => event.event === 'turn_aborted');
    const retried = turn.events.some(
      (event) =>
        event.event === 'llm_provider_done' &&
        Number.isInteger(event.retry) &&
        event.retry > 0,
    );
    const group = aborted ? 'aborted' : retried ? 'retry' : 'normal';
    const input = firstClientEventElapsed(turn.events, 'input_received');
    const providerRequest = firstClientEventElapsed(turn.events, 'llm_start');
    const providerFirstChunk = firstClientEventElapsed(
      turn.events,
      'llm_provider_first_chunk',
    );
    const speechUnit = firstClientEventElapsed(turn.events, 'speech_unit_ready');
    const ttsRequest = firstClientEventElapsed(turn.events, 'tts_start');
    const ttsFirstAudio = firstClientEventElapsed(turn.events, 'tts_first_audio');
    const playback = firstClientEventElapsed(turn.events, 'playback_started');
    const values = {
      inputToProviderRequestMs: segmentDuration(input, providerRequest),
      providerRequestToFirstChunkMs: segmentDuration(
        providerRequest,
        providerFirstChunk,
      ),
      inputToProviderFirstChunkMs: segmentDuration(input, providerFirstChunk),
      providerFirstChunkToSpeechUnitMs: segmentDuration(providerFirstChunk, speechUnit),
      speechUnitToTtsRequestMs: segmentDuration(speechUnit, ttsRequest),
      ttsRequestToFirstAudioMs: segmentDuration(ttsRequest, ttsFirstAudio),
      speechUnitToTtsFirstAudioMs: segmentDuration(speechUnit, ttsFirstAudio),
      ttsFirstAudioToPlaybackMs: segmentDuration(ttsFirstAudio, playback),
      inputToPlaybackMs: segmentDuration(input, playback),
      continuationQueueGapMs: firstClientEventDuration(
        turn.events,
        'tts_queue_gap',
      ),
    };
    for (const [name, value] of Object.entries(values)) {
      if (value !== null) result[source][group][name].push(value);
    }
  }

  return Object.fromEntries(
    interactiveSources.map((source) => [
      source,
      Object.fromEntries(
        groups.map((group) => [
          group,
          Object.fromEntries(
            metricNames.map((name) => [
              name,
              summarizePipelineMetric(result[source][group][name]),
            ]),
          ),
        ]),
      ),
    ]),
  );
}

function summarizeAxisScores(observations) {
  return Object.fromEntries(
    RUBRIC_AXES.map((axis) => {
      const axisScores = observations.filter(
        (observation) => observation.type === 'score' && observation.axis === axis,
      );
      const numericScores = axisScores
        .map((observation) => observation.score)
        .filter((score) => Number.isInteger(score) && score >= 0 && score <= 3);
      const naReasons = axisScores
        .filter((observation) => observation.score === 'N/A')
        .map((observation) => observation.reason)
        .filter((reason) => typeof reason === 'string' && reason.length > 0);
      return [
        axis,
        {
          count: axisScores.length,
          numericCount: numericScores.length,
          naCount: axisScores.length - numericScores.length,
          average: average(numericScores),
          naReasons,
        },
      ];
    }),
  );
}

export function summarizeCapture({ metadata, events, observations }, generatedAt = new Date().toISOString()) {
  const timestamps = timestampValues(events);
  const byEvent = {};
  const turnIds = new Set();
  const sources = new Set();
  for (const event of events) {
    byEvent[event.event] = (byEvent[event.event] ?? 0) + 1;
    if (typeof event.turnId === 'string') turnIds.add(event.turnId);
    if (typeof event.source === 'string') sources.add(event.source);
  }
  const noteCount = observations.filter(
    (observation) => observation.type === 'note',
  ).length;
  const scoreCount = observations.filter(
    (observation) => observation.type === 'score',
  ).length;

  return {
    schemaVersion: 1,
    generatedAt,
    capture: {
      captureId: metadata.captureId,
      mode: metadata.mode,
      status: metadata.status,
      startedAt: metadata.startedAt,
      finishedAt: metadata.finishedAt,
    },
    runtime: {
      eventCount: events.length,
      turnCount: turnIds.size,
      eventTypes: byEvent,
      sources: [...sources].sort(),
      firstAt: timestamps[0]?.at ?? null,
      lastAt: timestamps.at(-1)?.at ?? null,
      latency: summarizeLatency(events),
      llmProviderLatency: summarizeLlmProviderLatency(events),
      llmCacheProfiles: summarizeLlmCacheProfiles(events),
      interactivePipelineLatency: summarizeInteractivePipeline(events),
    },
    observations: {
      count: observations.length,
      noteCount,
      scoreCount,
      axisScores: summarizeAxisScores(observations),
    },
    rowCount: events.length + observations.length,
  };
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function escapeCsv(value) {
  const text = csvValue(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function eventRow(captureId, event) {
  return {
    recordType: 'runtime',
    captureId,
    at: event.at,
    event: event.event,
    origin: event.origin,
    requestId: event.requestId,
    source: event.source,
    turnId: event.turnId,
    elapsedMs: event.elapsedMs,
    durationMs: event.durationMs,
    activeRequests: event.activeRequests,
    audioBytes: event.audioBytes,
    provider: event.provider,
    model: event.model,
    purpose: event.purpose,
    callIndex: event.callIndex,
    retry: event.retry,
    unitIndex: event.unitIndex,
    characterCount: event.characterCount,
    profile: event.profile,
    apiEndpoint: event.apiEndpoint,
    cacheMode: event.cacheMode,
    cacheKeyVersion: event.cacheKeyVersion,
    cacheStatus: event.cacheStatus,
    requestedTier: event.requestedTier,
    actualTier: event.actualTier,
    actualModel: event.actualModel,
    inputTokens: event.inputTokens,
    cachedTokens: event.cachedTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    outputTokens: event.outputTokens,
    reasoningTokens: event.reasoningTokens,
    staticPrefixChars: event.staticPrefixChars,
    dynamicContextChars: event.dynamicContextChars,
    schemaBytes: event.schemaBytes,
    historyItemCount: event.historyItemCount,
    historyChars: event.historyChars,
    requestBytes: event.requestBytes,
    warmup: event.warmup,
    fallbackReason: event.fallbackReason,
    emotion: event.emotion,
    phase: event.phase,
    reason: event.reason,
    interactionAction: event.interactionAction,
  };
}

function observationRow(captureId, observation) {
  return {
    recordType: 'observation',
    captureId,
    at: observation.at,
    observationType: observation.type,
    axis: observation.axis,
    score: observation.score,
    reason: observation.reason,
    note: observation.note,
  };
}

export function createCsvRows({ metadata, events, observations }) {
  const rows = [
    ...events.map((event) => eventRow(metadata.captureId, event)),
    ...observations.map((observation) =>
      observationRow(metadata.captureId, observation),
    ),
  ];
  rows.sort((left, right) => String(left.at).localeCompare(String(right.at)));
  return rows;
}

export function createCsv({ metadata, events, observations }) {
  const rows = createCsvRows({ metadata, events, observations });
  const lines = [
    CSV_COLUMNS.join(','),
    ...rows.map((row) =>
      CSV_COLUMNS.map((column) => escapeCsv(row[column])).join(','),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export async function exportCapture({
  localRoot = resolveLocalRoot(),
  captureId = null,
  latest = false,
  outputDir = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const selected = await resolveCaptureSelection({
    localRoot,
    captureId,
    latest,
  });
  const data = await readCaptureData(localRoot, selected.captureId);
  const summary = summarizeCapture(data, generatedAt);
  const destination = resolve(outputDir ?? selected.paths.exportDirectoryPath);
  const summaryPath = resolve(destination, 'summary.json');
  const rowsPath = resolve(destination, 'rows.csv');
  await mkdir(destination, { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(rowsPath, createCsv(data), 'utf8');
  return { ...selected, summary, summaryPath, rowsPath };
}

function readOptionValue(argv, index, optionName) {
  const argument = argv[index];
  if (argument.includes('=')) {
    return [argument.slice(argument.indexOf('=') + 1), index];
  }
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return [next, index + 1];
}

export function parseExportArgs(argv, environment = process.env) {
  const options = {
    captureId: null,
    latest: false,
    help: false,
    localRoot: resolveLocalRoot(environment),
    outputDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--latest') {
      options.latest = true;
      continue;
    }
    if (argument === '--capture-id' || argument.startsWith('--capture-id=')) {
      const [value, nextIndex] = readOptionValue(argv, index, '--capture-id');
      if (!value.trim()) throw new Error('--capture-id must not be empty.');
      options.captureId = value.trim();
      index = nextIndex;
      continue;
    }
    if (argument === '--local-root' || argument.startsWith('--local-root=')) {
      const [value, nextIndex] = readOptionValue(argv, index, '--local-root');
      if (!value.trim()) throw new Error('--local-root must not be empty.');
      options.localRoot = value;
      index = nextIndex;
      continue;
    }
    if (argument === '--output' || argument.startsWith('--output=')) {
      const [value, nextIndex] = readOptionValue(argv, index, '--output');
      if (!value.trim()) throw new Error('--output must not be empty.');
      options.outputDir = value;
      index = nextIndex;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (options.captureId && options.latest) {
    throw new Error('Use either --capture-id or --latest, not both.');
  }
  return options;
}

function printHelp(output = process.stdout) {
  output.write('Vayria exhibition export:\n');
  output.write('  npm run exhibition:export -- --capture-id <captureId>\n');
  output.write('  npm run exhibition:export -- --latest\n');
  output.write('  --output <directory>  export先を変更します\n');
}

async function main() {
  const options = parseExportArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = await exportCapture(options);
  console.log(`Exported capture: ${result.captureId}`);
  console.log(`Summary: ${result.summaryPath}`);
  console.log(`CSV: ${result.rowsPath}`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(
      `Exhibition export error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
