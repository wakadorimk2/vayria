import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from '../imageProcessing.js';
import type { LocalApiConfig } from '../localApiSupport.js';
import {
  RequestError,
  readJsonBody,
  sendJson,
} from '../localApiSupport.js';
import {
  SEVEN_DAYS_TO_DIE_PROFILE,
  streamObservationSchema,
} from './gameProfiles.js';
import {
  STREAM_VISION_PROVIDERS,
  StreamVisionError,
  resolveStreamVisionProvider,
} from './visionProviders.js';
import type {
  StreamBenchFixtureSummary,
  StreamBenchRunRequest,
  StreamBenchRunResult,
  StreamObservation,
} from '../../src/stream/streamContract.js';
import { STREAM_BENCH_PATH } from '../../src/stream/streamContract.js';

export const STREAM_API_PREFIX = '/api/stream/';

const FIXTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_ACTIVE_RUNS = 4;
const MAX_RAW_TEXT_BYTES = 8_192;

interface FixtureMeta {
  category: string;
  expectedChanged: boolean | null;
  expectedEventKinds: string[];
  notes: string;
}

interface StreamFixture {
  id: string;
  beforePath: string;
  afterPath: string;
  meta: FixtureMeta;
}

interface BenchService {
  root: string;
  active: number;
}

const services = new WeakMap<LocalApiConfig, BenchService>();

function serviceFor(config: LocalApiConfig): BenchService {
  let service = services.get(config);
  if (!service) {
    service = {
      root: resolve(config.streamBenchRoot ?? 'stream-bench/fixtures'),
      active: 0,
    };
    services.set(config, service);
  }
  return service;
}

function isFixtureId(value: unknown): value is string {
  return typeof value === 'string' && FIXTURE_ID_PATTERN.test(value);
}

function readFixtureMeta(dirPath: string): FixtureMeta {
  const fallback: FixtureMeta = {
    category: 'uncategorized',
    expectedChanged: null,
    expectedEventKinds: [],
    notes: '',
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dirPath, 'meta.json'), 'utf8'));
  } catch {
    return fallback;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const record = raw as Record<string, unknown>;
  return {
    category:
      typeof record.category === 'string' && record.category.trim()
        ? record.category.trim()
        : 'uncategorized',
    expectedChanged:
      typeof record.expectedChanged === 'boolean' ? record.expectedChanged : null,
    expectedEventKinds: Array.isArray(record.expectedEventKinds)
      ? record.expectedEventKinds.filter(
          (kind): kind is string => typeof kind === 'string',
        )
      : [],
    notes: typeof record.notes === 'string' ? record.notes : '',
  };
}

