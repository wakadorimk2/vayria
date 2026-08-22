import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  MAX_OWNER_NOTE_LENGTH,
  RUBRIC_AXES,
  SCENARIO_IDS,
  createRunTemplate,
  finalizeRun,
  isValidRunId,
  parseArgs,
  parseInteractiveScore,
  scoreRun,
  startRun,
  validateAssessment,
} from './playcheck.mjs';

const RUN_ID = 'pc-20260822-abcdef12';

function createEvents(runId) {
  return [
    {
      runId,
      event: 'input_received',
      at: '2026-08-22T00:00:00.000Z',
      origin: 'client',
      turnId: 'turn-1',
      source: 'manual',
    },
    {
      runId,
      event: 'turn_completed',
      at: '2026-08-22T00:00:01.000Z',
      origin: 'server',
      turnId: 'turn-1',
      source: 'manual',
    },
  ];
}

async function writeRawEvents(localRoot, runId, events = createEvents(runId)) {
  const rawRoot = join(localRoot, 'raw');
  await mkdir(rawRoot, { recursive: true });
  await writeFile(
    join(rawRoot, `${runId}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
}

function fillScores(template, score = 2) {
  return {
    ...template,
    scenarios: template.scenarios.map((scenario) => ({
      ...scenario,
      observedOutcome: 'observed',
      scores: Object.fromEntries(RUBRIC_AXES.map((axis) => [axis, score])),
      naReasons: {},
      notes: 'local note',
    })),
    finishedAt: '2026-08-22T00:01:00.000Z',
  };
}

function createAsk(answers) {
  const remaining = [...answers];
  return async () => {
    if (remaining.length === 0) throw new Error('Test input is exhausted.');
    return remaining.shift();
  };
}

function createOutput() {
  return {
    isTTY: false,
    write() {},
  };
}

test('run IDs use the safe Playcheck format', () => {
  assert.equal(isValidRunId(RUN_ID), true);
  assert.equal(isValidRunId('../escape'), false);
  assert.equal(isValidRunId('pc-_'), false);
});

test('score arguments and interactive score values are validated', () => {
  const options = parseArgs([
    'score',
    '--run-id',
    RUN_ID,
    '--case',
    'interruption',
  ]);
  assert.equal(options.command, 'score');
  assert.equal(options.runId, RUN_ID);
  assert.equal(options.caseId, 'interruption');
  assert.equal(parseInteractiveScore('0'), 0);
  assert.equal(parseInteractiveScore(' N/A '), 'N/A');
  assert.equal(parseInteractiveScore('na'), 'N/A');
  assert.throws(() => parseInteractiveScore('4'), /must be 0, 1, 2, 3, or N\/A/);
});

test('start accepts the CLI default and a copied Markdown URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-playcheck-start-'));
  try {
    const started = await startRun({
      baseUrl: '[http://127.0.0.1:5187/](http://127.0.0.1:5187/)',
      localRoot: join(root, 'local'),
      runId: null,
    });
    assert.equal(isValidRunId(started.runId), true);
    assert.equal(started.template.baseUrl, 'http://127.0.0.1:5187/');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('N/A requires a reason for the affected axis', () => {
  const template = createRunTemplate({ runId: RUN_ID });
  template.scenarios[0].scores.presence = 'N/A';
  assert.throws(
    () => validateAssessment(template, RUN_ID),
    /naReasons\.presence is required/,
  );
});

test('score saves one case and resumes at the next incomplete case', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-playcheck-score-'));
  const localRoot = join(root, 'local');
  try {
    await startRun({ localRoot, runId: RUN_ID });
    const first = await scoreRun({
      localRoot,
      runId: RUN_ID,
      caseId: 'idle_presence',
      ask: createAsk(['', '2', '2', '2', '2', '2', '待機は自然']),
      output: createOutput(),
    });
    assert.deepEqual(first.completedCaseIds, ['idle_presence']);

    const second = await scoreRun({
      localRoot,
      runId: RUN_ID,
      ask: createAsk(
        SCENARIO_IDS.slice(1).flatMap((id) => [
          '',
          '3',
          '2',
          '2',
          '3',
          '2',
          `${id}の観察結果`,
        ]),
      ),
      output: createOutput(),
    });
    assert.deepEqual(second.completedCaseIds, SCENARIO_IDS.slice(1));

    const saved = JSON.parse(
      await readFile(join(localRoot, 'work', `${RUN_ID}.json`), 'utf8'),
    );
    assert.equal(saved.scenarios[0].notes, '待機は自然');
    assert.equal(saved.scenarios[1].observedOutcome, 'observed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('interactive N/A scores require and save a reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-playcheck-na-'));
  const localRoot = join(root, 'local');
  try {
    await startRun({ localRoot, runId: RUN_ID });
    await scoreRun({
      localRoot,
      runId: RUN_ID,
      caseId: 'autonomous_turn',
      ask: createAsk([
        '',
        'N/A',
        'autonomous branch was not observed',
        '2',
        '2',
        '2',
        '2',
        'branch was not observed',
      ]),
      output: createOutput(),
    });

    const saved = JSON.parse(
      await readFile(join(localRoot, 'work', `${RUN_ID}.json`), 'utf8'),
    );
    assert.equal(
      saved.scenarios.find((scenario) => scenario.id === 'autonomous_turn')
        .naReasons.presence,
      'autonomous branch was not observed',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('owner notes are preserved in an anonymous result and bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-playcheck-notes-'));
  const localRoot = join(root, 'local');
  const resultsRoot = join(root, 'results');
  try {
    const started = await startRun({ localRoot, runId: RUN_ID });
    const assessment = fillScores(
      JSON.parse(await readFile(started.workPath, 'utf8')),
    );
    await writeFile(started.workPath, `${JSON.stringify(assessment)}\n`, 'utf8');
    await writeRawEvents(localRoot, RUN_ID);

    const result = await finalizeRun({ localRoot, resultsRoot, runId: RUN_ID });
    assert.equal(result.aggregate.scenarios[0].notes, 'local note');
    assert.equal(result.aggregate.scenarios[0].naReasons instanceof Object, true);

    assessment.scenarios[0].notes = 'x'.repeat(MAX_OWNER_NOTE_LENGTH + 1);
    await writeFile(started.workPath, `${JSON.stringify(assessment)}\n`, 'utf8');
    await assert.rejects(
      finalizeRun({
        localRoot,
        resultsRoot,
        runId: RUN_ID,
        force: true,
      }),
      /must be 500 characters or fewer/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('start and finalize create an anonymous result and cumulative summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-playcheck-'));
  const localRoot = join(root, 'local');
  const resultsRoot = join(root, 'results');
  try {
    const started = await startRun({
      baseUrl: 'http://127.0.0.1:5187/',
      localRoot,
      runId: RUN_ID,
    });
    assert.match(started.url, /playcheckRunId=pc-20260822-abcdef12/);

    const assessment = fillScores(
      JSON.parse(await readFile(started.workPath, 'utf8')),
    );
    await writeFile(started.workPath, `${JSON.stringify(assessment)}\n`, 'utf8');
    await writeRawEvents(localRoot, RUN_ID);

    const result = await finalizeRun({ localRoot, resultsRoot, runId: RUN_ID });
    assert.equal(result.aggregate.scores.status, 'pass');
    assert.equal(result.aggregate.scores.overallAverage, 2);
    assert.equal(result.aggregate.events.count, 2);
    assert.equal(result.aggregate.scenarios[0].notes, 'local note');

    const summary = JSON.parse(await readFile(result.summaryPath, 'utf8'));
    assert.equal(summary.runCount, 1);
    assert.equal(summary.passCount, 1);
    assert.equal(summary.latestRunId, RUN_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finalize rejects forbidden raw text fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-playcheck-forbidden-'));
  const localRoot = join(root, 'local');
  try {
    const started = await startRun({ localRoot, runId: RUN_ID });
    const assessment = fillScores(
      JSON.parse(await readFile(started.workPath, 'utf8')),
    );
    await writeFile(started.workPath, `${JSON.stringify(assessment)}\n`, 'utf8');
    await writeRawEvents(localRoot, RUN_ID, [
      { ...createEvents(RUN_ID)[0], text: 'response must not be recorded' },
    ]);

    await assert.rejects(
      finalizeRun({ localRoot, resultsRoot: join(root, 'results'), runId: RUN_ID }),
      /forbidden field: text/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a zero score produces fail while retaining a result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-playcheck-fail-'));
  const localRoot = join(root, 'local');
  const resultsRoot = join(root, 'results');
  try {
    const started = await startRun({ localRoot, runId: RUN_ID });
    const assessment = fillScores(
      JSON.parse(await readFile(started.workPath, 'utf8')),
    );
    assessment.scenarios[2].scores.timing = 0;
    await writeFile(started.workPath, `${JSON.stringify(assessment)}\n`, 'utf8');
    await writeRawEvents(localRoot, RUN_ID);

    const result = await finalizeRun({ localRoot, resultsRoot, runId: RUN_ID });
    assert.equal(result.aggregate.scores.status, 'fail');
    assert.equal(result.aggregate.scores.zeroObserved, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
