import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export const EVENT_NAMES = Object.freeze([
  'input_received',
  'llm_start',
  'llm_done',
  'tts_start',
  'tts_ready',
  'animation_start',
  'turn_completed',
  'turn_aborted',
  'turn_failed',
]);

export const CARD_IDS = Object.freeze([
  'chicken',
  'suspicious',
  'gigantic',
  'tiny',
  'sleepy',
  'curious',
  'hungry',
  'rain',
  'secret',
  'panic',
  'sparkle',
  'underwater',
  'lonely',
  'confident',
  'strange',
  'deja-vu',
  'distant-thunder',
  'upside-down',
]);

const BRAIN_CARD_SETS = Object.freeze([
  Object.freeze(['chicken', 'suspicious', 'sleepy', 'rain', 'gigantic']),
  Object.freeze(['tiny', 'curious', 'secret', 'panic', 'sparkle']),
  Object.freeze(['underwater', 'lonely', 'confident', 'strange', 'deja-vu']),
  Object.freeze([
    'distant-thunder',
    'upside-down',
    'chicken',
    'curious',
    'rain',
  ]),
]);

const MESSAGE_FIXTURES = Object.freeze([
  Object.freeze({ key: 'suspicious', text: '展示の反応を少し疑って短く話して。' }),
  Object.freeze({ key: 'gigantic', text: '巨大なものについて短く話して。' }),
  Object.freeze({ key: 'tiny', text: '小さい変化を一つ見つけて。' }),
  Object.freeze({ key: 'joy', text: '少し嬉しい気分で展示を紹介して。' }),
  Object.freeze({ key: 'angry', text: '少し怒った調子で短く返して。' }),
  Object.freeze({ key: 'rain', text: '雨の日の展示について短く話して。' }),
  Object.freeze({ key: 'secret', text: '秘密を一つ隠すように返して。' }),
  Object.freeze({ key: 'normal', text: '展示の感想を短く返して。' }),
]);

export const DEFAULT_OPTIONS = Object.freeze({
  baseUrl: 'http://127.0.0.1:5187',
  users: 5,
  rounds: 4,
  gapMs: 150,
  seed: 'exhibition-burst-v1',
  timeoutMs: 30_000,
  maxP95ChatMs: null,
  maxP95TtsMs: null,
  maxP95TurnMs: null,
});

const MAX_HISTORY_ITEMS = 6;
const MAX_TEXT_LENGTH = 1_000;
const MAX_ACTIVATED_CARDS = 3;
const EMOTIONS = Object.freeze([
  'neutral',
  'fun',
  'joy',
  'sorrow',
  'angry',
  'surprised',
]);
const DEFAULT_OUTPUT_DIRECTORY = 'stress-results';

export class StressTestError extends Error {
  constructor(message, { kind = 'error', phase = null, statusCode = null } = {}) {
    super(message);
    this.name = 'StressTestError';
    this.kind = kind;
    this.phase = phase;
    this.statusCode = statusCode;
  }
}

function hashSeed(seed) {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function createSeededRandom(seed) {
  if (typeof seed !== 'string' || !seed) {
    throw new Error('seed must be a non-empty string.');
  }

  let state = hashSeed(seed) || 1;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function readInteger(value, optionName, { min = 0 } = {}) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} must be an integer of ${min} or more.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) {
    throw new Error(`${optionName} must be an integer of ${min} or more.`);
  }
  return number;
}

function readOptionalInteger(value, optionName) {
  if (value === null || value === undefined) return null;
  return readInteger(value, optionName, { min: 1 });
}

function readOptionValue(argv, index, optionName) {
  const argument = argv[index];
  if (argument.includes('=')) return [argument.slice(argument.indexOf('=') + 1), index];
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return [next, index + 1];
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--base-url must be a valid HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--base-url must use HTTP or HTTPS.');
  }
  return url.toString().replace(/\/$/, '');
}