function findFrameFile(dirPath: string, baseName: 'before' | 'after'): string | null {
  for (const extension of IMAGE_EXTENSIONS) {
    const candidate = join(dirPath, `${baseName}.${extension}`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function readFixture(root: string, id: string): StreamFixture | null {
  if (!isFixtureId(id)) return null;
  const dirPath = join(root, id);
  const beforePath = findFrameFile(dirPath, 'before');
  const afterPath = findFrameFile(dirPath, 'after');
  if (!beforePath || !afterPath) return null;
  return { id, beforePath, afterPath, meta: readFixtureMeta(dirPath) };
}

function listFixtures(root: string): StreamFixture[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const fixtures: StreamFixture[] = [];
  for (const entry of entries) {
    if (!isFixtureId(entry)) continue;
    const fixture = readFixture(root, entry);
    if (fixture) fixtures.push(fixture);
  }
  return fixtures.sort((a, b) => a.id.localeCompare(b.id));
}

function summarizeFixture(fixture: StreamFixture): StreamBenchFixtureSummary {
  return {
    id: fixture.id,
    category: fixture.meta.category,
    expectedChanged: fixture.meta.expectedChanged,
    expectedEventKinds: fixture.meta.expectedEventKinds,
    notes: fixture.meta.notes,
  };
}

function readEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === 'string' && allowed.includes(value as T)
    ? (value as T)
    : null;
}

export function coerceStreamObservation(value: unknown): StreamObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.changed !== 'boolean') return null;
  if (typeof record.changeSummary !== 'string') return null;
  if (!Array.isArray(record.events)) return null;
  const events = record.events
    .slice(0, 4)
    .map((event): StreamObservation['events'][number] | null => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
      const e = event as Record<string, unknown>;
      const significance = readEnumValue(e.significance, ['low', 'medium', 'high']);
      if (typeof e.kind !== 'string' || typeof e.summary !== 'string' || !significance) {
        return null;
      }
      return { kind: e.kind, summary: e.summary, significance };
    });
  if (events.some((event) => event === null)) return null;
  const scene = record.scene;
  const player = record.player;
  if (!scene || typeof scene !== 'object' || !player || typeof player !== 'object') {
    return null;
  }
  const s = scene as Record<string, unknown>;
  const p = player as Record<string, unknown>;
  const setting = readEnumValue(s.setting, [
    'outdoor',
    'indoor',
    'underground',
    'menu',
    'loading',
    'unknown',
  ]);
  const timeOfDay = readEnumValue(s.timeOfDay, [
    'day',
    'dusk',
    'night',
    'dawn',
    'unknown',
  ]);
  const healthState = readEnumValue(p.healthState, [
    'ok',
    'hurt',
    'critical',
    'dead',
    'unknown',
  ]);
  if (!setting || !timeOfDay || !healthState) return null;
  if (typeof s.bloodMoon !== 'boolean' || typeof p.activity !== 'string') {
    return null;
  }
  return {
    changed: record.changed,
    changeSummary: record.changeSummary,
    events: events as StreamObservation['events'],
    scene: { setting, timeOfDay, bloodMoon: s.bloodMoon },
    player: { activity: p.activity, healthState },
  };
}

export function parseStreamObservation(
  rawText: string,
): { jsonOk: boolean; observation: StreamObservation | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { jsonOk: false, observation: null };
  }
  return { jsonOk: true, observation: coerceStreamObservation(parsed) };
}

