import { randomBytes } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

export type ExhibitionCaptureStatus = 'active' | 'completed';

export interface ExhibitionCaptureMetadata {
  schemaVersion: number;
  captureId: string;
  mode: 'exhibition';
  startedAt: string;
  finishedAt: string | null;
  status: ExhibitionCaptureStatus;
}

export interface ExhibitionCapturePaths {
  directoryPath: string;
  metadataPath: string;
  eventsPath: string;
  observationsPath: string;
  exportDirectoryPath: string;
  summaryPath: string;
  rowsPath: string;
}

export interface ExhibitionEventRecord {
  captureId: string;
  event: string;
  at: string;
  [key: string]: unknown;
}

export interface ExhibitionObservationRecord {
  captureId: string;
  at: string;
  type: 'note' | 'score';
  [key: string]: unknown;
}

export interface ExhibitionCaptureWriter {
  readonly captureId: string;
  readonly paths: ExhibitionCapturePaths;
  readonly ready: Promise<void>;
  appendEvent(record: ExhibitionEventRecord): Promise<void>;
  finish(finishedAt?: string): Promise<void>;
}

export function isExhibitionCaptureId(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' && EXHIBITION_CAPTURE_ID_PATTERN.test(value)
  );
}

export function createExhibitionCaptureId(
  now = new Date(),
  random: Uint8Array = randomBytes(4),
): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const suffix = Buffer.from(random).toString('hex').slice(0, 8);
  const captureId = `ex-${stamp}-${suffix}`;
  if (!isExhibitionCaptureId(captureId)) {
    throw new Error('Generated exhibition capture ID is invalid.');
  }
  return captureId;
}

export function getExhibitionCapturePaths(
  root: string,
  captureId: string,
): ExhibitionCapturePaths {
  if (!isExhibitionCaptureId(captureId)) {
    throw new Error('Invalid exhibition capture ID.');
  }

  const directoryPath = join(resolve(root), 'exhibition', captureId);
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

function assertSafeRecord(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_CAPTURE_FIELDS.has(key)) {
      throw new Error(`Exhibition capture record contains a forbidden field: ${key}.`);
    }
  }
}

function recordLine(record: Record<string, unknown>): string {
  assertSafeRecord(record);
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_EXHIBITION_RECORD_BYTES) {
    throw new Error('Exhibition capture record is too large.');
  }
  return line;
}

function assertEventRecord(
  captureId: string,
  record: ExhibitionEventRecord,
): void {
  if (
    record.captureId !== captureId ||
    typeof record.event !== 'string' ||
    typeof record.at !== 'string'
  ) {
    throw new Error('Invalid exhibition event record.');
  }
  recordLine(record);
}

function assertObservationRecord(
  captureId: string,
  record: ExhibitionObservationRecord,
): void {
  if (
    record.captureId !== captureId ||
    typeof record.at !== 'string' ||
    (record.type !== 'note' && record.type !== 'score')
  ) {
    throw new Error('Invalid exhibition observation record.');
  }
  recordLine(record);
}

