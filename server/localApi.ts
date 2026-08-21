import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';
import type { Message } from '@aituber-onair/chat';
import {
  AIVIS_VOICE_PARAMETERS,
  EMOTIONS,
  VOICE_STYLE_BY_EMOTION,
  ZONOKO_SPEAKER_NAME,
  normalizeEmotion,
  type AssistantResponse,
  type Emotion,
} from '../src/character/emotion';
import { cardPool } from '../src/cards/cardPool';
import type { WildcardCardData } from '../src/cards/cardTypes';

const require = createRequire(import.meta.url);
const { ChatServiceFactory, MODEL_GPT_5_NANO } = require(
  '@aituber-onair/chat',
) as typeof import('@aituber-onair/chat');

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_TEXT_LENGTH = 1_000;
const MAX_HISTORY_ITEMS = 10;
const CHAT_PATH = '/api/chat';
const TTS_PATH = '/api/tts';
const DEFAULT_AIVIS_BASE_URL = 'http://127.0.0.1:10101';
const AIVIS_CONNECTION_ERROR =
  'AivisSpeech Engine に接続できません。AivisSpeech を起動しているか確認してください。';
const NORMAL_VOICE_STYLE_NAME = VOICE_STYLE_BY_EMOTION.neutral;
const BRAIN_CARD_COUNT = 5;
const MAX_ACTIVATED_CARDS = 3;
const CARD_IDS = cardPool.map((card) => card.id);
const CARD_BY_ID: ReadonlyMap<string, WildcardCardData> = new Map(
  cardPool.map((card) => [card.id, card]),
);

interface LocalApiConfig {
  openAiApiKey?: string;
  aivisBaseUrl?: string;
  aivisSpeedScale?: string;
  aivisPitchScale?: string;
  aivisIntonationScale?: string;
  aivisTempoDynamicsScale?: string;
}

interface AivisTtsSettings {
  speedScale: number;
  pitchScale: number;
  intonationScale: number;
  tempoDynamicsScale: number;
}

interface AivisStyle {
  id: number;
  name: string;
}

type ChatMode = 'manual' | 'autonomous';

interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequestPayload {
  mode: ChatMode;
  message: string | null;
  history: ChatHistoryItem[];
  brainCardIds: string[];
  forcedCardId: string | null;
}

interface CardAssistantResponse extends AssistantResponse {
  activatedCards: string[];
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

class CardContractError extends Error {}

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

function readChatRequest(payload: unknown): ChatRequestPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RequestError('Request body must be a JSON object.', 400);
  }

  const record = payload as Record<string, unknown>;
  const allowedKeys = new Set([
    'mode',
    'message',
    'history',
    'brainCardIds',
    'forcedCardId',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new RequestError(
      'Request body contains an unsupported chat field.',
      400,
    );
  }

  const mode = record.mode;
  if (mode !== 'manual' && mode !== 'autonomous') {
    throw new RequestError('mode must be manual or autonomous.', 400);
  }

  const message = record.message;
  let normalizedMessage: string | null = null;
  if (mode === 'manual') {
    if (typeof message !== 'string' || !message.trim()) {
      throw new RequestError('manual message must be non-empty text.', 400);
    }
    normalizedMessage = message.trim();
    if (normalizedMessage.length > MAX_TEXT_LENGTH) {
      throw new RequestError(
        `message must be ${MAX_TEXT_LENGTH} characters or fewer.`,
        400,
      );
    }
  } else if (message !== undefined) {
    throw new RequestError(
      'autonomous requests must not contain message.',
      400,
    );
  }

  const history = record.history;
  if (!Array.isArray(history) || history.length > MAX_HISTORY_ITEMS) {
    throw new RequestError(
      `history must contain at most ${MAX_HISTORY_ITEMS} items.`,
      400,
    );
  }
  const normalizedHistory = history.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new RequestError('history items must be objects.', 400);
    }
    const historyItem = item as Record<string, unknown>;
    if (
      Object.keys(historyItem).length !== 2 ||
      (historyItem.role !== 'user' && historyItem.role !== 'assistant') ||
      typeof historyItem.content !== 'string' ||
      !historyItem.content.trim()
    ) {
      throw new RequestError('history item format is invalid.', 400);
    }
    const content = historyItem.content.trim();
    if (content.length > MAX_TEXT_LENGTH) {
      throw new RequestError(
        `history content must be ${MAX_TEXT_LENGTH} characters or fewer.`,
        400,
      );
    }
    return { role: historyItem.role, content } as ChatHistoryItem;
  });

  const brainCardIds = record.brainCardIds;
  if (
    !Array.isArray(brainCardIds) ||
    brainCardIds.length !== BRAIN_CARD_COUNT ||
    !brainCardIds.every((id): id is string => typeof id === 'string')
  ) {
    throw new RequestError(
      `brainCardIds must contain exactly ${BRAIN_CARD_COUNT} card IDs.`,
      400,
    );
  }
  if (new Set(brainCardIds).size !== BRAIN_CARD_COUNT) {
    throw new RequestError('brainCardIds must not contain duplicates.', 400);
  }
  if (brainCardIds.some((id) => !CARD_BY_ID.has(id))) {
    throw new RequestError('brainCardIds contains an unknown card ID.', 400);
  }

  const forcedCardId = record.forcedCardId;
  if (forcedCardId !== null && typeof forcedCardId !== 'string') {
    throw new RequestError('forcedCardId must be a card ID or null.', 400);
  }
  if (forcedCardId !== null && !brainCardIds.includes(forcedCardId)) {
    throw new RequestError(
      'forcedCardId must be one of the current brainCardIds.',
      400,
    );
  }

  return {
    mode,
    message: normalizedMessage,
    history: normalizedHistory,
    brainCardIds,
    forcedCardId,
  };
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

