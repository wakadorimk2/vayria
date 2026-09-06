import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AIVIS_VOICE_PARAMETERS,
  EMOTIONS,
  VOICE_STYLE_BY_EMOTION,
  ZONOKO_SPEAKER_NAME,
  type Emotion
} from '../src/character/emotion.js';
import { AIVIS_CONNECTION_ERROR, AIVIS_SPEAKER_CACHE_TTL_MS, AivisSpeechError, DEFAULT_AIVIS_BASE_URL, NORMAL_VOICE_STYLE_NAME, RequestError, type AivisSpeaker, type AivisSpeakerCatalogCache, type AivisStyle, type AivisTtsSettings, type LocalApiConfig, type PreparedAivisCloudAudio, type TtsBackend } from './localApiSupport.js';
import {
  AivisCloudError,
  type AivisCloudSynthesisResult
} from './tts/aivisCloud.js';

export function createAivisSpeakerCatalogCache(
  load: (baseUrl: URL) => Promise<AivisSpeaker[]> = (baseUrl) =>
    loadAivisSpeakers(baseUrl),
  now: () => number = Date.now,
  ttlMs = AIVIS_SPEAKER_CACHE_TTL_MS,
): AivisSpeakerCatalogCache {
  const entries = new Map<
    string,
    { expiresAt: number; promise: Promise<AivisSpeaker[]> }
  >();
  return {
    get(baseUrl) {
      const key = baseUrl.href;
      const existing = entries.get(key);
      if (existing && existing.expiresAt > now()) return existing.promise;
      const promise = load(baseUrl)
        .then((speakers) => {
          const entry = entries.get(key);
          if (entry?.promise === promise) entry.expiresAt = now() + ttlMs;
          return speakers;
        })
        .catch((error) => {
          if (entries.get(key)?.promise === promise) entries.delete(key);
          throw error;
        });
      entries.set(key, { expiresAt: Number.POSITIVE_INFINITY, promise });
      return promise;
    },
  };
}

export function waitForSharedPromise<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

export function readAivisBaseUrl(configuredBaseUrl: string | undefined): URL {
  const value = configuredBaseUrl?.trim() || DEFAULT_AIVIS_BASE_URL;

  try {
    const baseUrl = new URL(value);
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new Error('Unsupported protocol.');
    }
    return baseUrl;
  } catch {
    throw new RequestError(
      'AIVIS_BASE_URL must be a valid HTTP or HTTPS URL.',
      503,
    );
  }
}

export function readAivisScale(
  configuredValue: string | undefined,
  variableName: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = configuredValue?.trim();
  if (!value) {
    return defaultValue;
  }

  const scale = Number(value);
  if (!Number.isFinite(scale)) {
    throw new RequestError(`${variableName} must be a finite number.`, 503);
  }
  if (scale < minimum || scale > maximum) {
    throw new RequestError(
      `${variableName} must be between ${minimum} and ${maximum}.`,
      503,
    );
  }
  return scale;
}

export function readAivisTtsSettings(config: LocalApiConfig): AivisTtsSettings {
  return {
    speedScale: readAivisScale(
      config.aivisSpeedScale,
      'AIVIS_SPEED_SCALE',
      AIVIS_VOICE_PARAMETERS.speedScale,
      0.5,
      2,
    ),
    pitchScale: readAivisScale(
      config.aivisPitchScale,
      'AIVIS_PITCH_SCALE',
      AIVIS_VOICE_PARAMETERS.pitchScale,
      -0.15,
      0.15,
    ),
    intonationScale: readAivisScale(
      config.aivisIntonationScale,
      'AIVIS_INTONATION_SCALE',
      AIVIS_VOICE_PARAMETERS.intonationScale,
      0,
      2,
    ),
    tempoDynamicsScale: readAivisScale(
      config.aivisTempoDynamicsScale,
      'AIVIS_TEMPO_DYNAMICS_SCALE',
      AIVIS_VOICE_PARAMETERS.tempoDynamicsScale,
      0,
      2,
    ),
  };
}

export function readTtsBackend(value: string | undefined): TtsBackend {
  const normalized = value?.trim().toLowerCase() || 'cloud-with-fallback';
  if (
    normalized === 'local' ||
    normalized === 'aivis-cloud' ||
    normalized === 'cloud-with-fallback'
  ) {
    return normalized;
  }
  throw new RequestError(
    'VAYRIA_TTS_BACKEND must be local, aivis-cloud, or cloud-with-fallback.',
    503,
  );
}