async function initializeCapture(
  paths: ExhibitionCapturePaths,
  metadata: ExhibitionCaptureMetadata,
): Promise<void> {
  await mkdir(paths.directoryPath, { recursive: true });
  await writeFile(
    paths.metadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  await appendFile(paths.eventsPath, '', { encoding: 'utf8' });
  await appendFile(paths.observationsPath, '', { encoding: 'utf8' });
}

class FileExhibitionCaptureWriter implements ExhibitionCaptureWriter {
  readonly captureId: string;
  readonly paths: ExhibitionCapturePaths;
  readonly ready: Promise<void>;

  private readonly metadata: ExhibitionCaptureMetadata;
  private queue: Promise<void>;
  private finished = false;

  constructor(
    root: string,
    captureId: string,
    startedAt: string,
  ) {
    this.captureId = captureId;
    this.paths = getExhibitionCapturePaths(root, captureId);
    this.metadata = {
      schemaVersion: EXHIBITION_CAPTURE_SCHEMA_VERSION,
      captureId,
      mode: 'exhibition',
      startedAt,
      finishedAt: null,
      status: 'active',
    };
    this.ready = initializeCapture(this.paths, this.metadata);
    this.queue = this.ready.catch(() => undefined);
  }

  async appendEvent(record: ExhibitionEventRecord): Promise<void> {
    assertEventRecord(this.captureId, record);
    const line = recordLine(record);
    await this.enqueue(async () => {
      if (this.finished) {
        throw new Error('Exhibition capture is already finished.');
      }
      await appendFile(this.paths.eventsPath, line, { encoding: 'utf8' });
    });
  }

  finish(finishedAt = new Date().toISOString()): Promise<void> {
    return this.enqueue(async () => {
      if (this.finished) return;
      this.finished = true;
      this.metadata.finishedAt = finishedAt;
      this.metadata.status = 'completed';
      await writeFile(
        this.paths.metadataPath,
        `${JSON.stringify(this.metadata, null, 2)}\n`,
        'utf8',
      );
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      await this.ready;
      await operation();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export function createExhibitionCapture(
  root = DEFAULT_EXHIBITION_CAPTURE_ROOT,
  {
    now = new Date(),
    random = randomBytes(4),
  }: { now?: Date; random?: Uint8Array } = {},
): ExhibitionCaptureWriter {
  const captureId = createExhibitionCaptureId(now, random);
  return new FileExhibitionCaptureWriter(
    root,
    captureId,
    now.toISOString(),
  );
}

async function readJsonl<T extends Record<string, unknown>>(
  path: string,
  validate: (value: Record<string, unknown>) => value is T,
  label: string,
): Promise<T[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const records: T[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid ${label} JSONL record at line ${index + 1}.`);
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !validate(parsed as Record<string, unknown>)
    ) {
      throw new Error(`Invalid ${label} record at line ${index + 1}.`);
    }
    records.push(parsed as T);
  }
  return records;
}

export async function readExhibitionCaptureMetadata(
  root: string,
  captureId: string,
): Promise<ExhibitionCaptureMetadata> {
  const paths = getExhibitionCapturePaths(root, captureId);
  const value = JSON.parse(await readFile(paths.metadataPath, 'utf8')) as unknown;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).captureId !== captureId ||
    (value as Record<string, unknown>).mode !== 'exhibition' ||
    (value as Record<string, unknown>).status !== 'active' &&
      (value as Record<string, unknown>).status !== 'completed'
  ) {
    throw new Error('Invalid exhibition capture metadata.');
  }
  return value as ExhibitionCaptureMetadata;
}

export async function readExhibitionEvents(
  root: string,
  captureId: string,
): Promise<ExhibitionEventRecord[]> {
  const paths = getExhibitionCapturePaths(root, captureId);
  return readJsonl(
    paths.eventsPath,
    (value): value is ExhibitionEventRecord =>
      value.captureId === captureId &&
      typeof value.event === 'string' &&
      typeof value.at === 'string',
    'exhibition event',
  );
}

export async function readExhibitionObservations(
  root: string,
  captureId: string,
): Promise<ExhibitionObservationRecord[]> {
  const paths = getExhibitionCapturePaths(root, captureId);
  return readJsonl(
    paths.observationsPath,
    (value): value is ExhibitionObservationRecord =>
      value.captureId === captureId &&
      typeof value.at === 'string' &&
      (value.type === 'note' || value.type === 'score'),
    'exhibition observation',
  );
}

export async function appendExhibitionObservation(
  root: string,
  captureId: string,
  record: ExhibitionObservationRecord,
): Promise<void> {
  assertObservationRecord(captureId, record);
  const paths = getExhibitionCapturePaths(root, captureId);
  await mkdir(paths.directoryPath, { recursive: true });
  await appendFile(paths.observationsPath, recordLine(record), {
    encoding: 'utf8',
  });
}
