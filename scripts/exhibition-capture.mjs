import { randomBytes } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  MAX_OWNER_NOTE_LENGTH,
  parseInteractiveScore,
  RUBRIC_AXES,
} from './playcheck.mjs';

export const DEFAULT_EXHIBITION_CAPTURE_ROOT = 'playcheck-results/local';
export const EXHIBITION_CAPTURE_ID_PATTERN = /^ex-\d{14}-[0-9a-f]{8}$/;
export const EXHIBITION_CAPTURE_SCHEMA_VERSION = 1;
export const MAX_EXHIBITION_RECORD_BYTES = 16 * 1024;

const FORBIDDEN_CAPTURE_FIELDS = new Set([
  'apiKey',
  'audio',
  'audioData',
  'content',
  'history',
  'message',
  'prompt',
  'reply',
  'secret',
  'text',
]);

export function isValidCaptureId(value) {
  return (
    typeof value === 'string' && EXHIBITION_CAPTURE_ID_PATTERN.test(value)
  );
}

export function createCaptureId(now = new Date(), random = randomBytes(4)) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const suffix = Buffer.from(random).toString('hex').slice(0, 8);
  const captureId = `ex-${stamp}-${suffix}`;
  if (!isValidCaptureId(captureId)) {
    throw new Error('Generated exhibition capture ID is invalid.');
  }
  return captureId;
}

export function resolveLocalRoot(environment = process.env) {
  return environment?.VAYRIA_PLAYCHECK_ROOT?.trim() ||
    DEFAULT_EXHIBITION_CAPTURE_ROOT;
}

export function getCapturePaths(localRoot, captureId) {
  if (!isValidCaptureId(captureId)) {
    throw new Error('Invalid exhibition capture ID.');
  }
  const directoryPath = join(resolve(localRoot), 'exhibition', captureId);
  const exportDirectoryPath = join(directoryPath, 'export');
  return {
    directoryPath,
    metadataPath: join(directoryPath, 'metadata.json'),
    eventsPath: join(directoryPath, 'events.jsonl'),
    observationsPath: join(directoryPath, 'observations.jsonl'),
    exportDirectoryPath,
    summaryPath: join(exportDirectoryPath, 'summary.json'),
    rowsPath: join(exportDirectoryPath, 'rows.csv'),
  };
}

export function parseScore(value, path = 'score') {
  return parseInteractiveScore(value, path);
}

export function normalizeNote(value, path = 'note') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${path} must not be empty.`);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_OWNER_NOTE_LENGTH) {
    throw new Error(
      `${path} must be ${MAX_OWNER_NOTE_LENGTH} characters or fewer.`,
    );
  }
  return normalized;
}

export function parseObservationCommand(line) {
  if (typeof line !== 'string') {
    throw new Error('Observation command must be a string.');
  }
  const trimmed = line.trim();
  if (!trimmed) return { command: 'empty' };
  if (trimmed === 'help' || trimmed === '?') return { command: 'help' };
  if (trimmed === 'exit' || trimmed === 'quit') return { command: 'exit' };

  const noteMatch = trimmed.match(/^note(?:\s+([\s\S]*))?$/i);
  if (noteMatch) {
    return {
      command: 'note',
      note: normalizeNote(noteMatch[1] ?? ''),
    };
  }

  const scoreMatch = trimmed.match(
    /^score\s+(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/i,
  );
  if (!scoreMatch) {
    throw new Error(
      'Use note <短文> or score <axis> <0|1|2|3|N/A> [reason].',
    );
  }

  const axis = scoreMatch[1];
  if (!RUBRIC_AXES.includes(axis)) {
    throw new Error(`Unknown rubric axis: ${axis}.`);
  }
  const score = parseScore(scoreMatch[2]);
  const rawReason = scoreMatch[3]?.trim() ?? '';
  if (rawReason.length > MAX_OWNER_NOTE_LENGTH) {
    throw new Error(
      `reason must be ${MAX_OWNER_NOTE_LENGTH} characters or fewer.`,
    );
  }
  if (score === 'N/A' && !rawReason) {
    throw new Error('N/A score requires a reason.');
  }

  return {
    command: 'score',
    axis,
    score,
    ...(rawReason ? { reason: rawReason } : {}),
  };
}

export function createObservationRecord(captureId, parsed, at = new Date().toISOString()) {
  if (!isValidCaptureId(captureId)) {
    throw new Error('Invalid exhibition capture ID.');
  }
  if (parsed?.command === 'note') {
    return {
      schemaVersion: EXHIBITION_CAPTURE_SCHEMA_VERSION,
      captureId,
      at,
      type: 'note',
      note: normalizeNote(parsed.note),
    };
  }
  if (parsed?.command === 'score') {
    if (!RUBRIC_AXES.includes(parsed.axis)) {
      throw new Error(`Unknown rubric axis: ${parsed.axis}.`);
    }
    const score = parseScore(parsed.score);
    const reason = parsed.reason?.trim() ?? '';
    if (reason.length > MAX_OWNER_NOTE_LENGTH) {
      throw new Error(
        `reason must be ${MAX_OWNER_NOTE_LENGTH} characters or fewer.`,
      );
    }
    if (score === 'N/A' && !reason) {
      throw new Error('N/A score requires a reason.');
    }
    return {
      schemaVersion: EXHIBITION_CAPTURE_SCHEMA_VERSION,
      captureId,
      at,
      type: 'score',
      axis: parsed.axis,
      score,
      ...(reason ? { reason } : {}),
    };
  }
  throw new Error('Only note and score commands create observations.');
}

function recordLine(record) {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_CAPTURE_FIELDS.has(key)) {
      throw new Error(`Exhibition capture record contains a forbidden field: ${key}.`);
    }
  }
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_EXHIBITION_RECORD_BYTES) {
    throw new Error('Exhibition capture record is too large.');
  }
  return line;
}

export async function readCaptureMetadata(localRoot, captureId) {
  const paths = getCapturePaths(localRoot, captureId);
  const value = JSON.parse(await readFile(paths.metadataPath, 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.captureId !== captureId ||
    value.mode !== 'exhibition' ||
    (value.status !== 'active' && value.status !== 'completed')
  ) {
    throw new Error('Invalid exhibition capture metadata.');
  }
  return value;
}

async function readJsonl(path, validate, label) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid ${label} JSONL record at line ${index + 1}.`);
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !validate(parsed)
    ) {
      throw new Error(`Invalid ${label} record at line ${index + 1}.`);
    }
    records.push(parsed);
  }
  return records;
}