export function createCloudStreamError(
  result: AivisCloudSynthesisResult,
  request: IncomingMessage,
): AivisCloudError {
  if (request.aborted) {
    return new AivisCloudError(
      'aborted',
      'Aivis Cloud API synthesis was cancelled.',
    );
  }
  const timeoutKind = result.timeoutKind();
  if (timeoutKind) {
    return new AivisCloudError(
      timeoutKind,
      timeoutKind === 'first_audio_timeout'
        ? 'Aivis Cloud API did not return audio within two seconds.'
        : 'Aivis Cloud API synthesis timed out.',
    );
  }
  return new AivisCloudError(
    'provider',
    'Aivis Cloud audio streaming was interrupted.',
  );
}

export async function prepareAivisCloudAudio(
  result: AivisCloudSynthesisResult,
  request: IncomingMessage,
): Promise<PreparedAivisCloudAudio> {
  const reader = result.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        throw new AivisCloudError(
          'provider',
          'Aivis Cloud API returned an empty audio stream.',
        );
      }
      if (!value?.byteLength) continue;
      if (request.aborted || result.timeoutKind()) {
        throw createCloudStreamError(result, request);
      }
      result.markFirstAudioReceived();
      return { firstChunk: value, reader, result };
    }
  } catch (error) {
    result.dispose();
    reader.releaseLock();
    if (error instanceof AivisCloudError) throw error;
    throw createCloudStreamError(result, request);
  }
}

export async function streamAivisCloudAudio(
  prepared: PreparedAivisCloudAudio,
  request: IncomingMessage,
  response: ServerResponse,
  onFirstChunk: (audioBytes: number) => Promise<void>,
): Promise<number> {
  const { firstChunk, reader, result } = prepared;
  let audioBytes = 0;
  const abortUpstream = () => result.dispose();
  const abortOnEarlyClose = () => {
    if (!response.writableEnded) abortUpstream();
  };
  request.once('aborted', abortUpstream);
  response.once('close', abortOnEarlyClose);
  try {
    audioBytes = firstChunk.byteLength;
    await onFirstChunk(firstChunk.byteLength);
    if (!response.write(Buffer.from(firstChunk))) {
      await once(response, 'drain');
    }
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      audioBytes += value.byteLength;
      if (!response.write(Buffer.from(value))) {
        await once(response, 'drain');
      }
    }
    response.end();
    return audioBytes;
  } catch {
    throw createCloudStreamError(result, request);
  } finally {
    request.off('aborted', abortUpstream);
    response.off('close', abortOnEarlyClose);
    result.dispose();
    reader.releaseLock();
  }
}

export function createAivisUrl(
  baseUrl: URL,
  pathname: string,
  parameters?: Record<string, string>,
): URL {
  const url = new URL(pathname, baseUrl);
  for (const [name, value] of Object.entries(parameters ?? {})) {
    url.searchParams.set(name, value);
  }
  return url;
}

export function summarizeEngineError(body: string): string {
  const summary = body.replace(/\s+/g, ' ').trim();
  return summary.slice(0, 500) || '(empty response body)';
}

export async function requestAivis(
  url: URL,
  init: RequestInit,
  endpoint: string,
  styleId?: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    console.error('AivisSpeech Engine connection failed.', {
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AivisSpeechError(AIVIS_CONNECTION_ERROR);
  }

  if (!response.ok) {
    const detail = summarizeEngineError(await response.text());
    console.error('AivisSpeech Engine request failed.', {
      endpoint,
      status: response.status,
      styleId,
      detail,
    });
    throw new AivisSpeechError(
      styleId === undefined
        ? 'AivisSpeech Engine の話者情報を取得できませんでした。'
        : `AivisSpeech の音声合成に失敗しました。style ID ${styleId} が利用可能か確認してください。`,
    );
  }
  return response;
}

export async function loadAivisSpeakers(
  baseUrl: URL,
  signal?: AbortSignal,
): Promise<AivisSpeaker[]> {
  const response = await requestAivis(
    createAivisUrl(baseUrl, '/speakers'),
    { method: 'GET', signal },
    '/speakers',
  );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AivisSpeechError(
      'AivisSpeech Engine の /speakers 応答を解析できませんでした。',
    );
  }

  if (!Array.isArray(payload)) {
    throw new AivisSpeechError(
      'AivisSpeech Engine の /speakers 応答形式が正しくありません。',
    );
  }
  return payload as AivisSpeaker[];
}

export function resolveZonokoStyle(
  speakers: AivisSpeaker[],
  emotion: Emotion,
): AivisStyle {
  const zonoko = speakers.find(
    (speaker) =>
      speaker.name === ZONOKO_SPEAKER_NAME && Array.isArray(speaker.styles),
  );
  if (!zonoko) {
    throw new AivisSpeechError(
      'AivisSpeech Engine に zonoko がありません。zonoko モデルを確認してください。',
    );
  }

  const normalStyle = zonoko.styles.find(
    (style) => style.name === NORMAL_VOICE_STYLE_NAME,
  );
  if (!normalStyle) {
    throw new AivisSpeechError(
      `zonoko に ${NORMAL_VOICE_STYLE_NAME} スタイルがありません。`,
    );
  }

  const requestedName = VOICE_STYLE_BY_EMOTION[emotion];
  const requestedStyle = zonoko.styles.find(
    (style) => style.name === requestedName,
  );
  if (!requestedStyle) {
    console.warn(
      `zonoko style ${requestedName} was not found. Falling back to ${NORMAL_VOICE_STYLE_NAME}.`,
    );
  }

  return requestedStyle ?? normalStyle;
}