export function parseArgs(argv) {
  const values = { ...DEFAULT_OPTIONS };
  let outputPath = null;
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      showHelp = true;
      continue;
    }

    const optionDefinitions = [
      ['--base-url', 'baseUrl', (value) => normalizeBaseUrl(value)],
      ['--users', 'users', (value) => readInteger(value, '--users', { min: 1 })],
      ['--rounds', 'rounds', (value) => readInteger(value, '--rounds', { min: 1 })],
      ['--gap-ms', 'gapMs', (value) => readInteger(value, '--gap-ms')],
      ['--seed', 'seed', (value) => {
        if (!value) throw new Error('--seed must be a non-empty string.');
        return value;
      }],
      ['--timeout-ms', 'timeoutMs', (value) => readInteger(value, '--timeout-ms', { min: 1 })],
      ['--max-p95-chat-ms', 'maxP95ChatMs', (value) => readOptionalInteger(value, '--max-p95-chat-ms')],
      ['--max-p95-tts-ms', 'maxP95TtsMs', (value) => readOptionalInteger(value, '--max-p95-tts-ms')],
      ['--max-p95-turn-ms', 'maxP95TurnMs', (value) => readOptionalInteger(value, '--max-p95-turn-ms')],
    ];

    const definition = optionDefinitions.find(([name]) =>
      argument === name || argument.startsWith(`${name}=`),
    );
    if (definition) {
      const [name, property, normalize] = definition;
      const [rawValue, nextIndex] = readOptionValue(argv, index, name);
      values[property] = normalize(rawValue);
      index = nextIndex;
      continue;
    }

    if (argument === '--out' || argument.startsWith('--out=')) {
      const [rawValue, nextIndex] = readOptionValue(argv, index, '--out');
      if (!rawValue) throw new Error('--out must be a non-empty path.');
      outputPath = resolve(rawValue);
      index = nextIndex;
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  return { ...values, outputPath, showHelp };
}

export function createTurnPlan({ random, runId, userId, round, history }) {
  const brainCardIds = [...BRAIN_CARD_SETS[Math.floor(random() * BRAIN_CARD_SETS.length)]];
  const forcedCardId = random() < 0.75
    ? brainCardIds[Math.floor(random() * brainCardIds.length)]
    : null;
  const message = MESSAGE_FIXTURES[Math.floor(random() * MESSAGE_FIXTURES.length)];

  return {
    runId,
    userId,
    turnId: `${runId}-${userId}-${round}`,
    round,
    source: 'manual',
    messageKey: message.key,
    message: message.text,
    history: [...history].slice(-MAX_HISTORY_ITEMS),
    brainCardIds,
    forcedCardId,
  };
}

function assertCardContext(plan) {
  if (
    !Array.isArray(plan.brainCardIds) ||
    plan.brainCardIds.length !== 5 ||
    new Set(plan.brainCardIds).size !== 5 ||
    plan.brainCardIds.some((id) => !CARD_IDS.includes(id))
  ) {
    throw new StressTestError('Generated brain card context is invalid.', {
      kind: 'generator',
      phase: 'input',
    });
  }
  if (plan.forcedCardId !== null && !plan.brainCardIds.includes(plan.forcedCardId)) {
    throw new StressTestError('Generated forced card is not in the brain cards.', {
      kind: 'generator',
      phase: 'input',
    });
  }
}

function createTurnState(plan) {
  return {
    ...plan,
    events: [],
    status: 'scheduled',
    phase: null,
    error: null,
    chatDurationMs: null,
    ttsDurationMs: null,
    turnDurationMs: null,
    emotion: null,
    responseText: null,
    startedAt: null,
    endedAt: null,
    startedAtMs: null,
  };
}

