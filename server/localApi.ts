import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';
import {
  AIVIS_VOICE_PARAMETERS,
  EMOTIONS,
  VOICE_STYLE_BY_EMOTION,
  ZONOKO_SPEAKER_NAME,
  normalizeEmotion,
  type AssistantResponse,
  type Emotion,
} from '../src/character/emotion';

const require = createRequire(import.meta.url);
const { ChatServiceFactory, MODEL_GPT_5_NANO } = require(
  '@aituber-onair/chat',
) as typeof import('@aituber-onair/chat');

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_TEXT_LENGTH = 1_000;
const CHAT_PATH = '/api/chat';
const TTS_PATH = '/api/tts';
const DEFAULT_AIVIS_BASE_URL = 'http://127.0.0.1:10101';
const AIVIS_CONNECTION_ERROR =
  'AivisSpeech Engine に接続できません。AivisSpeech を起動しているか確認してください。';
const NORMAL_VOICE_STYLE_NAME = VOICE_STYLE_BY_EMOTION.neutral;

interface LocalApiConfig {
  openAiApiKey?: string;
  aivisBaseUrl?: string;
}

interface AivisStyle {
  id: number;
  name: string;
}

interface AivisSpeaker {
  name: string;
  styles: AivisStyle[];
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

class AivisSpeechError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: object,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new RequestError('Request body is too large.', 400);
    }
    chunks.push(buffer);
  }

  try {
    const body = Buffer.concat(chunks).toString('utf8');
    return body ? JSON.parse(body) : {};
  } catch {
    throw new RequestError('Request body must be valid JSON.', 400);
  }
}

function readTextField(payload: unknown, field: 'message' | 'text'): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError('Request body must be a JSON object.', 400);
  }

  const record = payload as Record<string, unknown>;
  const allowedKeys = Object.keys(record);
  if (allowedKeys.length !== 1 || allowedKeys[0] !== field) {
    throw new RequestError(`Request body must contain only ${field}.`, 400);
  }

  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new RequestError(`${field} must be non-empty text.`, 400);
  }

  const normalized = value.trim();
  if (normalized.length > MAX_TEXT_LENGTH) {
    throw new RequestError(
      `${field} must be ${MAX_TEXT_LENGTH} characters or fewer.`,
      400,
    );
  }

  return normalized;
}

function readTtsRequest(payload: unknown): {
  text: string;
  emotion: Emotion;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError('Request body must be a JSON object.', 400);
  }

  const record = payload as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'text' && key !== 'emotion')) {
    throw new RequestError(
      'Request body may contain only text and emotion.',
      400,
    );
  }

  const text = record.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new RequestError('text must be non-empty text.', 400);
  }
  const normalizedText = text.trim();
  if (normalizedText.length > MAX_TEXT_LENGTH) {
    throw new RequestError(
      `text must be ${MAX_TEXT_LENGTH} characters or fewer.`,
      400,
    );
  }

  return {
    text: normalizedText,
    emotion: normalizeEmotion(record.emotion),
  };
}

function parseAssistantResponse(value: string): AssistantResponse {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error('The chat provider returned invalid JSON.');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('The chat provider returned an invalid response object.');
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.text !== 'string' || !record.text.trim()) {
    throw new Error('The chat provider returned empty response text.');
  }

  const text = record.text.trim();
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error('The chat provider returned response text that is too long.');
  }

  return {
    text,
    emotion: normalizeEmotion(record.emotion),
  };
}

async function generateReply(
  apiKey: string,
  message: string,
): Promise<AssistantResponse> {
  const chat = ChatServiceFactory.createChatService('openai', {
    apiKey,
    model: MODEL_GPT_5_NANO,
    responseLength: 'veryShort',
    gpt5Preset: 'casual',
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'wildcard_assistant_response',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            emotion: {
              type: 'string',
              enum: EMOTIONS,
            },
          },
          required: ['text', 'emotion'],
          additionalProperties: false,
        },
      },
    },
  });
  let streamedReply = '';
  let completedReply = '';

  await chat.processChat(
    [
      {
        role: 'system',
        content:
          "Reply in the same language as the user with one or two short sentences and no Markdown. Choose emotion as the character's own feeling while replying. Prefer neutral when ambiguous and avoid exaggerated changes. neutral is normal, fun is mildly upbeat, joy is clearly happy, sorrow is sad or lonely, angry is displeased or strongly rejecting, and surprised is clearly surprised.",
      },
      { role: 'user', content: message },
    ],
    (partial) => {
      streamedReply += partial;
    },
    async (complete) => {
      completedReply = complete;
    },
  );

  const responseText = (completedReply || streamedReply).trim();
  if (!responseText) {
    throw new Error('The chat provider returned an empty reply.');
  }
  return parseAssistantResponse(responseText);
}

