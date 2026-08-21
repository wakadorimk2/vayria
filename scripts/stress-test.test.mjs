import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createSeededRandom,
  createTurnPlan,
  DEFAULT_OPTIONS,
  evaluateReport,
  parseArgs,
  summarizeDurations,
} from './stress-test.mjs';

const scriptPath = fileURLToPath(new URL('./stress-test.mjs', import.meta.url));
const workspacePath = resolve(dirname(scriptPath), '..');

function readRequestBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function startStubServer({ delayMs = 0 } = {}) {
  const stats = {
    active: 0,
    maxActive: 0,
    chatRequests: 0,
    ttsRequests: 0,
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }

    const body = JSON.parse(await readRequestBody(request));
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));

    try {
      if (request.url === '/api/chat') {
        stats.chatRequests += 1;
        const activatedCard = body.forcedCardId ?? body.brainCardIds[0];
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            text: 'テスト応答',
            emotion: 'joy',
            activatedCards: [activatedCard],
          }),
        );
        return;
      }

      if (request.url === '/api/tts') {
        stats.ttsRequests += 1;
        response.writeHead(200, { 'Content-Type': 'audio/wav' });
        response.end(Buffer.from('RIFF-test-audio'));
        return;
      }

      response.writeHead(404).end();
    } finally {
      stats.active -= 1;
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    throw new Error('Stub server did not expose a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stats,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

function runCli(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: workspacePath,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

test('seeded input generation is repeatable and creates valid forced cards', () => {
  const first = createTurnPlan({
    random: createSeededRandom('repeatable-seed'),
    runId: 'run',
    userId: 'user-1',
    round: 1,
    history: [],
  });
  const second = createTurnPlan({
    random: createSeededRandom('repeatable-seed'),
    runId: 'run',
    userId: 'user-1',
    round: 1,
    history: [],
  });

  assert.deepEqual(first, second);
  assert.equal(first.brainCardIds.length, 5);
  assert.equal(new Set(first.brainCardIds).size, 5);
  assert.ok(
    first.forcedCardId === null || first.brainCardIds.includes(first.forcedCardId),
  );
});

test('argument parsing keeps exhibition defaults and accepts SLO limits', () => {
  const options = parseArgs([
    '--users',
    '3',
    '--rounds=2',
    '--gap-ms',
    '25',
    '--max-p95-chat-ms',
    '1000',
    '--out',
    'reports/run.json',
  ]);

  assert.equal(options.users, 3);
  assert.equal(options.rounds, 2);
  assert.equal(options.gapMs, 25);
  assert.equal(options.maxP95ChatMs, 1000);
  assert.equal(options.maxP95TtsMs, DEFAULT_OPTIONS.maxP95TtsMs);
  assert.ok(options.outputPath.endsWith('reports\\run.json') || options.outputPath.endsWith('reports/run.json'));
});

test('duration summary calculates p50 and p95', () => {
  assert.deepEqual(summarizeDurations([5, 10, 20, 40]), {
    count: 4,
    minMs: 5,
    p50Ms: 10,
    p95Ms: 40,
    maxMs: 40,
  });
});

test('evaluation applies invariants and optional p95 limits', () => {
  const report = {
    interrupted: false,
    counts: { failed: 0, unfinished: 0, aborted: 0 },
    concurrency: { activeTurnsAtEnd: 0, inFlightRequestsAtEnd: 0 },
    options: {
      maxP95ChatMs: 20,
      maxP95TtsMs: null,
      maxP95TurnMs: null,
    },
    latencies: {
      chat: { p95Ms: 10 },
      tts: { p95Ms: 30 },
      turn: { p95Ms: 40 },
    },
  };

  assert.deepEqual(evaluateReport(report), { passed: true, failures: [] });
  report.options.maxP95ChatMs = 5;
  assert.equal(evaluateReport(report).passed, false);
});

test('CLI sends overlapping chat and TTS requests and writes a report', async () => {
  const server = await startStubServer({ delayMs: 20 });
  const outputDirectory = await mkdtemp(join(tmpdir(), 'wildcard-stress-'));
  const outputPath = join(outputDirectory, 'report.json');

  try {
    const result = await runCli([
      '--base-url',
      server.baseUrl,
      '--users',
      '2',
      '--rounds',
      '2',
      '--gap-ms',
      '0',
      '--timeout-ms',
      '1000',
      '--out',
      outputPath,
    ]);
    const report = JSON.parse(await readFile(outputPath, 'utf8'));

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(server.stats.chatRequests, 4);
    assert.equal(server.stats.ttsRequests, 4);
    assert.ok(server.stats.maxActive >= 2);
    assert.equal(report.counts.scheduled, 4);
    assert.equal(report.counts.completed, 4);
    assert.ok(report.concurrency.maxActiveTurns >= 2);
    assert.ok(report.concurrency.maxInFlightRequests >= 2);
  } finally {
    await server.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('CLI reports a timeout as a failed turn', async () => {
  const server = await startStubServer({ delayMs: 100 });
  const outputDirectory = await mkdtemp(join(tmpdir(), 'wildcard-stress-timeout-'));
  const outputPath = join(outputDirectory, 'report.json');

  try {
    const result = await runCli([
      '--base-url',
      server.baseUrl,
      '--users',
      '1',
      '--rounds',
      '1',
      '--gap-ms',
      '0',
      '--timeout-ms',
      '10',
      '--out',
      outputPath,
    ]);
    const report = JSON.parse(await readFile(outputPath, 'utf8'));

    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(report.counts.failed, 1);
    assert.equal(report.errors[0].kind, 'timeout');
  } finally {
    await server.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