function recordEvent(turn, event, details = {}) {
  const now = performance.now();
  const eventRecord = {
    event,
    at: new Date().toISOString(),
    elapsedMs: turn.startedAtMs === null ? 0 : Math.round(now - turn.startedAtMs),
    ...details,
  };
  turn.events.push(eventRecord);
  return eventRecord;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

async function readResponseBytes(response) {
  return new Uint8Array(await response.arrayBuffer());
}

async function requestBytes({ state, turn, phase, path, body }) {
  state.inFlightRequests += 1;
  state.maxInFlightRequests = Math.max(
    state.maxInFlightRequests,
    state.inFlightRequests,
  );

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, state.options.timeoutMs);
  const handleShutdown = () => controller.abort();
  state.shutdownSignal.addEventListener('abort', handleShutdown, { once: true });

  try {
    const response = await fetch(new URL(path, `${state.options.baseUrl}/`).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Performer-Turn-Id': turn.turnId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const bytes = await readResponseBytes(response);
    state.httpStatuses[`${phase}:${response.status}`] =
      (state.httpStatuses[`${phase}:${response.status}`] ?? 0) + 1;
    return { response, bytes };
  } catch (error) {
    if (state.shutdownSignal.aborted) {
      throw new StressTestError('Stress test was interrupted.', {
        kind: 'aborted',
        phase,
      });
    }
    if (timedOut || isAbortError(error)) {
      throw new StressTestError(`${phase} request timed out.`, {
        kind: 'timeout',
        phase,
      });
    }
    throw new StressTestError(
      error instanceof Error ? error.message : `${phase} request failed.`,
      { kind: 'network', phase },
    );
  } finally {
    clearTimeout(timeoutId);
    state.shutdownSignal.removeEventListener('abort', handleShutdown);
    state.inFlightRequests -= 1;
  }
}

function decodeJson(bytes, phase) {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new StressTestError(`${phase} response was not valid JSON.`, {
      kind: 'response',
      phase,
    });
  }
}

function assertChatResponse(payload, turn) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new StressTestError('Chat response must be an object.', {
      kind: 'response',
      phase: 'chat',
    });
  }
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new StressTestError('Chat response text is empty or invalid.', {
      kind: 'response',
      phase: 'chat',
    });
  }
  if (
    typeof payload.emotion !== 'string' ||
    !EMOTIONS.includes(payload.emotion)
  ) {
    throw new StressTestError('Chat response emotion is invalid.', {
      kind: 'response',
      phase: 'chat',
    });
  }
  if (
    !Array.isArray(payload.activatedCards) ||
    payload.activatedCards.length < 1 ||
    payload.activatedCards.length > MAX_ACTIVATED_CARDS ||
    new Set(payload.activatedCards).size !== payload.activatedCards.length
  ) {
    throw new StressTestError('Chat response activatedCards is invalid.', {
      kind: 'response',
      phase: 'chat',
    });
  }
  if (
    payload.activatedCards.some(
      (id) => typeof id !== 'string' || !turn.brainCardIds.includes(id),
    )
  ) {
    throw new StressTestError('Chat response activated an unknown card.', {
      kind: 'response',
      phase: 'chat',
    });
  }
  if (turn.forcedCardId && !payload.activatedCards.includes(turn.forcedCardId)) {
    throw new StressTestError('Chat response omitted the forced card.', {
      kind: 'response',
      phase: 'chat',
    });
  }
}

function assertTtsResponse(response, bytes) {
  if (!response.ok) {
    throw new StressTestError(`TTS returned HTTP ${response.status}.`, {
      kind: 'http',
      phase: 'tts',
      statusCode: response.status,
    });
  }
  if (bytes.byteLength === 0) {
    throw new StressTestError('TTS response was empty.', {
      kind: 'response',
      phase: 'tts',
    });
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('audio/')) {
    throw new StressTestError('TTS response did not contain audio.', {
      kind: 'response',
      phase: 'tts',
    });
  }
}

function responseError(response, phase) {
  return new StressTestError(`${phase} returned HTTP ${response.status}.`, {
    kind: 'http',
    phase,
    statusCode: response.status,
  });
}

