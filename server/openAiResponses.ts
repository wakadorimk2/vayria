export type OpenAiServiceTier = 'standard' | 'fast';

export interface OpenAiStructuredOutput {
  name: string;
  schema: Record<string, unknown>;
}

export interface OpenAiResponseUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface OpenAiResponseDiagnostics {
  providerMaxOutputTokens: number | null;
  actualModel: string | null;
  outputTextChars: number;
  outputTextDeltaCount: number;
  outputTextDone: 0 | 1;
}

export interface OpenAiResponseResult {
  text: string;
  serviceTier: string | null;
  usage: OpenAiResponseUsage;
  diagnostics: OpenAiResponseDiagnostics;
}

export interface OpenAiResponseRequest {
  apiKey: string;
  model: string;
  staticPrompt: string;
  dynamicPrompt?: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  userMessage: string;
  output: OpenAiStructuredOutput;
  maxOutputTokens: number;
  serviceTier: OpenAiServiceTier;
  reasoningEffort: 'none' | 'minimal';
  cache?: {
    key: string;
    mode: 'implicit' | 'explicit';
  };
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type ProviderFailureKind =
  | 'aborted'
  | 'connection'
  | 'http'
  | 'incomplete'
  | 'provider';

export type OpenAiIncompleteReason =
  | 'content_filter'
  | 'max_output_tokens'
  | 'max_tokens'
  | 'unknown';

export class OpenAiResponsesError extends Error {
  readonly kind: ProviderFailureKind;
  readonly status: number | null;
  readonly incompleteReason: OpenAiIncompleteReason | null;
  readonly usage: OpenAiResponseUsage | null;
  readonly diagnostics: OpenAiResponseDiagnostics | null;
  readonly retryableAvailabilityFailure: boolean;

