import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isPlaycheckRunId } from '../src/playcheck.js';

const MAX_RECORD_BYTES = 16 * 1024;

export interface PlaycheckRecord {
  runId: string;
  event: string;
  at: string;
  [key: string]: unknown;
}

function recordPath(root: string, runId: string): string {
  if (!isPlaycheckRunId(runId)) {
    throw new Error('Invalid Playcheck run ID.');
  }
  return join(resolve(root), 'raw', `${runId}.jsonl`);
}

export async function appendPlaycheckRecord(
  root: string,
  runId: string,
  record: PlaycheckRecord,
): Promise<void> {
  const path = recordPath(root, runId);
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('Playcheck event record is too large.');
  }
  await mkdir(resolve(root, 'raw'), { recursive: true });
  await appendFile(path, line, { encoding: 'utf8' });
}

export async function readPlaycheckRecords(
  root: string,
  runId: string,
): Promise<PlaycheckRecord[]> {
  const path = recordPath(root, runId);
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const records: PlaycheckRecord[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid Playcheck JSONL record at line ${index + 1}.`);
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).runId !== runId ||
      typeof (parsed as Record<string, unknown>).event !== 'string' ||
      typeof (parsed as Record<string, unknown>).at !== 'string'
    ) {
      throw new Error(`Invalid Playcheck record at line ${index + 1}.`);
    }
    records.push(parsed as PlaycheckRecord);
  }
  return records;
}