async function runTurn({ state, plan }) {
  assertCardContext(plan);
  const turn = createTurnState(plan);
  turn.status = 'running';
  turn.startedAt = new Date().toISOString();
  turn.startedAtMs = performance.now();
  state.turns.push(turn);
  state.activeTurns += 1;
  state.maxActiveTurns = Math.max(state.maxActiveTurns, state.activeTurns);
  recordEvent(turn, 'input_received');

  try {
    turn.phase = 'chat';
    recordEvent(turn, 'llm_start');
    const chatStartedAt = performance.now();
    const chatResult = await requestBytes({
      state,
      turn,
      phase: 'chat',
      path: '/api/chat',
      body: {
        mode: 'manual',
        message: turn.message,
        history: turn.history,
        brainCardIds: turn.brainCardIds,
        forcedCardId: turn.forcedCardId,
      },
    });
    turn.chatDurationMs = Math.round(performance.now() - chatStartedAt);
    if (!chatResult.response.ok) throw responseError(chatResult.response, 'Chat');
    const chatPayload = decodeJson(chatResult.bytes, 'Chat');
    assertChatResponse(chatPayload, turn);
    turn.responseText = chatPayload.text.trim();
    turn.emotion = chatPayload.emotion;
    recordEvent(turn, 'llm_done', {
      durationMs: turn.chatDurationMs,
      emotion: turn.emotion,
    });

    turn.phase = 'tts';
    recordEvent(turn, 'tts_start');
    const ttsStartedAt = performance.now();
    const ttsResult = await requestBytes({
      state,
      turn,
      phase: 'tts',
      path: '/api/tts',
      body: {
        text: turn.responseText,
        emotion: turn.emotion,
      },
    });
    turn.ttsDurationMs = Math.round(performance.now() - ttsStartedAt);
    assertTtsResponse(ttsResult.response, ttsResult.bytes);
    recordEvent(turn, 'tts_ready', {
      durationMs: turn.ttsDurationMs,
      audioBytes: ttsResult.bytes.byteLength,
    });

    turn.status = 'completed';
    turn.phase = null;
    turn.turnDurationMs = Math.round(performance.now() - turn.startedAtMs);
    recordEvent(turn, 'turn_completed', { durationMs: turn.turnDurationMs });
    return { turn, responseText: turn.responseText };
  } catch (error) {
    const stressError = error instanceof StressTestError
      ? error
      : new StressTestError(
          error instanceof Error ? error.message : 'Turn failed.',
          { kind: 'error', phase: turn.phase },
        );
    turn.error = {
      kind: stressError.kind,
      phase: stressError.phase,
      statusCode: stressError.statusCode,
      message: stressError.message,
    };
    turn.status = stressError.kind === 'aborted' ? 'aborted' : 'failed';
    turn.turnDurationMs = Math.round(performance.now() - turn.startedAtMs);
    recordEvent(
      turn,
      turn.status === 'aborted' ? 'turn_aborted' : 'turn_failed',
      {
        durationMs: turn.turnDurationMs,
        reason: stressError.kind,
        phase: stressError.phase,
      },
    );
    return { turn, responseText: null };
  } finally {
    turn.endedAt = new Date().toISOString();
    state.activeTurns -= 1;
  }
}

