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
import {
  appendExhibitionObservation,
  createExhibitionCapture,
  getExhibitionCapturePaths,
  isExhibitionCaptureId,
  readExhibitionCaptureMetadata,
  readExhibitionEvents,
  readExhibitionObservations,
} from '../server/exhibitionCaptureStore.js';

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

test('exhibition capture IDs and paths reject traversal', () => {
  assert.equal(
    isExhibitionCaptureId('ex-20260822000000-abcdef12'),
    true,
  );
  assert.equal(isExhibitionCaptureId('../escape'), false);
  assert.throws(
    () => getExhibitionCapturePaths('playcheck-results/local', '../escape'),
    /Invalid exhibition capture ID/,
  );
});

test('exhibition capture writes lifecycle files and safe runtime records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-exhibition-store-'));
  const startedAt = new Date('2026-08-22T00:00:00.000Z');
  try {
    const capture = createExhibitionCapture(root, {
      now: startedAt,
      random: Buffer.from('abcdef12', 'hex'),
    });
    await capture.ready;
    assert.match(capture.captureId, /^ex-20260822000000-abcdef12$/);

    await capture.appendEvent({
      captureId: capture.captureId,
      event: 'llm_done',
      at: startedAt.toISOString(),
      origin: 'server',
      turnId: 'turn-1',
      durationMs: 42,
    });
    await appendExhibitionObservation(root, capture.captureId, {
      captureId: capture.captureId,
      at: '2026-08-22T00:00:01.000Z',
      type: 'note',
      note: '待機から返答までを観察した',
    });

    const active = await readExhibitionCaptureMetadata(root, capture.captureId);
    assert.equal(active.status, 'active');
    assert.equal((await readExhibitionEvents(root, capture.captureId)).length, 1);
    assert.equal(
      (await readExhibitionObservations(root, capture.captureId)).length,
      1,
    );

    await assert.rejects(
      capture.appendEvent({
        captureId: capture.captureId,
        event: 'llm_done',
        at: startedAt.toISOString(),
        message: '発話本文を保存してはいけない',
      }),
      /forbidden field: message/,
    );

    await capture.finish('2026-08-22T00:01:00.000Z');
    const completed = await readExhibitionCaptureMetadata(
      root,
      capture.captureId,
    );
    assert.equal(completed.status, 'completed');
    assert.equal(completed.finishedAt, '2026-08-22T00:01:00.000Z');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
