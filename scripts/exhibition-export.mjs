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