export async function synthesizeSpeech(
  baseUrl: URL,
  styleId: number,
  settings: AivisTtsSettings,
  text: string,
  signal?: AbortSignal,
  onStage?: (
    stage: 'audio_query_done' | 'synthesis_headers_ready' | 'synthesis_body_done',
  ) => void,
): Promise<ArrayBuffer> {
  const speaker = String(styleId);
  const audioQueryResponse = await requestAivis(
    createAivisUrl(baseUrl, '/audio_query', { text, speaker }),
    { method: 'POST', signal },
    '/audio_query',
    styleId,
  );

  let audioQuery: Record<string, unknown>;
  try {
    const payload = (await audioQueryResponse.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('AudioQuery must be a JSON object.');
    }
    audioQuery = payload as Record<string, unknown>;
    onStage?.('audio_query_done');
  } catch (error) {
    console.error('AivisSpeech Engine returned an invalid AudioQuery.', {
      styleId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AivisSpeechError(
      'AivisSpeech Engine から有効な音声合成クエリを取得できませんでした。',
    );
  }

  audioQuery.speedScale = settings.speedScale;
  audioQuery.pitchScale = settings.pitchScale;
  audioQuery.intonationScale = settings.intonationScale;
  audioQuery.tempoDynamicsScale = settings.tempoDynamicsScale;
  const synthesisResponse = await requestAivis(
    createAivisUrl(baseUrl, '/synthesis', { speaker }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(audioQuery),
      signal,
    },
    '/synthesis',
    styleId,
  );
  onStage?.('synthesis_headers_ready');
  const audio = await synthesisResponse.arrayBuffer();
  onStage?.('synthesis_body_done');
  return audio;
}

export async function synthesizeLocalSpeech(
  config: LocalApiConfig,
  emotion: Emotion,
  settings: AivisTtsSettings,
  text: string,
  signal?: AbortSignal,
  onStage?: (
    stage:
      | 'speaker_catalog_ready'
      | 'audio_query_done'
      | 'synthesis_headers_ready'
      | 'synthesis_body_done',
  ) => void,
): Promise<Buffer> {
  const baseUrl = readAivisBaseUrl(config.aivisBaseUrl);
  const speakers = config.aivisSpeakerCatalog
    ? signal
      ? await waitForSharedPromise(config.aivisSpeakerCatalog.get(baseUrl), signal)
      : await config.aivisSpeakerCatalog.get(baseUrl)
    : await loadAivisSpeakers(baseUrl, signal);
  onStage?.('speaker_catalog_ready');
  const style = resolveZonokoStyle(speakers, emotion);
  console.info('Performer TTS:', {
    emotion,
    provider: 'local',
    speaker: ZONOKO_SPEAKER_NAME,
    style: style.name,
    styleId: style.id,
  });
  return Buffer.from(
    await synthesizeSpeech(baseUrl, style.id, settings, text, signal, onStage),
  );
}

export async function reportAivisSelection(config: LocalApiConfig): Promise<void> {
  let baseUrl: URL;
  try {
    baseUrl = readAivisBaseUrl(config.aivisBaseUrl);
  } catch (error) {
    console.warn(
      error instanceof Error ? error.message : 'AIVIS_BASE_URL is invalid.',
    );
    return;
  }

  let speakers: AivisSpeaker[];
  try {
    speakers = config.aivisSpeakerCatalog
      ? await config.aivisSpeakerCatalog.get(baseUrl)
      : await loadAivisSpeakers(baseUrl);
  } catch (error) {
    console.warn(
      error instanceof AivisSpeechError ? error.userMessage : String(error),
    );
    return;
  }

  let settings: AivisTtsSettings;
  try {
    settings = readAivisTtsSettings(config);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    for (const emotion of EMOTIONS) {
      const style = resolveZonokoStyle(speakers, emotion);
      console.info('Performer AivisSpeech style:', {
        emotion,
        speaker: ZONOKO_SPEAKER_NAME,
        style: style.name,
        styleId: style.id,
        speed: settings.speedScale,
        pitch: settings.pitchScale,
        emotionalIntensity: settings.intonationScale,
        tempoDynamics: settings.tempoDynamicsScale,
      });
    }
  } catch (error) {
    console.warn(
      error instanceof AivisSpeechError ? error.userMessage : String(error),
    );
  }
}
