import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import sharp from '../imageProcessing.js';
import { buildContactSheet } from './contactSheet.js';
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
  StreamBenchLabelRequest,
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
  reviewed: boolean;
  labelModel: string | null;
  source: {
    session: string;
    beforeSec: number;
    afterSec: number;
    diffScore: number;
    windowSec?: number;
    frameCount?: number;
  } | undefined;
}

interface StreamFixture {
  id: string;
  dirPath: string;
  beforePath: string;
  afterPath: string;
  midPaths: string[];
  sheetPath: string | null;
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
    reviewed: false,
    labelModel: null,
    source: undefined,
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dirPath, 'meta.json'), 'utf8'));
  } catch {
    return fallback;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const record = raw as Record<string, unknown>;
  const draft =
    record.labelDraft && typeof record.labelDraft === 'object'
      ? (record.labelDraft as Record<string, unknown>)
      : null;
  const source =
    record.source && typeof record.source === 'object'
      ? (record.source as Record<string, unknown>)
      : null;
  const expectedChanged =
    typeof record.expectedChanged === 'boolean' ? record.expectedChanged : null;
  return {
    category:
      typeof record.category === 'string' && record.category.trim()
        ? record.category.trim()
        : 'uncategorized',
    expectedChanged,
    expectedEventKinds: Array.isArray(record.expectedEventKinds)
      ? record.expectedEventKinds.filter(
          (kind): kind is string => typeof kind === 'string',
        )
      : [],
    notes: typeof record.notes === 'string' ? record.notes : '',
    // Draft-labeled fixtures are reviewed only after a human confirms them;
    // fixtures without a draft are treated as human-authored.
    reviewed: draft
      ? draft.reviewed === true
      : expectedChanged !== null || record.reviewed === true,
    labelModel: typeof draft?.model === 'string' ? draft.model : null,
    source:
      source &&
      typeof source.session === 'string' &&
      typeof source.beforeSec === 'number' &&
      typeof source.afterSec === 'number'
        ? {
            session: source.session,
            beforeSec: source.beforeSec,
            afterSec: source.afterSec,
            diffScore:
              typeof source.diffScore === 'number' ? source.diffScore : 0,
            ...(typeof source.windowSec === 'number'
              ? { windowSec: source.windowSec }
              : {}),
            ...(typeof source.frameCount === 'number'
              ? { frameCount: source.frameCount }
              : {}),
          }
        : undefined,
  };
}

const MID_FRAME_PATTERN = /^mid-(\d{1,2})$/;

function findFrameFile(
  dirPath: string,
  baseName: string,
): string | null {
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

function findMidFrames(dirPath: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return [];
  }
  return entries
    .map((name) => {
      const match = name.match(/^(mid-\d{1,2})\.[a-z]+$/i);
      if (!match || !IMAGE_EXTENSIONS.includes(name.split('.').pop()!)) {
        return null;
      }
      return { key: Number(match[1].split('-')[1]), name };
    })
    .filter((entry): entry is { key: number; name: string } => entry !== null)
    .sort((a, b) => a.key - b.key)
    .map((entry) => join(dirPath, entry.name));
}