  constructor(
    message: string,
    options: {
      kind: ProviderFailureKind;
      status?: number;
      incompleteReason?: OpenAiIncompleteReason;
      usage?: OpenAiResponseUsage;
      diagnostics?: OpenAiResponseDiagnostics;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'OpenAiResponsesError';
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.incompleteReason = options.incompleteReason ?? null;
    this.usage = options.usage ?? null;
    this.diagnostics = options.diagnostics ?? null;
    this.retryableAvailabilityFailure =
      options.kind === 'connection' ||
      (options.kind === 'http' &&
        (options.status === 408 ||
          options.status === 429 ||
          (options.status !== undefined && options.status >= 500)));
  }
}

function readIncompleteReason(
  response: Record<string, unknown> | null,
): OpenAiIncompleteReason {
  const details = readRecord(response?.incomplete_details);
  const reason = details?.reason;
  return reason === 'content_filter' ||
    reason === 'max_output_tokens' ||
    reason === 'max_tokens'
    ? reason
    : 'unknown';
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readUsage(response: Record<string, unknown>): OpenAiResponseUsage {
  const usage =
    response.usage && typeof response.usage === 'object'
      ? (response.usage as Record<string, unknown>)
      : {};
  const inputDetails =
    usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
      ? (usage.input_tokens_details as Record<string, unknown>)
      : {};
  const outputDetails =
    usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
      ? (usage.output_tokens_details as Record<string, unknown>)
      : {};
  return {
    inputTokens: numberOrZero(usage.input_tokens),
    cachedTokens: numberOrZero(inputDetails.cached_tokens),
    cacheWriteTokens: numberOrZero(
      inputDetails.cache_write_tokens ?? usage.cache_write_tokens,
    ),
    outputTokens: numberOrZero(usage.output_tokens),
    reasoningTokens: numberOrZero(outputDetails.reasoning_tokens),
  };
}

function readProviderMaxOutputTokens(
  response: Record<string, unknown>,
): number | null {
  const value = response.max_output_tokens;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function readActualModel(response: Record<string, unknown>): string | null {
  const value = response.model;
  return typeof value === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
    ? value
    : null;
}

function buildDiagnostics(
  response: Record<string, unknown>,
  text: string,
  outputTextDeltaCount: number,
  outputTextDone: boolean,
): OpenAiResponseDiagnostics {
  return {
    providerMaxOutputTokens: readProviderMaxOutputTokens(response),
    actualModel: readActualModel(response),
    outputTextChars: Array.from(text).length,
    outputTextDeltaCount,
    outputTextDone: outputTextDone ? 1 : 0,
  };
}

function combineAbortSignals(
  source: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromSource = (): void => controller.abort(source?.reason);
  if (source?.aborted) abortFromSource();
  else source?.addEventListener('abort', abortFromSource, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException('timeout', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      source?.removeEventListener('abort', abortFromSource);
    },
  };
}

function buildInput(request: OpenAiResponseRequest): unknown[] {
  const staticContent: Record<string, unknown> = {
    type: 'input_text',
    text: request.staticPrompt,
  };
  if (request.cache?.mode === 'explicit') {
    staticContent.prompt_cache_breakpoint = { mode: 'explicit' };
  }
  return [
    {
      role: 'developer',
      content: [staticContent],
    },
    ...(request.dynamicPrompt
      ? [
          {
            role: 'developer',
            content: [{ type: 'input_text', text: request.dynamicPrompt }],
          },
        ]
      : []),
    ...request.history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    {
      role: 'user',
      content: [{ type: 'input_text', text: request.userMessage }],
    },
  ];
}

export function buildOpenAiResponsesBody(
  request: OpenAiResponseRequest,
): Record<string, unknown> {
  return {
    model: request.model,
    stream: true,
    store: false,
    reasoning: { effort: request.reasoningEffort },
    max_output_tokens: request.maxOutputTokens,
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: request.output.name,
        strict: true,
        schema: request.output.schema,
      },
    },
    input: buildInput(request),
    service_tier: request.serviceTier === 'fast' ? 'fast' : 'default',
    ...(request.cache
      ? {
          prompt_cache_key: request.cache.key,
          ...(request.cache.mode === 'explicit'
            ? {
                prompt_cache_options: { mode: 'explicit', ttl: '30m' },
              }
            : {}),
        }
      : {}),
  };
}

interface ParsedSseEvent {
  event: string | null;
  data: string;
}

function readSseEvent(block: string): ParsedSseEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function streamOpenAiResponse(
  request: OpenAiResponseRequest,
): Promise<OpenAiResponseResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const abort = combineAbortSignals(request.signal, request.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildOpenAiResponsesBody(request)),
      signal: abort.signal,
    });
  } catch (error) {
    abort.cleanup();
    if (abort.signal.aborted && request.signal?.aborted) {
      throw new OpenAiResponsesError('The Responses request was aborted.', {
        kind: 'aborted',
        cause: error,
      });
    }
    throw new OpenAiResponsesError('The Responses request could not connect.', {
      kind: 'connection',
      cause: error,
    });
  }

  if (!response.ok) {
    abort.cleanup();
    try {
      await response.body?.cancel();
    } catch {
      // Ignore cleanup failures after the provider rejected the request.
    }
    throw new OpenAiResponsesError(
      `The Responses request failed with HTTP ${response.status}.`,
      { kind: 'http', status: response.status },
    );
  }
  if (!response.body) {
    abort.cleanup();
    throw new OpenAiResponsesError('The Responses stream has no body.', {
      kind: 'provider',
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let outputTextDeltaCount = 0;
  let outputTextDone = false;
  let completed: Record<string, unknown> | null = null;
  const consume = (block: string): void => {
    const event = readSseEvent(block);
    if (!event || event.data === '[DONE]') return;
    let parsed: Record<string, unknown> | null;
    try {
      parsed = readRecord(JSON.parse(event.data));
    } catch {
      throw new OpenAiResponsesError('The Responses stream returned invalid SSE JSON.', {
        kind: 'provider',
      });
    }
    if (!parsed) return;
    const eventType =
      typeof parsed.type === 'string' ? parsed.type : event.event;
    if (eventType === 'response.output_text.delta') {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : '';
      if (delta) {
        text += delta;
        outputTextDeltaCount += 1;
        request.onTextDelta?.(delta);
      }
      return;
    }
    if (eventType === 'response.output_text.done') {
      outputTextDone = true;
      return;
    }
    if (eventType === 'response.completed') {
      completed = readRecord(parsed.response);
      return;
    }
    if (eventType === 'response.incomplete') {
      const incompleteResponse = readRecord(parsed.response);
      throw new OpenAiResponsesError('The Responses request was incomplete.', {
        kind: 'incomplete',
        incompleteReason: readIncompleteReason(incompleteResponse),
        usage: readUsage(incompleteResponse ?? {}),
        diagnostics: buildDiagnostics(
          incompleteResponse ?? {},
          text,
          outputTextDeltaCount,
          outputTextDone,
        ),
      });
    }
    if (eventType === 'response.failed' || eventType === 'error') {
      throw new OpenAiResponsesError('The Responses provider reported a failure.', {
        kind: 'provider',
      });
    }
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/u.exec(buffer);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consume(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } catch (error) {
    if (error instanceof OpenAiResponsesError) throw error;
    if (abort.signal.aborted && request.signal?.aborted) {
      throw new OpenAiResponsesError('The Responses request was aborted.', {
        kind: 'aborted',
        cause: error,
      });
    }
    throw new OpenAiResponsesError('The Responses stream was interrupted.', {
      kind: 'connection',
      cause: error,
    });
  } finally {
    abort.cleanup();
    reader.releaseLock();
  }

  if (!completed) {
    throw new OpenAiResponsesError('The Responses stream ended before completion.', {
      kind: 'incomplete',
    });
  }
  const finalResponse = completed as Record<string, unknown>;
  return {
    text,
    serviceTier:
      typeof finalResponse.service_tier === 'string'
        ? finalResponse.service_tier
        : null,
    usage: readUsage(finalResponse),
    diagnostics: buildDiagnostics(
      finalResponse,
      text,
      outputTextDeltaCount,
      outputTextDone,
    ),
  };
}
