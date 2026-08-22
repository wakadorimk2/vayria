import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const SCENARIO_IDS = Object.freeze([
  'idle_presence',
  'manual_response',
  'autonomous_turn',
  'silence_gap',
  'continuity_variation',
  'interruption',
]);

export const RUBRIC_AXES = Object.freeze([
  'presence',
  'timing',
  'continuity',
  'emotion',
  'embodiment',
]);

export const GATE_AXES = Object.freeze(['timing', 'emotion', 'embodiment']);
export const PLAYCHECK_RUN_ID_PATTERN = /^pc-[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
export const SCORE_VALUES = Object.freeze([0, 1, 2, 3, 'N/A']);
export const MAX_OWNER_NOTE_LENGTH = 500;

export const RUBRIC_AXIS_LABELS = Object.freeze({
  presence: '存在感・待機状態',
  timing: '間・ターン交替',
  continuity: '内容の連続性・変化',
  emotion: '感情と発話の整合',
  embodiment: '声・視線・動きの統一',
});

export const PLAYCHECK_CASES = Object.freeze([
  {
    id: 'idle_presence',
    title: '無入力で待機',
    premise: 'アバターと音声を準備する。',
    operation: '無入力で20秒以上待つ。',
    observation: '呼吸、瞬き、揺れ、視線、過剰動作を観察する。',
  },
  {
    id: 'manual_response',
    title: '手動入力への反応',
    premise: 'セッションをリセットする。',
    operation: '短い入力を1回送る。',
    observation: '返答開始、声、感情、視線、口パクを観察する。',
  },
  {
    id: 'autonomous_turn',
    title: '自律発話',
    premise: '自律発話を有効にする。',
    operation: '次の自律発話を待つ。',
    observation: '発話前の間、短さ、独り言らしさを観察する。',
  },
  {
    id: 'silence_gap',
    title: '沈黙後の再開',
    premise: '自律発話を継続する。',
    operation: '沈黙または非発話反応を待つ。',
    observation: '沈黙の自然さと再開の間を観察する。',
  },
  {
    id: 'continuity_variation',
    title: '話題継続と変化',
    premise: '自律発話を複数回待つ。',
    operation: '話題の継続と変更を観察する。',
    observation: '表現の重複、内容の連続性、感情の変化を観察する。',
  },
  {
    id: 'interruption',
    title: '自律処理への割り込み',
    premise: '自律処理を開始する。',
    operation: '考え中または発話中に手動入力を送る。',
    observation: '古い発話、視線、動きが残らず新しいターンへ移るか観察する。',
  },
]);

const DEFAULT_BASE_URL = 'http://127.0.0.1:5187/';
const DEFAULT_LOCAL_ROOT = 'playcheck-results/local';
const DEFAULT_RESULTS_ROOT = 'docs/evaluation/results';
const FORBIDDEN_RECORD_KEYS = new Set([
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

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
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

function normalizeBaseUrl(value) {
  const rawValue = String(value).trim();
  const markdownLink = rawValue.match(/^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/);
  const candidate = markdownLink?.[1] ?? rawValue;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('--base-url must be a valid HTTP or HTTPS URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('--base-url must use HTTP or HTTPS.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('--base-url must not contain a query or hash.');
  }
  return parsed.toString();
}

export function isValidRunId(value) {
  return typeof value === 'string' && PLAYCHECK_RUN_ID_PATTERN.test(value);
}

export function createRunId(
  now = new Date(),
  random = randomBytes(4),
) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = Buffer.from(random).toString('hex').slice(0, 8);
  const runId = `pc-${stamp}-${suffix}`;
  if (!isValidRunId(runId)) throw new Error('Generated run ID is invalid.');
  return runId;
}

export function parseArgs(argv) {
  const command = argv[0] ?? 'help';
  if (!['start', 'score', 'finalize', 'help'].includes(command)) {
    throw new Error(`Unknown Playcheck command: ${command}`);
  }

  const options = {
    baseUrl: DEFAULT_BASE_URL,
    force: false,
    localRoot: DEFAULT_LOCAL_ROOT,
    resultsRoot: DEFAULT_RESULTS_ROOT,
    runId: null,
    caseId: null,
    work: null,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force') {
      options.force = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') continue;

    const definitions = [
      ['--base-url', 'baseUrl', normalizeBaseUrl],
      ['--local-root', 'localRoot', (value) => value],
      ['--results-root', 'resultsRoot', (value) => value],
      ['--run-id', 'runId', (value) => value],
      ['--case', 'caseId', (value) => value],
      ['--work', 'work', (value) => value],
    ];
    const definition = definitions.find(([name]) =>
      argument === name || argument.startsWith(`${name}=`),
    );
    if (!definition) throw new Error(`Unknown option: ${argument}`);
    const [name, property, normalize] = definition;
    const [rawValue, nextIndex] = readOptionValue(argv, index, name);
    if (!rawValue) throw new Error(`${name} must not be empty.`);
    options[property] = normalize(rawValue);
    index = nextIndex;
  }

  return { command, ...options };
}

function createScoreTemplate() {
  return Object.fromEntries(RUBRIC_AXES.map((axis) => [axis, 'N/A']));
}

export function createRunTemplate({
  runId,
  startedAt = new Date().toISOString(),
  baseUrl = DEFAULT_BASE_URL,
}) {
  if (!isValidRunId(runId)) throw new Error('runId is invalid.');
  return {
    schemaVersion: 1,
    runId,
    startedAt,
    finishedAt: null,
    baseUrl,
    scenarios: SCENARIO_IDS.map((id) => ({
      id,
      observedOutcome: 'not_observed',
      scores: createScoreTemplate(),
      naReasons: {},
      notes: '',
    })),
  };
}

async function writeJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function normalizeScore(value, path) {
  if (value === 'N/A') return value;
  if (Number.isInteger(value) && value >= 0 && value <= 3) return value;
  throw new Error(`${path} must be 0, 1, 2, 3, or N/A.`);
}

export function parseInteractiveScore(value, path = 'score') {
  const normalized = String(value).trim().toUpperCase();
  if (normalized === 'N/A' || normalized === 'NA') return 'N/A';
  if (/^[0-3]$/.test(normalized)) return Number(normalized);
  throw new Error(`${path} must be 0, 1, 2, 3, or N/A.`);
}

function normalizeOwnerNote(value, path) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${path} must be a string.`);
  if (value.length > MAX_OWNER_NOTE_LENGTH) {
    throw new Error(`${path} must be ${MAX_OWNER_NOTE_LENGTH} characters or fewer.`);
  }
  return value.trim();
}

function hasValidStoredScore(value) {
  try {
    normalizeScore(value, 'score');
    return true;
  } catch {
    return false;
  }
}

export function isScenarioComplete(scenario) {
  if (!scenario || scenario.observedOutcome !== 'observed') return false;
  return RUBRIC_AXES.every((axis) => {
    const score = scenario.scores?.[axis];
    if (!hasValidStoredScore(score)) return false;
    if (score !== 'N/A') return true;
    return typeof scenario.naReasons?.[axis] === 'string' &&
      Boolean(scenario.naReasons[axis].trim());
  });
}

function getCaseDefinition(caseId) {
  return PLAYCHECK_CASES.find((candidate) => candidate.id === caseId) ?? null;
}

function validateCaseId(caseId) {
  if (caseId === null || caseId === undefined) return;
  if (!getCaseDefinition(caseId)) {
    throw new Error(`Unknown Playcheck case: ${caseId}`);
  }
}

export function validateWorkAssessment(value, runId) {
  const assessment = assertObject(value, 'Assessment');
  if (assessment.runId !== runId) {
    throw new Error('Assessment runId does not match the requested run.');
  }
  if (!Array.isArray(assessment.scenarios)) {
    throw new Error('Assessment scenarios must be an array.');
  }
  if (assessment.scenarios.length !== SCENARIO_IDS.length) {
    throw new Error(`Assessment must contain ${SCENARIO_IDS.length} scenarios.`);
  }

  const knownScenarios = new Set(SCENARIO_IDS);
  const seenScenarios = new Set();
  const scenarios = assessment.scenarios.map((candidate, index) => {
    const scenario = assertObject(candidate, `scenarios[${index}]`);
    if (
      typeof scenario.id !== 'string' ||
      !knownScenarios.has(scenario.id)
    ) {
      throw new Error(`scenarios[${index}].id is unknown.`);
    }
    if (seenScenarios.has(scenario.id)) {
      throw new Error(`Scenario ${scenario.id} is duplicated.`);
    }
    seenScenarios.add(scenario.id);

    const scores = assertObject(scenario.scores, `${scenario.id}.scores`);
    const naReasons = scenario.naReasons === undefined
      ? {}
      : assertObject(scenario.naReasons, `${scenario.id}.naReasons`);
    for (const axis of RUBRIC_AXES) {
      if (!Object.hasOwn(scores, axis)) {
        throw new Error(`${scenario.id}.scores.${axis} is missing.`);
      }
      normalizeScore(scores[axis], `${scenario.id}.scores.${axis}`);
    }

    return {
      ...scenario,
      observedOutcome:
        typeof scenario.observedOutcome === 'string'
          ? scenario.observedOutcome
          : 'not_observed',
      scores: { ...scores },
      naReasons: { ...naReasons },
      notes: normalizeOwnerNote(scenario.notes, `${scenario.id}.notes`),
    };
  });

  if (seenScenarios.size !== SCENARIO_IDS.length) {
    throw new Error('Assessment is missing a required scenario.');
  }

  return { ...assessment, scenarios };
}

export function validateAssessment(value, runId) {
  const assessment = assertObject(value, 'Assessment');
  if (assessment.runId !== runId) {
    throw new Error('Assessment runId does not match the requested run.');
  }
  if (!Array.isArray(assessment.scenarios)) {
    throw new Error('Assessment scenarios must be an array.');
  }
  if (assessment.scenarios.length !== SCENARIO_IDS.length) {
    throw new Error(`Assessment must contain ${SCENARIO_IDS.length} scenarios.`);
  }

  const knownScenarios = new Set(SCENARIO_IDS);
  const seenScenarios = new Set();
  const normalizedScenarios = assessment.scenarios.map((candidate, index) => {
    const scenario = assertObject(candidate, `scenarios[${index}]`);
    if (
      typeof scenario.id !== 'string' ||
      !knownScenarios.has(scenario.id)
    ) {
      throw new Error(`scenarios[${index}].id is unknown.`);
    }
    if (seenScenarios.has(scenario.id)) {
      throw new Error(`Scenario ${scenario.id} is duplicated.`);
    }
    seenScenarios.add(scenario.id);

    const scores = assertObject(scenario.scores, `${scenario.id}.scores`);
    const naReasons = scenario.naReasons === undefined
      ? {}
      : assertObject(scenario.naReasons, `${scenario.id}.naReasons`);
    const normalizedScores = {};
    const normalizedNaReasons = {};
    for (const axis of RUBRIC_AXES) {
      if (!Object.hasOwn(scores, axis)) {
        throw new Error(`${scenario.id}.scores.${axis} is missing.`);
      }
      const score = normalizeScore(scores[axis], `${scenario.id}.scores.${axis}`);
      if (score === 'N/A') {
        if (
          typeof naReasons[axis] !== 'string' ||
          !naReasons[axis].trim()
        ) {
          throw new Error(`${scenario.id}.naReasons.${axis} is required for N/A.`);
        }
        normalizedNaReasons[axis] = naReasons[axis].trim();
      }
      normalizedScores[axis] = score;
    }

    return {
      id: scenario.id,
      observedOutcome:
        typeof scenario.observedOutcome === 'string'
          ? scenario.observedOutcome
          : 'not_observed',
      scores: normalizedScores,
      naReasons: normalizedNaReasons,
      notes: normalizeOwnerNote(scenario.notes, `${scenario.id}.notes`),
    };
  });

  if (seenScenarios.size !== SCENARIO_IDS.length) {
    throw new Error('Assessment is missing a required scenario.');
  }

  return {
    schemaVersion: Number.isInteger(assessment.schemaVersion)
      ? assessment.schemaVersion
      : 1,
    runId,
    startedAt:
      typeof assessment.startedAt === 'string'
        ? assessment.startedAt
        : null,
    finishedAt:
      typeof assessment.finishedAt === 'string'
        ? assessment.finishedAt
        : new Date().toISOString(),
    scenarios: normalizedScenarios,
  };
}

async function readRawEvents(path, runId) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`No raw event file exists for ${runId}.`);
    }
    throw error;
  }

  const events = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`Raw event line ${index + 1} is not valid JSON.`);
    }
    assertObject(record, `Raw event line ${index + 1}`);
    if (record.runId !== runId || typeof record.event !== 'string') {
      throw new Error(`Raw event line ${index + 1} has an invalid runId or event.`);
    }
    if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) {
      throw new Error(`Raw event line ${index + 1} has an invalid timestamp.`);
    }
    for (const key of Object.keys(record)) {
      if (FORBIDDEN_RECORD_KEYS.has(key)) {
        throw new Error(`Raw event contains forbidden field: ${key}.`);
      }
    }
    events.push(record);
  }
  if (events.length === 0) throw new Error(`No raw events were recorded for ${runId}.`);
  return events;
}

function average(values) {
  if (values.length === 0) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

export function summarizeScores(scenarios) {
  const axisValues = Object.fromEntries(RUBRIC_AXES.map((axis) => [axis, []]));
  let zeroObserved = false;
  for (const scenario of scenarios) {
    for (const axis of RUBRIC_AXES) {
      const score = scenario.scores[axis];
      if (typeof score !== 'number') continue;
      axisValues[axis].push(score);
      if (score === 0) zeroObserved = true;
    }
  }

  const axisAverages = Object.fromEntries(
    RUBRIC_AXES.map((axis) => [
      axis,
      { count: axisValues[axis].length, average: average(axisValues[axis]) },
    ]),
  );
  const allValues = RUBRIC_AXES.flatMap((axis) => axisValues[axis]);
  const gateValues = GATE_AXES.flatMap((axis) => axisValues[axis]);
  const hasAllGateAxes = GATE_AXES.every((axis) => axisValues[axis].length > 0);
  const hasAllScenarioScores = scenarios.every((scenario) =>
    RUBRIC_AXES.some((axis) => typeof scenario.scores[axis] === 'number'),
  );
  const overallAverage = average(allValues);
  const gatePassed =
    hasAllGateAxes &&
    gateValues.length > 0 &&
    gateValues.every((score) => score >= 2);
  const complete = hasAllScenarioScores && hasAllGateAxes && allValues.length > 0;
  const passed =
    complete &&
    !zeroObserved &&
    gatePassed &&
    overallAverage !== null &&
    overallAverage >= 2;

  return {
    axisAverages,
    overallAverage,
    gateAxes: [...GATE_AXES],
    gatePassed,
    zeroObserved,
    complete,
    status: complete ? (passed ? 'pass' : 'fail') : 'incomplete',
  };
}

export function summarizeEvents(events) {
  const byEvent = {};
  const turnIds = new Set();
  const sources = new Set();
  for (const event of events) {
    byEvent[event.event] = (byEvent[event.event] ?? 0) + 1;
    if (typeof event.turnId === 'string') turnIds.add(event.turnId);
    if (typeof event.source === 'string') sources.add(event.source);
  }
  const timestamps = events.map((event) => Date.parse(event.at)).sort((a, b) => a - b);
  return {
    count: events.length,
    byEvent,
    turnCount: turnIds.size,
    sources: [...sources].sort(),
    firstAt: new Date(timestamps[0]).toISOString(),
    lastAt: new Date(timestamps.at(-1)).toISOString(),
  };
}

async function readPreviousRuns(resultsRoot) {
  const runsRoot = resolve(resultsRoot, 'runs');
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const value = await readJson(join(runsRoot, entry.name));
    if (value && typeof value.runId === 'string') runs.push(value);
  }
  return runs.sort((left, right) =>
    String(left.finishedAt ?? '').localeCompare(String(right.finishedAt ?? '')),
  );
}

function createAxisDeltas(current, previous) {
  return Object.fromEntries(
    RUBRIC_AXES.map((axis) => {
      const currentAverage = current.axisAverages[axis].average;
      const previousAverage = previous?.scores?.axisAverages?.[axis]?.average ?? null;
      return [
        axis,
        currentAverage === null || previousAverage === null
          ? null
          : Number((currentAverage - previousAverage).toFixed(2)),
      ];
    }),
  );
}

export function buildSummary(runs, generatedAt = new Date().toISOString()) {
  const numericTotals = Object.fromEntries(RUBRIC_AXES.map((axis) => [axis, { sum: 0, count: 0 }]));
  for (const run of runs) {
    for (const axis of RUBRIC_AXES) {
      const summary = run.scores?.axisAverages?.[axis];
      if (!summary || typeof summary.average !== 'number' || !summary.count) continue;
      numericTotals[axis].sum += summary.average * summary.count;
      numericTotals[axis].count += summary.count;
    }
  }
  const axisAverages = Object.fromEntries(
    RUBRIC_AXES.map((axis) => [
      axis,
      {
        count: numericTotals[axis].count,
        average: average(
          numericTotals[axis].count
            ? [numericTotals[axis].sum / numericTotals[axis].count]
            : [],
        ),
      },
    ]),
  );
  const latest = runs.at(-1) ?? null;
  return {
    schemaVersion: 1,
    generatedAt,
    runCount: runs.length,
    passCount: runs.filter((run) => run.scores?.status === 'pass').length,
    failCount: runs.filter((run) => run.scores?.status === 'fail').length,
    incompleteCount: runs.filter((run) => run.scores?.status === 'incomplete').length,
    latestRunId: latest?.runId ?? null,
    axisAverages,
    latestAxisAverages: latest?.scores?.axisAverages ?? null,
    latestAxisDeltas: latest?.axisDeltas ?? null,
  };
}

export async function startRun({
  baseUrl = DEFAULT_BASE_URL,
  localRoot = DEFAULT_LOCAL_ROOT,
  runId = createRunId(),
  force = false,
}) {
  const effectiveRunId = runId ?? createRunId();
  if (!isValidRunId(effectiveRunId)) throw new Error('runId is invalid.');
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const workPath = resolve(localRoot, 'work', `${effectiveRunId}.json`);
  if (!force) {
    try {
      await readFile(workPath, 'utf8');
      throw new Error(`Work file already exists: ${workPath}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const template = createRunTemplate({
    runId: effectiveRunId,
    baseUrl: normalizedBaseUrl,
  });
  await writeJson(workPath, template);
  const url = new URL(normalizedBaseUrl);
  url.searchParams.set('playcheckRunId', effectiveRunId);
  return {
    runId: effectiveRunId,
    workPath,
    rawPath: resolve(localRoot, 'raw', `${effectiveRunId}.jsonl`),
    url: url.toString(),
    template,
  };
}

function writeOutput(output, value = '') {
  output.write(`${value}\n`);
}

function currentScoreHint(scenario, axis) {
  const score = scenario.scores?.[axis];
  if (!hasValidStoredScore(score)) return '';
  const reason = scenario.naReasons?.[axis];
  if (score === 'N/A' && (typeof reason !== 'string' || !reason.trim())) return '';
  return ` [現在: ${score}。Enterで維持]`;
}

async function promptInteractiveScore({ ask, output, scenario, axis }) {
  const label = RUBRIC_AXIS_LABELS[axis];
  const currentHint = currentScoreHint(scenario, axis);
  while (true) {
    const answer = await ask(
      `  ${label} (${axis}) 0/1/2/3/N/A${currentHint}: `,
    );
    if (!answer.trim() && currentHint) return scenario.scores[axis];

    let score;
    try {
      score = parseInteractiveScore(answer, `${scenario.id}.${axis}`);
    } catch (error) {
      writeOutput(
        output,
        `入力エラー: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (score !== 'N/A') {
      delete scenario.naReasons[axis];
      return score;
    }

    const reason = (await ask('  N/Aの理由: ')).trim();
    if (!reason) {
      writeOutput(output, 'N/Aの理由は必須です。');
      continue;
    }
    scenario.naReasons[axis] = reason;
    return score;
  }
}

async function promptOwnerNote({ ask, output, scenario }) {
  const currentNote = typeof scenario.notes === 'string' ? scenario.notes : '';
  const suffix = currentNote ? '。Enterで現在の所感を維持' : '';
  while (true) {
    const answer = await ask(
      `所感（任意、${MAX_OWNER_NOTE_LENGTH}文字以内。発話本文・秘密情報・個人情報は禁止）${suffix}: `,
    );
    if (!answer.trim() && currentNote) return currentNote;
    try {
      return normalizeOwnerNote(answer, `${scenario.id}.notes`);
    } catch (error) {
      writeOutput(
        output,
        `入力エラー: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function readWorkAssessment(workPath, runId) {
  try {
    return validateWorkAssessment(await readJson(workPath), runId);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`No work file exists for ${runId}: ${workPath}`);
    }
    throw error;
  }
}

export async function scoreRun({
  localRoot = DEFAULT_LOCAL_ROOT,
  runId,
  work = null,
  caseId = null,
  input = process.stdin,
  output = process.stdout,
  ask: injectedAsk = null,
}) {
  if (!isValidRunId(runId)) throw new Error('runId is required and invalid.');
  validateCaseId(caseId);
  const workPath = resolve(work ?? join(localRoot, 'work', `${runId}.json`));
  const assessment = await readWorkAssessment(workPath, runId);
  const readline = injectedAsk
    ? null
    : createInterface({
        input,
        output,
        terminal: Boolean(output.isTTY),
      });
  const ask = injectedAsk ?? ((prompt) => readline.question(prompt));

  try {
    const targetIds = caseId
      ? [caseId]
      : SCENARIO_IDS.filter((id) => {
          const scenario = assessment.scenarios.find((candidate) => candidate.id === id);
          return !isScenarioComplete(scenario);
        });

    if (targetIds.length === 0) {
      writeOutput(output, 'このrunはすでに6ケースの採点が完了しています。');
      return { workPath, assessment, completedCaseIds: [], remainingCaseIds: [] };
    }

    const completedCaseIds = [];
    for (const targetId of targetIds) {
      const definition = getCaseDefinition(targetId);
      const scenario = assessment.scenarios.find((candidate) => candidate.id === targetId);
      if (!definition || !scenario) throw new Error(`Case ${targetId} is unavailable.`);

      writeOutput(output);
      writeOutput(output, `=== ${targetId}: ${definition.title} ===`);
      writeOutput(output, `前提: ${definition.premise}`);
      writeOutput(output, `操作: ${definition.operation}`);
      writeOutput(output, `観察点: ${definition.observation}`);
      writeOutput(output, 'iPadでこのケースを実行してください。終了したらEnterを押してください。');
      await ask('> ');

      scenario.observedOutcome = 'in_progress';
      await writeJson(workPath, assessment);
      for (const axis of RUBRIC_AXES) {
        scenario.scores[axis] = await promptInteractiveScore({
          ask,
          output,
          scenario,
          axis,
        });
        await writeJson(workPath, assessment);
      }

      scenario.notes = await promptOwnerNote({ ask, output, scenario });
      scenario.observedOutcome = 'observed';
      await writeJson(workPath, assessment);
      completedCaseIds.push(targetId);
      writeOutput(output, `${targetId} の採点を保存しました。`);
    }

    const remainingCaseIds = SCENARIO_IDS.filter((id) => {
      const scenario = assessment.scenarios.find((candidate) => candidate.id === id);
      return !isScenarioComplete(scenario);
    });
    writeOutput(output);
    if (remainingCaseIds.length > 0) {
      writeOutput(output, `残りのケース: ${remainingCaseIds.join(', ')}`);
    } else {
      writeOutput(output, '6ケースの採点が完了しました。');
      writeOutput(output, `確定: npm run playcheck -- finalize --run-id ${runId}`);
    }
    return { workPath, assessment, completedCaseIds, remainingCaseIds };
  } finally {
    readline?.close();
  }
}

export async function finalizeRun({
  localRoot = DEFAULT_LOCAL_ROOT,
  resultsRoot = DEFAULT_RESULTS_ROOT,
  runId,
  work = null,
  force = false,
}) {
  if (!isValidRunId(runId)) throw new Error('runId is required and invalid.');
  const workPath = resolve(work ?? join(localRoot, 'work', `${runId}.json`));
  const assessment = validateAssessment(await readJson(workPath), runId);
  const events = await readRawEvents(
    resolve(localRoot, 'raw', `${runId}.jsonl`),
    runId,
  );
  const scoreSummary = summarizeScores(assessment.scenarios);
  const previousRuns = await readPreviousRuns(resultsRoot);
  const previous = previousRuns.at(-1) ?? null;
  const finishedAt = assessment.finishedAt ?? new Date().toISOString();
  const aggregate = {
    schemaVersion: 1,
    runId,
    startedAt: assessment.startedAt,
    finishedAt,
    scenarios: assessment.scenarios,
    events: summarizeEvents(events),
    scores: scoreSummary,
    previousRunId: previous?.runId ?? null,
    axisDeltas: createAxisDeltas(scoreSummary, previous),
  };
  const outputPath = resolve(
    resultsRoot,
    'runs',
    `${finishedAt.slice(0, 10)}-${runId}.json`,
  );
  if (!force) {
    try {
      await readFile(outputPath, 'utf8');
      throw new Error(`Result file already exists: ${outputPath}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await writeJson(outputPath, aggregate);
  const allRuns = [...previousRuns, aggregate].sort((left, right) =>
    String(left.finishedAt ?? '').localeCompare(String(right.finishedAt ?? '')),
  );
  await writeJson(resolve(resultsRoot, 'summary.json'), buildSummary(allRuns));
  return { aggregate, outputPath, summaryPath: resolve(resultsRoot, 'summary.json') };
}

function printHelp() {
  console.log(`Playcheck commands:

  npm run playcheck -- start [--base-url URL] [--run-id ID]
  npm run playcheck -- score --run-id ID [--case CASE]
  npm run playcheck -- finalize --run-id ID [--work PATH]

Optional paths:
  --local-root PATH       default: ${DEFAULT_LOCAL_ROOT}
  --results-root PATH     default: ${DEFAULT_RESULTS_ROOT}
  --case CASE             score one case instead of the next incomplete case
  --force                 allow replacing an existing generated file
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printHelp();
    return;
  }
  if (options.command === 'start') {
    const run = await startRun(options);
    console.log(`Playcheck run: ${run.runId}`);
    console.log(`Open: ${run.url}`);
    console.log(`Score: npm run playcheck -- score --run-id ${run.runId}`);
    console.log(`State: ${run.workPath}`);
    console.log(`Raw events: ${run.rawPath}`);
    return;
  }

  if (options.command === 'score') {
    await scoreRun(options);
    return;
  }

  const result = await finalizeRun(options);
  console.log(`Playcheck result: ${result.aggregate.scores.status.toUpperCase()}`);
  console.log(`Run result: ${result.outputPath}`);
  console.log(`Summary: ${result.summaryPath}`);
  if (result.aggregate.scores.status === 'fail') process.exitCode = 1;
  if (result.aggregate.scores.status === 'incomplete') process.exitCode = 2;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`Playcheck error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