async function normalizeFrame(path: string): Promise<Buffer> {
  return sharp(path)
    .resize({ width: 768, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function readRunRequest(payload: unknown): StreamBenchRunRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError('Request body must be a JSON object.', 400);
  }
  const record = payload as Record<string, unknown>;
  if (!isFixtureId(record.fixtureId)) {
    throw new RequestError('fixtureId is invalid.', 400);
  }
  if (!resolveStreamVisionProvider(String(record.providerId))) {
    throw new RequestError('providerId is invalid.', 400);
  }
  if (
    record.model !== undefined &&
    (typeof record.model !== 'string' || !/^[\w./-]{1,80}$/u.test(record.model))
  ) {
    throw new RequestError('model is invalid.', 400);
  }
  return {
    fixtureId: record.fixtureId,
    providerId: record.providerId as StreamBenchRunRequest['providerId'],
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
  };
}

function benchResult(
  base: Pick<StreamBenchRunResult, 'fixtureId' | 'providerId' | 'model'>,
  patch: Partial<StreamBenchRunResult>,
): StreamBenchRunResult {
  return {
    ok: false,
    jsonOk: false,
    parseOk: false,
    latencyMs: 0,
    observation: null,
    ...base,
    ...patch,
  };
}

async function handleBenchRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: LocalApiConfig,
  service: BenchService,
): Promise<void> {
  const payload = await readJsonBody(request);
  const runRequest = readRunRequest(payload);
  const provider = resolveStreamVisionProvider(runRequest.providerId)!;
  const apiKey = provider.apiKeyOf(config);
  const fixture = readFixture(service.root, runRequest.fixtureId);
  const model = runRequest.model ?? provider.defaultModel;
  const base = {
    fixtureId: runRequest.fixtureId,
    providerId: provider.id,
    model,
  };
  if (!fixture) {
    throw new RequestError('Fixture not found.', 404);
  }
  if (!apiKey) {
    throw new RequestError(
      `API key for provider ${provider.id} is not configured.`,
      503,
    );
  }
  if (service.active >= MAX_ACTIVE_RUNS) {
    throw new RequestError('Too many benchmark runs in flight.', 429);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once('aborted', abort);
  response.once('close', abort);
  const expected = {
    changed: fixture.meta.expectedChanged,
    eventKinds: fixture.meta.expectedEventKinds,
  };
  service.active += 1;
  const startedAt = performance.now();
  try {
    const [beforeImage, afterImage] = await Promise.all([
      normalizeFrame(fixture.beforePath),
      normalizeFrame(fixture.afterPath),
    ]);
    const result = await provider.observe(
      {
        instruction: SEVEN_DAYS_TO_DIE_PROFILE.buildObservationInstruction(),
        schema: streamObservationSchema(SEVEN_DAYS_TO_DIE_PROFILE),
        beforeImage,
        afterImage,
        model,
        signal: controller.signal,
      },
      apiKey,
    );
    const parsed = parseStreamObservation(result.rawText);
    sendJson(
      response,
      200,
      benchResult(base, {
        ok: parsed.observation !== null,
        jsonOk: parsed.jsonOk,
        parseOk: parsed.observation !== null,
        latencyMs: result.latencyMs,
        observation: parsed.observation,
        rawText: result.rawText.slice(0, MAX_RAW_TEXT_BYTES),
        usage: result.usage,
        expected,
      }),
    );
  } catch (error) {
    if (error instanceof StreamVisionError) {
      sendJson(
        response,
        200,
        benchResult(base, {
          latencyMs: Math.round(performance.now() - startedAt),
          error: {
            kind: error.kind,
            message: error.message,
            ...(error.status !== null ? { status: error.status } : {}),
          },
          expected,
        }),
      );
      return;
    }
    throw error;
  } finally {
    service.active -= 1;
    request.off('aborted', abort);
    response.off('close', abort);
  }
}

function sendImage(
  response: ServerResponse,
  path: string,
): void {
  const extension = path.split('.').pop()?.toLowerCase();
  const contentType =
    extension === 'png'
      ? 'image/png'
      : extension === 'webp'
        ? 'image/webp'
        : 'image/jpeg';
  const body = readFileSync(path);
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': body.byteLength,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

export async function handleStreamRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: LocalApiConfig,
): Promise<void> {
  try {
    await routeStreamRequest(request, response, config);
  } catch (error) {
    if (error instanceof RequestError) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }
    console.error('Stream API request failed.', error);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendJson(response, 502, { error: 'The stream request failed.' });
  }
}

async function routeStreamRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: LocalApiConfig,
): Promise<void> {
  if (!config.streamBenchEnabled || config.mode === 'public') {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const service = serviceFor(config);

  if (request.method === 'GET' && pathname === `${STREAM_BENCH_PATH}/providers`) {
    sendJson(response, 200, {
      providers: STREAM_VISION_PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        model: provider.defaultModel,
        configured: Boolean(provider.apiKeyOf(config)),
        usdPerMillionTokens: provider.usdPerMillionTokens,
      })),
    });
    return;
  }

  if (request.method === 'GET' && pathname === `${STREAM_BENCH_PATH}/fixtures`) {
    sendJson(response, 200, {
      root: service.root,
      fixtures: listFixtures(service.root).map(summarizeFixture),
    });
    return;
  }

  if (
    request.method === 'GET' &&
    pathname === `${STREAM_BENCH_PATH}/fixture-image`
  ) {
    const id = url.searchParams.get('id') ?? '';
    const which = url.searchParams.get('which');
    if (which !== 'before' && which !== 'after') {
      sendJson(response, 400, { error: 'which must be before or after.' });
      return;
    }
    const fixture = readFixture(service.root, id);
    if (!fixture) {
      sendJson(response, 404, { error: 'Fixture not found.' });
      return;
    }
    try {
      sendImage(
        response,
        which === 'before' ? fixture.beforePath : fixture.afterPath,
      );
    } catch {
      sendJson(response, 404, { error: 'Fixture image is unreadable.' });
    }
    return;
  }

  if (request.method === 'POST' && pathname === STREAM_BENCH_PATH) {
    await handleBenchRun(request, response, config, service);
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
}