function readAivisBaseUrl(configuredBaseUrl: string | undefined): URL {
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

function createAivisUrl(
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

function summarizeEngineError(body: string): string {
  const summary = body.replace(/\s+/g, ' ').trim();
  return summary.slice(0, 500) || '(empty response body)';
}

async function requestAivis(
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

async function loadAivisSpeakers(baseUrl: URL): Promise<AivisSpeaker[]> {
  const response = await requestAivis(
    createAivisUrl(baseUrl, '/speakers'),
    { method: 'GET' },
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

function resolveZonokoStyle(
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

async function synthesizeSpeech(
  baseUrl: URL,
  styleId: number,
  text: string,
): Promise<ArrayBuffer> {
  const speaker = String(styleId);
  const audioQueryResponse = await requestAivis(
    createAivisUrl(baseUrl, '/audio_query', { text, speaker }),
    { method: 'POST' },
    '/audio_query',
    styleId,
  );

  let audioQuery: Record<string, unknown>;
  try {
    const payload = (await audioQueryResponse.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('AudioQuery must be an object.');
    }
    audioQuery = payload as Record<string, unknown>;
  } catch {
    throw new AivisSpeechError(
      'AivisSpeech Engine の AudioQuery 応答を解析できませんでした。',
    );
  }
  Object.assign(audioQuery, AIVIS_VOICE_PARAMETERS);
  const synthesisResponse = await requestAivis(
    createAivisUrl(baseUrl, '/synthesis', { speaker }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(audioQuery),
    },
    '/synthesis',
    styleId,
  );
  return synthesisResponse.arrayBuffer();
}

async function reportAivisSelection(config: LocalApiConfig): Promise<void> {
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
    speakers = await loadAivisSpeakers(baseUrl);
  } catch (error) {
    console.warn(
      error instanceof AivisSpeechError ? error.userMessage : String(error),
    );
    return;
  }

  try {
    for (const emotion of EMOTIONS) {
      const style = resolveZonokoStyle(speakers, emotion);
      console.info('Wildcard AivisSpeech style:', {
        emotion,
        speaker: ZONOKO_SPEAKER_NAME,
        style: style.name,
        styleId: style.id,
      });
    }
  } catch (error) {
    console.warn(
      error instanceof AivisSpeechError ? error.userMessage : String(error),
    );
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: LocalApiConfig,
): Promise<void> {
  const pathname = new URL(
    request.url ?? '/',
    'http://127.0.0.1',
  ).pathname;

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  try {
    const payload = await readJsonBody(request);

    if (pathname === CHAT_PATH) {
      if (!config.openAiApiKey) {
        throw new RequestError(
          'OPENAI_API_KEY is not configured in .env.local.',
          503,
        );
      }
      const message = readTextField(payload, 'message');
      const assistantResponse = await generateReply(
        config.openAiApiKey,
        message,
      );
      sendJson(response, 200, assistantResponse);
      return;
    }

    const { text, emotion } = readTtsRequest(payload);
    const baseUrl = readAivisBaseUrl(config.aivisBaseUrl);
    const speakers = await loadAivisSpeakers(baseUrl);
    const style = resolveZonokoStyle(speakers, emotion);
    console.info('Wildcard TTS:', {
      emotion,
      speaker: ZONOKO_SPEAKER_NAME,
      style: style.name,
      styleId: style.id,
    });
    const audio = Buffer.from(await synthesizeSpeech(baseUrl, style.id, text));
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': audio.byteLength,
      'Content-Type': 'audio/wav',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(audio);
  } catch (error) {
    if (error instanceof RequestError) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }

    if (error instanceof AivisSpeechError) {
      sendJson(response, 502, { error: error.userMessage });
      return;
    }

    console.error(
      pathname === CHAT_PATH
        ? 'Local chat provider request failed.'
        : 'Local TTS provider request failed.',
      error,
    );
    sendJson(response, 502, {
      error:
        pathname === CHAT_PATH
          ? 'The chat provider request failed.'
          : 'The TTS provider request failed.',
    });
  }
}

export function localApiPlugin(config: LocalApiConfig): Plugin {
  return {
    name: 'wildcard-local-api',
    configureServer(server) {
      void reportAivisSelection(config);
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(
          request.url ?? '/',
          'http://127.0.0.1',
        ).pathname;
        if (pathname !== CHAT_PATH && pathname !== TTS_PATH) {
          next();
          return;
        }

        void handleRequest(request, response, config);
      });
    },
  };
}