function readFixture(root: string, id: string): StreamFixture | null {
  if (!isFixtureId(id)) return null;
  const dirPath = join(root, id);
  const beforePath = findFrameFile(dirPath, 'before');
  const afterPath = findFrameFile(dirPath, 'after');
  if (!beforePath || !afterPath) return null;
  return {
    id,
    dirPath,
    beforePath,
    afterPath,
    midPaths: findMidFrames(dirPath),
    sheetPath: findFrameFile(dirPath, 'contact-sheet'),
    meta: readFixtureMeta(dirPath),
  };
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
    reviewed: fixture.meta.reviewed,
    midCount: fixture.midPaths.length,
    ...(fixture.meta.labelModel
      ? { labelModel: fixture.meta.labelModel }
      : {}),
    ...(fixture.meta.source ? { source: fixture.meta.source } : {}),
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

// The provider payload is a single contact-sheet image so frame ordering is
// unambiguous. Fixtures extracted by scripts/extract-stream-fixtures.mjs
// ship a prebuilt contact-sheet; fixtures without one are composed here
// from before/mid-*/after.
function fixtureFramePaths(fixture: StreamFixture): string[] {
  return [fixture.beforePath, ...fixture.midPaths, fixture.afterPath];
}

async function fixtureSheet(fixture: StreamFixture): Promise<Buffer> {
  if (fixture.sheetPath) return readFileSync(fixture.sheetPath);
  const paths = fixtureFramePaths(fixture);
  const source = fixture.meta.source;
  const spacingSec =
    source && source.windowSec && paths.length > 0
      ? source.windowSec / paths.length
      : null;
  const labels = paths.map((_, index) =>
    spacingSec === null
      ? `F${index + 1}`
      : `F${index + 1}  ${(index * spacingSec).toFixed(1)}s`,
  );
  const sheet = await buildContactSheet(
    paths.map((path, index) => ({ path, label: labels[index] })),
  );
  return normalizeSheet(sheet);
}

async function normalizeSheet(image: Buffer | string): Promise<Buffer> {
  return sharp(image)
    .resize({ width: 2048, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

const MAX_NOTES_LENGTH = 2_048;
const CATEGORY_PATTERN = /^[\w][\w -]{0,62}$/u;

function readLabelRequest(payload: unknown): StreamBenchLabelRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError('Request body must be a JSON object.', 400);
  }
  const record = payload as Record<string, unknown>;
  if (!isFixtureId(record.fixtureId)) {
    throw new RequestError('fixtureId is invalid.', 400);
  }
  if (typeof record.expectedChanged !== 'boolean') {
    throw new RequestError('expectedChanged must be a boolean.', 400);
  }
  const eventKinds = Array.isArray(record.expectedEventKinds)
    ? record.expectedEventKinds
    : null;
  if (
    !eventKinds ||
    eventKinds.length > 8 ||
    eventKinds.some(
      (kind) =>
        typeof kind !== 'string' ||
        !SEVEN_DAYS_TO_DIE_PROFILE.eventKinds.includes(kind),
    )
  ) {
    throw new RequestError(
      'expectedEventKinds must be a list of known event kinds.',
      400,
    );
  }
  if (
    typeof record.category !== 'string' ||
    !CATEGORY_PATTERN.test(record.category)
  ) {
    throw new RequestError('category is invalid.', 400);
  }
  if (
    typeof record.notes !== 'string' ||
    record.notes.length > MAX_NOTES_LENGTH
  ) {
    throw new RequestError('notes is invalid.', 400);
  }
  return {
    fixtureId: record.fixtureId,
    expectedChanged: record.expectedChanged,
    expectedEventKinds: eventKinds as string[],
    category: record.category,
    notes: record.notes,
  };
}

async function handleLabelSave(
  request: IncomingMessage,
  response: ServerResponse,
  service: BenchService,
): Promise<void> {
  const label = readLabelRequest(await readJsonBody(request));
  const fixture = readFixture(service.root, label.fixtureId);
  if (!fixture) {
    throw new RequestError('Fixture not found.', 404);
  }
  const metaPath = join(service.root, label.fixtureId, 'meta.json');
  let existing: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) existing = raw;
  } catch {
    // Keep going: a missing or broken meta.json gets replaced entirely.
  }
  const draft =
    existing.labelDraft && typeof existing.labelDraft === 'object'
      ? (existing.labelDraft as Record<string, unknown>)
      : null;
  const merged: Record<string, unknown> = {
    ...existing,
    category: label.category,
    expectedChanged: label.expectedChanged,
    expectedEventKinds: label.expectedEventKinds,
    notes: label.notes,
    ...(draft
      ? {
          labelDraft: {
            ...draft,
            reviewed: true,
            reviewedAt: new Date().toISOString(),
          },
        }
      : { reviewed: true }),
  };
  writeFileSync(metaPath, `${JSON.stringify(merged, null, 2)}\n`);
  const updated = readFixture(service.root, label.fixtureId);
  sendJson(response, 200, { fixture: summarizeFixture(updated!) });
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
    const image = await fixtureSheet(fixture);
    const result = await provider.observe(
      {
        instruction: SEVEN_DAYS_TO_DIE_PROFILE.buildObservationInstruction(),
        schema: streamObservationSchema(SEVEN_DAYS_TO_DIE_PROFILE),
        image,
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
  source: string | Buffer,
): void {
  let body: Buffer;
  let contentType = 'image/jpeg';
  if (typeof source === 'string') {
    const extension = source.split('.').pop()?.toLowerCase();
    contentType =
      extension === 'png'
        ? 'image/png'
        : extension === 'webp'
          ? 'image/webp'
          : 'image/jpeg';
    body = readFileSync(source);
  } else {
    body = source;
  }
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
    const which = url.searchParams.get('which') ?? '';
    if (
      which !== 'before' &&
      which !== 'after' &&
      which !== 'sheet' &&
      !MID_FRAME_PATTERN.test(which)
    ) {
      sendJson(
        response,
        400,
        { error: 'which must be before, after, mid-<n>, or sheet.' },
      );
      return;
    }
    const fixture = readFixture(service.root, id);
    if (!fixture) {
      sendJson(response, 404, { error: 'Fixture not found.' });
      return;
    }
    try {
      if (which === 'sheet') {
        sendImage(response, fixture.sheetPath ?? (await fixtureSheet(fixture)));
        return;
      }
      const framePath =
        which === 'before'
          ? fixture.beforePath
          : which === 'after'
            ? fixture.afterPath
            : findFrameFile(join(service.root, id), which);
      if (!framePath) {
        sendJson(response, 404, { error: 'Fixture image not found.' });
        return;
      }
      sendImage(response, framePath);
    } catch {
      sendJson(response, 404, { error: 'Fixture image is unreadable.' });
    }
    return;
  }

  if (
    request.method === 'GET' &&
    pathname === `${STREAM_BENCH_PATH}/event-kinds`
  ) {
    sendJson(response, 200, {
      eventKinds: SEVEN_DAYS_TO_DIE_PROFILE.eventKinds,
    });
    return;
  }

  if (
    request.method === 'POST' &&
    pathname === `${STREAM_BENCH_PATH}/label`
  ) {
    await handleLabelSave(request, response, service);
    return;
  }

  if (request.method === 'POST' && pathname === STREAM_BENCH_PATH) {
    await handleBenchRun(request, response, config, service);
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
}