export async function readCaptureEvents(localRoot, captureId) {
  const paths = getCapturePaths(localRoot, captureId);
  return readJsonl(
    paths.eventsPath,
    (value) =>
      value.captureId === captureId &&
      typeof value.event === 'string' &&
      typeof value.at === 'string',
    'exhibition event',
  );
}

export async function readCaptureObservations(localRoot, captureId) {
  const paths = getCapturePaths(localRoot, captureId);
  return readJsonl(
    paths.observationsPath,
    (value) =>
      value.captureId === captureId &&
      typeof value.at === 'string' &&
      (value.type === 'note' || value.type === 'score'),
    'exhibition observation',
  );
}

export async function readCaptureData(localRoot, captureId) {
  const [metadata, events, observations] = await Promise.all([
    readCaptureMetadata(localRoot, captureId),
    readCaptureEvents(localRoot, captureId),
    readCaptureObservations(localRoot, captureId),
  ]);
  return { metadata, events, observations };
}

export async function appendObservationRecord(
  localRoot,
  captureId,
  parsed,
  at = new Date().toISOString(),
) {
  const paths = getCapturePaths(localRoot, captureId);
  await readCaptureMetadata(localRoot, captureId);
  const record = createObservationRecord(captureId, parsed, at);
  await mkdir(paths.directoryPath, { recursive: true });
  await appendFile(paths.observationsPath, recordLine(record), {
    encoding: 'utf8',
  });
  return record;
}

export async function findLatestCapture(localRoot) {
  const exhibitionRoot = resolve(localRoot, 'exhibition');
  let entries;
  try {
    entries = await readdir(exhibitionRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidCaptureId(entry.name)) continue;
    try {
      const metadata = await readCaptureMetadata(localRoot, entry.name);
      candidates.push({ captureId: entry.name, metadata });
    } catch {
      // Ignore incomplete directory entries and keep searching for a valid capture.
    }
  }
  candidates.sort((left, right) =>
    String(left.metadata.startedAt).localeCompare(String(right.metadata.startedAt)),
  );
  return candidates.at(-1) ?? null;
}

export async function resolveCaptureSelection({
  localRoot,
  captureId = null,
  latest = false,
}) {
  if (captureId && latest) {
    throw new Error('Use either --capture-id or --latest, not both.');
  }
  if (captureId) {
    if (!isValidCaptureId(captureId)) {
      throw new Error('Invalid exhibition capture ID.');
    }
    const metadata = await readCaptureMetadata(localRoot, captureId);
    return { captureId, metadata, paths: getCapturePaths(localRoot, captureId) };
  }
  if (!latest) {
    throw new Error('Specify --capture-id <captureId> or --latest.');
  }
  const selected = await findLatestCapture(localRoot);
  if (!selected) {
    throw new Error('No exhibition capture was found.');
  }
  return {
    ...selected,
    paths: getCapturePaths(localRoot, selected.captureId),
  };
}

export async function initializeCaptureForTest(
  localRoot,
  {
    captureId = createCaptureId(),
    startedAt = new Date().toISOString(),
    status = 'active',
    finishedAt = null,
  } = {},
) {
  if (!isValidCaptureId(captureId)) {
    throw new Error('Invalid exhibition capture ID.');
  }
  const paths = getCapturePaths(localRoot, captureId);
  await mkdir(paths.directoryPath, { recursive: true });
  await writeFile(
    paths.metadataPath,
    `${JSON.stringify({
      schemaVersion: EXHIBITION_CAPTURE_SCHEMA_VERSION,
      captureId,
      mode: 'exhibition',
      startedAt,
      finishedAt,
      status,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(paths.eventsPath, '', 'utf8');
  await writeFile(paths.observationsPath, '', 'utf8');
  return { captureId, paths };
}
