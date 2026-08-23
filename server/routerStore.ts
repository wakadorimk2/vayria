import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ROUTER_CASE_IDS,
  ROUTER_CONTROL_STATES,
  ROUTER_GATES,
  ROUTER_KINDS,
  ROUTER_LANES,
  ROUTER_ORIGINS,
  isRouterDecision,
  isRouterReason,
  type RouterEvent,
  type RouterMetrics,
} from '../src/router/routerTypes.js';

export const MAX_ROUTER_EVENT_BYTES = 16 * 1024;
export const ROUTER_SESSION_ID_PATTERN = /^rt-[A-Za-z0-9-]{1,100}$/;

const FORBIDDEN_KEYS = new Set([
  'apikey',
  'api_key',
  'audio',
  'audiodata',
  'command',
  'deviceid',
  'history',
  'pcm',
  'prompt',
  'rawaudio',
  'rawpcm',
  'secret',
  'text',
]);

const EVENT_KEYS = new Set([
  'event',
  'timestamp',
  'sessionId',
  'caseId',
  'origin',
  'kind',
  'controlState',
  'vayriaLane',
  'gptLane',
  'gptInputGate',
  'vayriaOutputGate',
  'decision',
  'reason',
  'latencyMs',
  'metrics',
]);

const METRIC_KEYS = new Set([
  'turnCount',
  'stateTransitionErrors',
  'falseInterruptions',
  'confirmedInterruptions',
  'interruptionLatencyMs',
  'backchannelRepetitions',
  'gateBlockedCount',
  'cooldownMs',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const containsForbiddenName = [
      'apikey',
      'audio',
      'command',
      'deviceid',
      'history',
      'pcm',
      'prompt',
      'secret',
      'text',
    ].some((token) => normalizedKey.includes(token));
    return (
      FORBIDDEN_KEYS.has(key.toLowerCase()) ||
      containsForbiddenName ||
      containsForbiddenKey(nested)
    );
  });
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function isValidMetrics(value: unknown): value is RouterMetrics {
  if (!isPlainRecord(value)) return false;
  if (Object.keys(value).some((key) => !METRIC_KEYS.has(key))) return false;
  for (const key of [
    'turnCount',
    'stateTransitionErrors',
    'falseInterruptions',
    'confirmedInterruptions',
    'backchannelRepetitions',
    'gateBlockedCount',
    'cooldownMs',
  ]) {
    if (!isFiniteNonNegativeInteger(value[key])) return false;
  }
  if (
    value.interruptionLatencyMs !== null &&
    !isFiniteNonNegativeInteger(value.interruptionLatencyMs)
  ) {
    return false;
  }
  return true;
}

function isValidRouterEvent(value: unknown): value is RouterEvent {
  if (!isPlainRecord(value)) return false;
  if (Object.keys(value).some((key) => !EVENT_KEYS.has(key))) return false;
  if (typeof value.event !== 'string') return false;
  if (
    ![
      'state_observed',
      'control_applied',
      'case_started',
      'case_finished',
      'gate_blocked',
      'transition_error',
    ].includes(value.event)
  ) {
    return false;
  }
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) {
    return false;
  }
  if (
    typeof value.sessionId !== 'string' ||
    !ROUTER_SESSION_ID_PATTERN.test(value.sessionId)
  ) {
    return false;
  }
  if (
    value.caseId !== null &&
    (typeof value.caseId !== 'string' ||
      !(ROUTER_CASE_IDS as readonly string[]).includes(value.caseId))
  ) {
    return false;
  }
  if (!(ROUTER_ORIGINS as readonly string[]).includes(String(value.origin))) {
    return false;
  }
  if (!(ROUTER_KINDS as readonly string[]).includes(String(value.kind))) {
    return false;
  }
  if (
    !(ROUTER_CONTROL_STATES as readonly string[]).includes(
      String(value.controlState),
    ) ||
    !(ROUTER_LANES as readonly string[]).includes(String(value.vayriaLane)) ||
    !(ROUTER_LANES as readonly string[]).includes(String(value.gptLane)) ||
    !(ROUTER_GATES as readonly string[]).includes(String(value.gptInputGate)) ||
    !(ROUTER_GATES as readonly string[]).includes(
      String(value.vayriaOutputGate),
    )
  ) {
    return false;
  }
  if (!isRouterDecision(value.decision)) return false;
  if (!isRouterReason(value.reason)) return false;
  if (
    value.latencyMs !== null &&
    !isFiniteNonNegativeInteger(value.latencyMs)
  ) {
    return false;
  }
  return isValidMetrics(value.metrics);
}

function readRecordValue(payload: unknown): unknown {
  if (!isPlainRecord(payload)) return payload;
  if (!('record' in payload)) return payload;
  if (Object.keys(payload).length !== 1) return null;
  return payload.record;
}

export function readRouterEvent(payload: unknown): RouterEvent {
  const value = readRecordValue(payload);
  if (
    !isPlainRecord(value) ||
    containsForbiddenKey(value) ||
    !isValidRouterEvent(value)
  ) {
    throw new Error('Router event is invalid.');
  }
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_ROUTER_EVENT_BYTES) {
    throw new Error('Router event is too large.');
  }
  return value;
}

function recordPath(root: string, sessionId: string): string {
  if (!ROUTER_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Router session ID is invalid.');
  }
  return join(resolve(root), 'router', sessionId, 'events.jsonl');
}

export async function appendRouterEvent(
  root: string,
  event: RouterEvent,
): Promise<void> {
  const parsed = readRouterEvent(event);
  const path = recordPath(root, parsed.sessionId);
  await mkdir(resolve(root, 'router', parsed.sessionId), { recursive: true });
  await appendFile(path, `${JSON.stringify(parsed)}\n`, { encoding: 'utf8' });
}

export async function readRouterEvents(
  root: string,
  sessionId: string,
): Promise<RouterEvent[]> {
  const path = recordPath(root, sessionId);
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const events: RouterEvent[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid Router JSONL record at line ${index + 1}.`);
    }
    try {
      const event = readRouterEvent(parsed);
      if (event.sessionId !== sessionId) {
        throw new Error('Session ID does not match.');
      }
      events.push(event);
    } catch {
      throw new Error(`Invalid Router event at line ${index + 1}.`);
    }
  }
  return events;
}
