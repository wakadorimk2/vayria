import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const { ChatServiceFactory, MODEL_GPT_5_NANO } = require(
  '@aituber-onair/chat',
) as typeof import('@aituber-onair/chat');
const { VoiceEngineAdapter } = require(
  '@aituber-onair/voice',
) as typeof import('@aituber-onair/voice');

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_TEXT_LENGTH = 1_000;
const CHAT_PATH = '/api/chat';
const TTS_PATH = '/api/tts';

class RequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
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

async function generateReply(apiKey: string, message: string): Promise<string> {
  const chat = ChatServiceFactory.createChatService('openai', {
    apiKey,
    model: MODEL_GPT_5_NANO,
    responseLength: 'veryShort',
    gpt5Preset: 'casual',
  });
  let streamedReply = '';
  let completedReply = '';

  await chat.processChat(
    [
      {
        role: 'system',
        content:
          'Reply in the same language as the user. Use one or two short sentences. Do not use Markdown or emotion tags.',
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

  const reply = (completedReply || streamedReply).trim();
  if (!reply) {
    throw new Error('The chat provider returned an empty reply.');
  }
  return reply;
}

async function synthesizeSpeech(
  apiKey: string,
  text: string,
): Promise<ArrayBuffer> {
  let generatedAudio: ArrayBuffer | undefined;
  const voice = new VoiceEngineAdapter({
    engineType: 'openai',
    apiKey,
    speaker: 'alloy',
    openAiModel: 'gpt-4o-mini-tts',
    onPlay: async (audioBuffer) => {
      generatedAudio = audioBuffer;
    },
  });

  await voice.speakText(text);
  if (!generatedAudio) {
    throw new Error('The voice provider returned no audio.');
  }
  return generatedAudio;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  apiKey: string | undefined,
): Promise<void> {
  const pathname = new URL(
    request.url ?? '/',
    'http://127.0.0.1',
  ).pathname;

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  if (!apiKey) {
    sendJson(response, 503, {
      error: 'OPENAI_API_KEY is not configured in .env.local.',
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);

    if (pathname === CHAT_PATH) {
      const message = readTextField(payload, 'message');
      const reply = await generateReply(apiKey, message);
      sendJson(response, 200, { reply });
      return;
    }

    const text = readTextField(payload, 'text');
    const audio = Buffer.from(await synthesizeSpeech(apiKey, text));
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': audio.byteLength,
      'Content-Type': 'audio/mpeg',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(audio);
  } catch (error) {
    if (error instanceof RequestError) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }

    console.error(
      pathname === CHAT_PATH
        ? 'Local chat provider request failed.'
        : 'Local TTS provider request failed.',
    );
    sendJson(response, 502, {
      error:
        pathname === CHAT_PATH
          ? 'The chat provider request failed.'
          : 'The TTS provider request failed.',
    });
  }
}

export function localApiPlugin(apiKey: string | undefined): Plugin {
  return {
    name: 'wildcard-local-api',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(
          request.url ?? '/',
          'http://127.0.0.1',
        ).pathname;
        if (pathname !== CHAT_PATH && pathname !== TTS_PATH) {
          next();
          return;
        }

        void handleRequest(request, response, apiKey);
      });
    },
  };
}