function parseAssistantResponse(
  value: string,
  brainCardIds: readonly string[],
  forcedCardId: string | null,
): CardAssistantResponse {
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

  const activatedCards = record.activatedCards;
  if (
    !Array.isArray(activatedCards) ||
    activatedCards.length < 1 ||
    activatedCards.length > MAX_ACTIVATED_CARDS ||
    !activatedCards.every((id): id is string => typeof id === 'string')
  ) {
    throw new CardContractError(
      `activatedCards must contain 1 to ${MAX_ACTIVATED_CARDS} card IDs.`,
    );
  }
  if (new Set(activatedCards).size !== activatedCards.length) {
    throw new CardContractError('activatedCards must not contain duplicates.');
  }
  if (activatedCards.some((id) => !brainCardIds.includes(id))) {
    throw new CardContractError(
      'activatedCards must be a subset of the current brain cards.',
    );
  }
  if (forcedCardId && !activatedCards.includes(forcedCardId)) {
    throw new CardContractError(
      'activatedCards must include the forced card.',
    );
  }

  return {
    text,
    emotion: normalizeEmotion(record.emotion),
    activatedCards,
  };
}

async function generateReply(
  apiKey: string,
  mode: ChatMode,
  message: string | null,
  history: readonly ChatHistoryItem[],
  brainCardIds: readonly string[],
  forcedCardId: string | null,
): Promise<CardAssistantResponse> {
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
            activatedCards: {
              type: 'array',
              items: {
                type: 'string',
                enum: CARD_IDS,
              },
              minItems: 1,
              maxItems: MAX_ACTIVATED_CARDS,
            },
          },
          required: ['text', 'emotion', 'activatedCards'],
          additionalProperties: false,
        },
      },
    },
  });
  const brainCards = brainCardIds.map((id) => CARD_BY_ID.get(id)!);
  const cardInstructions = brainCards
    .map((card) => `- ${card.id} (${card.label}): ${card.prompt}`)
    .join('\n');
  const forcedInstruction = forcedCardId
    ? `The card ${forcedCardId} is forced for this reply. It must visibly influence the reply, and activatedCards must include ${forcedCardId}.`
    : 'No card is forced for this reply.';
  const responseInstruction =
    mode === 'autonomous'
      ? 'You are not replying to the user. As a Japanese AI Tuber filling a natural pause in a live stream, say one or two short Japanese sentences of about 20 to 80 characters with no Markdown. Use a passing thought, light topic, or quiet observation. Do not give a lecture, act like an AI assistant, or ask the viewer a question every time.'
      : "Reply in the same language as the user with one or two short sentences and no Markdown.";
  const systemPrompt = [
    `${responseInstruction} Choose emotion as the character's own feeling while speaking. Prefer neutral when ambiguous and avoid exaggerated changes. neutral is normal, fun is mildly upbeat, joy is clearly happy, sorrow is sad or lonely, angry is displeased or strongly rejecting, and surprised is clearly surprised.`,
    'The character has the following five brain cards:',
    cardInstructions,
    'Let one or two natural cards influence the reply. Do not force all five cards into it. You may use up to three cards when a combination is natural.',
    forcedInstruction,
    'Return only card IDs from the current five cards in activatedCards. List every card that actually influenced the reply.',
  ].join('\n');

  const requestReply = async (correction?: string): Promise<string> => {
    let streamedReply = '';
    let completedReply = '';
    const messages: Message[] = [
      {
        role: 'system',
        content: correction ? `${systemPrompt}\n${correction}` : systemPrompt,
      },
      ...history,
      {
        role: 'user',
        content:
          mode === 'autonomous'
            ? '配信中の次の自然な独り言を生成してください。'
            : (message ?? ''),
      },
    ];
    await chat.processChat(
      messages,
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
    return responseText;
  };

  try {
    return parseAssistantResponse(
      await requestReply(),
      brainCardIds,
      forcedCardId,
    );
  } catch (error) {
    if (!(error instanceof CardContractError)) throw error;
    console.warn('Chat card contract failed. Retrying once.', error.message);
  }

  return parseAssistantResponse(
    await requestReply(
      'Your previous attempt violated the card contract. Follow the current brain-card subset and forced-card requirements exactly.',
    ),
    brainCardIds,
    forcedCardId,
  );
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

function readAivisScale(
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

function readAivisTtsSettings(config: LocalApiConfig): AivisTtsSettings {
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
  settings: AivisTtsSettings,
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
      throw new Error('AudioQuery must be a JSON object.');
    }
    audioQuery = payload as Record<string, unknown>;
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
      console.info('Wildcard AivisSpeech style:', {
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
      const { mode, message, history, brainCardIds, forcedCardId } =
        readChatRequest(payload);
      const assistantResponse = await generateReply(
        config.openAiApiKey,
        mode,
        message,
        history,
        brainCardIds,
        forcedCardId,
      );
      sendJson(response, 200, assistantResponse);
      return;
    }

    const { text, emotion } = readTtsRequest(payload);
    const baseUrl = readAivisBaseUrl(config.aivisBaseUrl);
    const settings = readAivisTtsSettings(config);
    const speakers = await loadAivisSpeakers(baseUrl);
    const style = resolveZonokoStyle(speakers, emotion);
    console.info('Wildcard TTS:', {
      emotion,
      speaker: ZONOKO_SPEAKER_NAME,
      style: style.name,
      styleId: style.id,
    });
    const audio = Buffer.from(
      await synthesizeSpeech(baseUrl, style.id, settings, text),
    );
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
