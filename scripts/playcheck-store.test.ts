import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { readPlaycheckRunId } from '../src/playcheck.js';
import {
  appendPlaycheckRecord,
  readPlaycheckRecords,
} from '../server/playcheckStore.js';

test('Playcheck URL query accepts only a valid run ID', () => {
  assert.equal(
    readPlaycheckRunId('?playcheckRunId=pc-20260822-abcdef12'),
    'pc-20260822-abcdef12',
  );
  assert.equal(readPlaycheckRunId('?playcheckRunId=../escape'), null);
});

test('Playcheck store appends and reads records by run ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-playcheck-store-'));
  const runId = 'pc-20260822-abcdef12';
  try {
    await appendPlaycheckRecord(root, runId, {
      runId,
      event: 'input_received',
      at: '2026-08-22T00:00:00.000Z',
      origin: 'client',
    });
    await appendPlaycheckRecord(root, runId, {
      runId,
      event: 'turn_completed',
      at: '2026-08-22T00:00:01.000Z',
      origin: 'server',
    });

    const records = await readPlaycheckRecords(root, runId);
    assert.equal(records.length, 2);
    assert.equal(records[1].event, 'turn_completed');

    const raw = await readFile(join(root, 'raw', `${runId}.jsonl`), 'utf8');
    assert.equal(raw.trim().split('\n').length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Playcheck store rejects path-like run IDs', async () => {
  await assert.rejects(
    appendPlaycheckRecord('playcheck-results/local', '../escape', {
      runId: '../escape',
      event: 'input_received',
      at: '2026-08-22T00:00:00.000Z',
    }),
    /Invalid Playcheck run ID/,
  );
});
