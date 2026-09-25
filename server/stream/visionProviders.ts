import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import type { StreamVisionProviderId } from '../../src/stream/streamContract.js';

const PROVIDER_TIMEOUT_MS = 60_000;

export type StreamVisionErrorKind =
  | 'configuration'
  | 'connection'
  | 'http'
  | 'incomplete'
  | 'parse'
  | 'aborted';

export class StreamVisionError extends Error {
  readonly kind: StreamVisionErrorKind;
  readonly status: number | null;

  constructor(
    kind: StreamVisionErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'StreamVisionError';
    this.kind = kind;
    this.status = options.status ?? null;
  }
}

export interface StreamVisionObserveRequest {
  instruction: string;
  schema: Record<string, unknown>;
  // A single contact-sheet image: F1..Fn frames laid out left to right
  // with burned-in labels. One image keeps ordering unambiguous for VLMs.
  image: Buffer;
  model?: string;
  signal?: AbortSignal;
}

export interface StreamVisionProviderResult {
  model: string;
  rawText: string;
  latencyMs: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

export interface StreamVisionSecrets {
  openAiApiKey?: string;
  groqApiKey?: string;
  geminiApiKey?: string;
}

export interface StreamVisionProvider {
  id: StreamVisionProviderId;
  label: string;
  defaultModel: string;
  usdPerMillionTokens: { input: number; output: number };
  apiKeyOf(secrets: StreamVisionSecrets): string | undefined;
  observe(
    request: StreamVisionObserveRequest,
    apiKey: string,
  ): Promise<StreamVisionProviderResult>;
}

function dataUrl(image: Buffer): string {
  return `data:image/jpeg;base64,${image.toString('base64')}`;
}

function timedSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const RATE_LIMIT_MAX_ATTEMPTS = 4;

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds, 60) * 1000;
  }
  return Math.min(4000 * 2 ** attempt, 45_000);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new StreamVisionError('aborted', 'Vision request was aborted.'));
      },
      { once: true },
    );
  });
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<{ payload: Record<string, unknown>; latencyMs: number }> {
  const startedAt = performance.now();
  let response: Response | null = null;
  for (let attempt = 0; attempt < RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: timedSignal(signal),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new StreamVisionError('aborted', 'Vision request was aborted.', {
          cause: error,
        });
      }
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new StreamVisionError('http', 'Vision request timed out.', {
          status: 408,
          cause: error,
        });
      }
      throw new StreamVisionError(
        'connection',
        'Vision request failed to connect.',
        { cause: error },
      );
    }
    if (response.status !== 429 || attempt === RATE_LIMIT_MAX_ATTEMPTS - 1) break;
    await sleep(retryAfterMs(response, attempt), signal);
  }
  const latencyMs = Math.round(performance.now() - startedAt);
  if (!response) {
    throw new StreamVisionError(
      'connection',
      'Vision request failed to connect.',
    );
  }
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && 'error' in payload
        ? JSON.stringify(payload.error)
        : `HTTP ${response.status}`;
    throw new StreamVisionError('http', `Vision provider rejected the request: ${detail}`, {
      status: response.status,
    });
  }
  if (!payload) {
    throw new StreamVisionError('http', 'Vision provider returned a non-JSON response.', {
      status: response.status,
    });
  }
  return { payload, latencyMs };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface ChatCompletionsResult {
  rawText: string;
  finishReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

function parseChatCompletionsPayload(
  payload: Record<string, unknown>,
): ChatCompletionsResult {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = readRecord(choices[0]);
  const message = readRecord(choice?.message);
  const rawText =
    typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content
            .map((part) =>
              typeof readRecord(part)?.text === 'string'
                ? String(readRecord(part)?.text)
                : '',
            )
            .join('')
        : '';
  const usageRecord = readRecord(payload.usage);
  return {
    rawText,
    finishReason:
      typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage: {
      inputTokens:
        readNumber(usageRecord?.prompt_tokens) ??
        readNumber(usageRecord?.input_tokens),
      outputTokens: readNumber(usageRecord?.completion_tokens),
    },
  };
}

function chatCompletionsBody(
  model: string,
  request: StreamVisionObserveRequest,
): Record<string, unknown> {
  return {
    model,
    max_completion_tokens: 1_024,
    messages: [
      { role: 'system', content: request.instruction },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'FRAME SEQUENCE (time-ordered, F1..Fn left to right):',
          },
          { type: 'image_url', image_url: { url: dataUrl(request.image) } },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'stream_observation',
        strict: true,
        schema: request.schema,
      },
    },
  };
}