function delay(ms, signal) {
  return new Promise((resolvePromise) => {
    let timerId = null;
    const finish = (completed) => {
      if (timerId !== null) clearTimeout(timerId);
      signal?.removeEventListener('abort', handleAbort);
      resolvePromise(completed);
    };
    const handleAbort = () => finish(false);
    if (signal?.aborted) {
      finish(false);
      return;
    }
    timerId = setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

async function runVirtualUser({ state, userId, random }) {
  let history = [];
  const tasks = [];

  for (let round = 1; round <= state.options.rounds; round += 1) {
    if (state.stopRequested) break;
    const plan = createTurnPlan({
      random,
      runId: state.runId,
      userId,
      round,
      history,
    });
    const startDelay = round === 1
      ? Math.floor(random() * Math.max(1, state.options.gapMs))
      : 0;
    const task = delay(startDelay, state.shutdownSignal)
      .then((completedDelay) => {
        if (!completedDelay || state.stopRequested) return { responseText: null };
        return runTurn({ state, plan });
      })
      .then(({ responseText }) => {
        if (responseText) {
          history = [
            ...history,
            { role: 'user', content: plan.message },
            { role: 'assistant', content: responseText },
          ].slice(-MAX_HISTORY_ITEMS);
        }
      });
    tasks.push(task);
    if (round < state.options.rounds) {
      const completedGap = await delay(state.options.gapMs, state.shutdownSignal);
      if (!completedGap) break;
    }
  }

  await Promise.allSettled(tasks);
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

export function summarizeDurations(values) {
  if (!values.length) {
    return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  }
  return {
    count: values.length,
    minMs: Math.min(...values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

function createReport(state, endedAt) {
  const completedTurns = state.turns.filter((turn) => turn.status === 'completed');
  const failedTurns = state.turns.filter((turn) => turn.status === 'failed');
  const abortedTurns = state.turns.filter((turn) => turn.status === 'aborted');
  const errors = state.turns
    .filter((turn) => turn.error)
    .map((turn) => ({
      userId: turn.userId,
      turnId: turn.turnId,
      round: turn.round,
      ...turn.error,
    }));
  const emotionCounts = {};
  for (const turn of completedTurns) {
    if (turn.emotion) emotionCounts[turn.emotion] = (emotionCounts[turn.emotion] ?? 0) + 1;
  }

  const report = {
    schemaVersion: 1,
    runId: state.runId,
    startedAt: state.startedAt,
    endedAt,
    interrupted: state.shutdownSignal.aborted,
    options: {
      ...state.options,
      outputPath: state.options.outputPath ?? null,
    },
    counts: {
      scheduled: state.options.users * state.options.rounds,
      started: state.turns.length,
      completed: completedTurns.length,
      failed: failedTurns.length,
      aborted: abortedTurns.length,
      unfinished: Math.max(
        0,
        state.options.users * state.options.rounds - state.turns.length,
      ),
    },
    concurrency: {
      maxActiveTurns: state.maxActiveTurns,
      maxInFlightRequests: state.maxInFlightRequests,
      activeTurnsAtEnd: state.activeTurns,
      inFlightRequestsAtEnd: state.inFlightRequests,
    },
    httpStatuses: state.httpStatuses,
    latencies: {
      chat: summarizeDurations(
        completedTurns
          .map((turn) => turn.chatDurationMs)
          .filter((value) => value !== null),
      ),
      tts: summarizeDurations(
        completedTurns
          .map((turn) => turn.ttsDurationMs)
          .filter((value) => value !== null),
      ),
      turn: summarizeDurations(
        completedTurns
          .map((turn) => turn.turnDurationMs)
          .filter((value) => value !== null),
      ),
    },
    emotionCounts,
    errors,
    turns: state.turns.map((turn) => ({
      runId: turn.runId,
      userId: turn.userId,
      turnId: turn.turnId,
      round: turn.round,
      source: turn.source,
      messageKey: turn.messageKey,
      brainCardIds: turn.brainCardIds,
      forcedCardId: turn.forcedCardId,
      status: turn.status,
      phase: turn.phase,
      emotion: turn.emotion,
      chatDurationMs: turn.chatDurationMs,
      ttsDurationMs: turn.ttsDurationMs,
      turnDurationMs: turn.turnDurationMs,
      error: turn.error,
      events: turn.events,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    })),
  };

  return report;
}

export function evaluateReport(report) {
  const failures = [];
  if (report.counts.failed > 0) failures.push(`${report.counts.failed} turn(s) failed`);
  if (report.counts.unfinished > 0) {
    failures.push(`${report.counts.unfinished} turn(s) were not started`);
  }
  if (report.counts.aborted > 0 && !report.interrupted) {
    failures.push(`${report.counts.aborted} turn(s) were aborted`);
  }
  if (report.concurrency.activeTurnsAtEnd !== 0) {
    failures.push('active turns remained at the end');
  }
  if (report.concurrency.inFlightRequestsAtEnd !== 0) {
    failures.push('HTTP requests remained at the end');
  }

  const sloChecks = [
    ['chat', report.options.maxP95ChatMs],
    ['tts', report.options.maxP95TtsMs],
    ['turn', report.options.maxP95TurnMs],
  ];
  for (const [name, threshold] of sloChecks) {
    if (threshold === null) continue;
    const actual = report.latencies[name].p95Ms;
    if (actual === null || actual > threshold) {
      failures.push(
        `${name} p95 ${actual ?? 'n/a'}ms exceeded ${threshold}ms`,
      );
    }
  }

  return { passed: failures.length === 0, failures };
}

function createRunState(options, runId, shutdownSignal) {
  return {
    runId,
    options,
    shutdownSignal,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    turns: [],
    activeTurns: 0,
    maxActiveTurns: 0,
    inFlightRequests: 0,
    maxInFlightRequests: 0,
    httpStatuses: {},
  };
}

function formatDuration(value) {
  return value === null ? 'n/a' : `${value}ms`;
}

function printHelp() {
  console.log(`Wildcard exhibition stress test

Usage:
  npm run stress -- [options]

Options:
  --base-url URL              Vite server URL (default: ${DEFAULT_OPTIONS.baseUrl})
  --users N                   Virtual users (default: ${DEFAULT_OPTIONS.users})
  --rounds N                  Rounds per user (default: ${DEFAULT_OPTIONS.rounds})
  --gap-ms N                  Gap between rounds (default: ${DEFAULT_OPTIONS.gapMs})
  --seed TEXT                 Deterministic input seed (default: ${DEFAULT_OPTIONS.seed})
  --timeout-ms N              Per-request timeout (default: ${DEFAULT_OPTIONS.timeoutMs})
  --out PATH                  JSON report path
  --max-p95-chat-ms N         Optional Chat p95 limit
  --max-p95-tts-ms N          Optional TTS p95 limit
  --max-p95-turn-ms N         Optional full-turn p95 limit
  --help                      Show this help
`);
}

function printSummary(report, evaluation, outputPath) {
  console.log('');
  console.log(`Stress run ${report.runId}`);
  console.log(
    `Turns: ${report.counts.completed}/${report.counts.scheduled} completed, ` +
      `${report.counts.failed} failed, ${report.counts.aborted} aborted`,
  );
  console.log(
    `Concurrency: turns max=${report.concurrency.maxActiveTurns}, ` +
      `requests max=${report.concurrency.maxInFlightRequests}`,
  );
  console.log(
    `Latency: chat p95=${formatDuration(report.latencies.chat.p95Ms)}, ` +
      `tts p95=${formatDuration(report.latencies.tts.p95Ms)}, ` +
      `turn p95=${formatDuration(report.latencies.turn.p95Ms)}`,
  );
  console.log(`Report: ${outputPath}`);
  if (evaluation.passed) {
    console.log('Result: PASS');
  } else {
    console.error(`Result: FAIL (${evaluation.failures.join('; ')})`);
  }
}

async function writeReport(report, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Use --help for usage.');
    process.exitCode = 2;
    return;
  }
  if (options.showHelp) {
    printHelp();
    return;
  }

  const runId = randomUUID();
  const shutdownController = new AbortController();
  const defaultOutputPath = resolve(
    DEFAULT_OUTPUT_DIRECTORY,
    `stress-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.json`,
  );
  options.outputPath = options.outputPath ?? defaultOutputPath;
  const state = createRunState(options, runId, shutdownController.signal);
  const handleSigint = () => {
    if (shutdownController.signal.aborted) return;
    state.stopRequested = true;
    console.error('Interrupt received. Aborting active requests...');
    shutdownController.abort();
  };
  process.once('SIGINT', handleSigint);

  try {
    const users = Array.from({ length: options.users }, (_, index) =>
      runVirtualUser({
        state,
        userId: `user-${index + 1}`,
        random: createSeededRandom(`${options.seed}:user-${index + 1}`),
      }),
    );
    await Promise.all(users);
  } finally {
    process.removeListener('SIGINT', handleSigint);
  }

  const report = createReport(state, new Date().toISOString());
  const evaluation = evaluateReport(report);
  try {
    await writeReport(report, options.outputPath);
  } catch (error) {
    console.error(
      `Could not write report ${options.outputPath}:`,
      error instanceof Error ? error.message : String(error),
    );
    evaluation.passed = false;
    evaluation.failures.push('report could not be written');
  }
  printSummary(report, evaluation, options.outputPath);
  process.exitCode = report.interrupted ? 130 : evaluation.passed ? 0 : 1;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  await main();
}