async function observeOpenAiCompatible(
  url: string,
  apiKey: string,
  model: string,
  request: StreamVisionObserveRequest,
  extraBody: Record<string, unknown> = {},
): Promise<StreamVisionProviderResult> {
  const { payload, latencyMs } = await postJson(
    url,
    { Authorization: `Bearer ${apiKey}` },
    { ...chatCompletionsBody(model, request), ...extraBody },
    request.signal,
  );
  const parsed = parseChatCompletionsPayload(payload);
  if (parsed.finishReason === 'length') {
    throw new StreamVisionError(
      'incomplete',
      'Vision provider truncated the observation.',
    );
  }
  if (!parsed.rawText.trim()) {
    throw new StreamVisionError('parse', 'Vision provider returned empty content.');
  }
  return { model, rawText: parsed.rawText, latencyMs, usage: parsed.usage };
}

const GEMINI_SUPPORTED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'propertyOrdering',
  'items',
]);

function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  const record = readRecord(value);
  if (!record) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!GEMINI_SUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties') {
      const properties = readRecord(entry);
      if (properties) {
        result.properties = Object.fromEntries(
          Object.entries(properties).map(([name, prop]) => [
            name,
            toGeminiSchema(prop),
          ]),
        );
      }
      continue;
    }
    result[key] = toGeminiSchema(entry);
  }
  return result;
}

const openAiNanoProvider: StreamVisionProvider = {
  id: 'openai-nano',
  label: 'OpenAI gpt-5-nano',
  defaultModel: 'gpt-5-nano',
  usdPerMillionTokens: { input: 0.05, output: 0.4 },
  apiKeyOf: (secrets) => secrets.openAiApiKey,
  async observe(request, apiKey) {
    return observeOpenAiCompatible(
      'https://api.openai.com/v1/chat/completions',
      apiKey,
      request.model ?? this.defaultModel,
      request,
      { reasoning_effort: 'minimal' },
    );
  },
};

// Groq no longer offers a vision-capable model (the Llama 4 multimodal
// models were retired), so the second OpenAI tier is the comparison slot.
const openAiMiniProvider: StreamVisionProvider = {
  id: 'openai-mini',
  label: 'OpenAI gpt-5-mini',
  defaultModel: 'gpt-5-mini',
  usdPerMillionTokens: { input: 0.25, output: 2.0 },
  apiKeyOf: (secrets) => secrets.openAiApiKey,
  async observe(request, apiKey) {
    return observeOpenAiCompatible(
      'https://api.openai.com/v1/chat/completions',
      apiKey,
      request.model ?? this.defaultModel,
      request,
      { reasoning_effort: 'low' },
    );
  },
};

const geminiFlashLiteProvider: StreamVisionProvider = {
  id: 'gemini-flash-lite',
  label: 'Gemini 3.5 Flash-Lite',
  defaultModel: 'gemini-3.5-flash-lite',
  usdPerMillionTokens: { input: 0.1, output: 0.4 },
  apiKeyOf: (secrets) => secrets.geminiApiKey,
  async observe(request, apiKey) {
    const model = request.model ?? this.defaultModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const { payload, latencyMs } = await postJson(
      url,
      { 'x-goog-api-key': apiKey },
      {
        contents: [
          {
            role: 'user',
            parts: [
              { text: request.instruction },
              {
                text: 'FRAME SEQUENCE (time-ordered, F1..Fn left to right):',
              },
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: request.image.toString('base64'),
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(request.schema),
          maxOutputTokens: 1_024,
        },
      },
      request.signal,
    );
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const candidate = readRecord(candidates[0]);
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new StreamVisionError(
        'incomplete',
        'Vision provider truncated the observation.',
      );
    }
    const content = readRecord(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const rawText = parts
      .map((part) => {
        const text = readRecord(part)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
    if (!rawText.trim()) {
      throw new StreamVisionError(
        'parse',
        'Vision provider returned empty content.',
      );
    }
    const usage = readRecord(payload.usageMetadata);
    return {
      model,
      rawText,
      latencyMs,
      usage: {
        inputTokens: readNumber(usage?.promptTokenCount),
        outputTokens:
          readNumber(usage?.candidatesTokenCount) ??
          readNumber(usage?.totalTokenCount),
      },
    };
  },
};

export const STREAM_VISION_PROVIDERS: readonly StreamVisionProvider[] = [
  openAiNanoProvider,
  openAiMiniProvider,
  geminiFlashLiteProvider,
];

export function resolveStreamVisionProvider(
  id: string,
): StreamVisionProvider | null {
  return STREAM_VISION_PROVIDERS.find((provider) => provider.id === id) ?? null;
}
