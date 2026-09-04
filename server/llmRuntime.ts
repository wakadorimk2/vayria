import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import type { Message } from '@aituber-onair/chat';
import {
  OpenAiResponsesError,
  streamOpenAiResponse,
  type OpenAiResponseResult,
  type OpenAiServiceTier,
} from './openAiResponses.js';
import type {
  LlmExternalRequestMetadata,
  TrackLlmExternalRequest,
} from './llmProviderTelemetry.js';

const require = createRequire(import.meta.url);
const { ChatServiceFactory, MODEL_GPT_5_NANO } = require(
  '@aituber-onair/chat',
) as typeof import('@aituber-onair/chat');

export const LLM_PROFILES = [
  'nano-implicit',
  'nano-legacy',
  'luna-legacy',
  'luna-prefix',
  'luna-explicit',
] as const;
export type LlmProfile = (typeof LLM_PROFILES)[number];

export interface LlmRuntimeOptions {
  profile: LlmProfile;
  serviceTier: OpenAiServiceTier;
  fallbackEnabled: boolean;
  cacheWarmupEnabled: boolean;
}

export interface StructuredLlmRequest {
  apiKey: string;
  runtime: LlmRuntimeOptions;
  legacyPrompt: string;
  staticPrompt: string;
  dynamicPrompt: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  userMessage: string;
  output: {
    name: string;
    schema: Record<string, unknown>;
  };
  maxOutputTokens: number;
  cacheKey: string;
  signal?: AbortSignal;
  canFallback?: () => boolean;
  fallbackOnOutputLimit?: boolean;
  onFallback?: (reason: string) => void;
  onExternalRequestStart?: (externalRequestIndex: number) => void;
  onTextDelta?: (delta: string, externalRequestIndex: number) => void;
  onComplete?: (
    text: string,
    externalRequestIndex: number,
  ) => void | Promise<void>;
  trackExternalRequest?: TrackLlmExternalRequest;
}

export interface StructuredLlmResult {
  text: string;
  requestedModel: string;
  actualModel: string;
  fallbackReason: string | null;
  responses: OpenAiResponseResult | null;
  telemetry: {
    profile: LlmProfile;
    apiEndpoint: 'chat-completions' | 'responses';
    cacheMode: 'disabled' | 'implicit' | 'explicit';
    cacheKeyVersion: string;
    cacheStatus: 'disabled' | 'hit' | 'write' | 'miss';
    requestedTier: OpenAiServiceTier;
    actualTier: string;
    inputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    staticPrefixChars: number;
    dynamicContextChars: number;
    schemaBytes: number;
    historyItemCount: number;
    historyChars: number;
    requestBytes: number;
  };
}

function buildTelemetry(
  request: StructuredLlmRequest,
  responses: OpenAiResponseResult | null,
  apiEndpoint: 'chat-completions' | 'responses',
  cacheMode: StructuredLlmResult['telemetry']['cacheMode'],
): StructuredLlmResult['telemetry'] {
  const cachedTokens = responses?.usage.cachedTokens ?? 0;
  const cacheWriteTokens = responses?.usage.cacheWriteTokens ?? 0;
  const cacheStatus =
    cacheMode === 'disabled'
      ? 'disabled'
      : cachedTokens > 0
        ? 'hit'
        : cacheWriteTokens > 0
          ? 'write'
          : 'miss';
  return {
    profile: request.runtime.profile,
    apiEndpoint,
    cacheMode,
    cacheKeyVersion: request.cacheKey.split(':').at(-1) ?? 'unknown',
    cacheStatus,
    requestedTier: request.runtime.serviceTier,
    actualTier:
      responses?.serviceTier ??
      (request.runtime.serviceTier === 'fast' ? 'unknown' : 'standard'),
    inputTokens: responses?.usage.inputTokens ?? 0,
    cachedTokens,
    cacheWriteTokens,
    outputTokens: responses?.usage.outputTokens ?? 0,
    reasoningTokens: responses?.usage.reasoningTokens ?? 0,
    staticPrefixChars: Array.from(request.staticPrompt).length,
    dynamicContextChars: Array.from(request.dynamicPrompt).length,
    schemaBytes: Buffer.byteLength(JSON.stringify(request.output.schema)),
    historyItemCount: request.history.length,
    historyChars: request.history.reduce(
      (total, item) => total + Array.from(item.content).length,
      0,
    ),
    requestBytes: Buffer.byteLength(
      JSON.stringify({
        staticPrompt: request.staticPrompt,
        dynamicPrompt: request.dynamicPrompt,
        history: request.history,
        userMessage: request.userMessage,
        output: request.output,
      }),
    ),
  };
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('LLM boolean environment values must be 0 or 1.');
}

export function resolveLlmRuntimeOptions(
  values: {
    profile?: string;
    serviceTier?: string;
    fallbackEnabled?: string;
    cacheWarmupEnabled?: string;
  },
  exhibition: boolean,
): LlmRuntimeOptions {
  const profile = values.profile?.trim() || 'nano-implicit';
  if (!LLM_PROFILES.includes(profile as LlmProfile)) {
    throw new Error(`VAYRIA_LLM_PROFILE must be one of ${LLM_PROFILES.join(', ')}.`);
  }
  const serviceTier = values.serviceTier?.trim() || 'standard';
  if (serviceTier !== 'standard' && serviceTier !== 'fast') {
    throw new Error('VAYRIA_LLM_SERVICE_TIER must be standard or fast.');
  }
  return {
    profile: profile as LlmProfile,
    serviceTier,
    fallbackEnabled: readBoolean(values.fallbackEnabled, exhibition),
    cacheWarmupEnabled: readBoolean(values.cacheWarmupEnabled, exhibition),
  };
}

export function modelForProfile(profile: LlmProfile): string {
  return profile === 'nano-implicit' || profile === 'nano-legacy'
    ? String(MODEL_GPT_5_NANO)
    : 'gpt-5.6-luna';
}

function runExternalRequest<T>(
  request: StructuredLlmRequest,
  options: Parameters<TrackLlmExternalRequest>[0],
  execute: (
    markFirstChunk: () => void,
    setMetadata: (metadata: LlmExternalRequestMetadata) => void,
    externalRequestIndex: number,
  ) => Promise<T>,
): Promise<T> {
  return request.trackExternalRequest
    ? request.trackExternalRequest(options, execute)
    : execute(() => undefined, () => undefined, 1);
}

function responseExternalMetadata(
  request: StructuredLlmRequest,
  response: OpenAiResponseResult,
  cacheMode: StructuredLlmResult['telemetry']['cacheMode'],
): LlmExternalRequestMetadata {
  const cachedTokens = response.usage.cachedTokens;
  const cacheWriteTokens = response.usage.cacheWriteTokens;
  const diagnostics = response.diagnostics;
  return {
    requestedTier: request.runtime.serviceTier,
    ...(response.serviceTier ? { actualTier: response.serviceTier } : {}),
    cacheMode,
    cacheStatus:
      cacheMode === 'disabled'
        ? 'disabled'
        : cachedTokens > 0
          ? 'hit'
          : cacheWriteTokens > 0
            ? 'write'
            : 'miss',
    ...response.usage,
    ...(diagnostics.providerMaxOutputTokens === null
      ? {}
      : { providerMaxOutputTokens: diagnostics.providerMaxOutputTokens }),
    ...(diagnostics.actualModel === null
      ? {}
      : { actualModel: diagnostics.actualModel }),
    outputTextChars: diagnostics.outputTextChars,
    outputTextDeltaCount: diagnostics.outputTextDeltaCount,
    outputTextDone: diagnostics.outputTextDone,
  };
}

function runLegacyNano(request: StructuredLlmRequest): Promise<string> {
  const chat = ChatServiceFactory.createChatService('openai', {
    apiKey: request.apiKey,
    model: MODEL_GPT_5_NANO,
    responseLength: 'veryShort',
    gpt5Preset: 'casual',
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: request.output.name,
        strict: true,
        schema: request.output.schema,
      },
    },
  });
  const messages: Message[] = [
    { role: 'system', content: request.legacyPrompt },
    ...request.history,
    { role: 'user', content: request.userMessage },
  ];
  let streamed = '';
  let completed = '';
  let completedExternalRequestIndex = 0;
  return runExternalRequest(
    request,
    {
      apiEndpoint: 'chat-completions',
      model: String(MODEL_GPT_5_NANO),
      metadata: { cacheMode: 'disabled', cacheStatus: 'disabled' },
    },
    async (markFirstChunk, _setExternalMetadata, externalRequestIndex) => {
      completedExternalRequestIndex = externalRequestIndex;
      request.onExternalRequestStart?.(externalRequestIndex);
      await chat.processChat(
        messages,
        (partial) => {
          streamed += partial;
          if (partial) {
            markFirstChunk();
            request.onTextDelta?.(partial, externalRequestIndex);
          }
        },
        async (complete) => {
          completed = complete;
        },
      );
      return (completed || streamed).trim();
    },
  ).then(async (text) => {
    await request.onComplete?.(text, completedExternalRequestIndex);
    return text;
  });
}

function fallbackReason(error: OpenAiResponsesError): string {
  if (
    error.kind === 'incomplete' &&
    (error.incompleteReason === 'max_output_tokens' ||
      error.incompleteReason === 'max_tokens')
  ) {
    return 'output_limit';
  }
  if (error.kind === 'connection') return 'connection';
  if (error.status === 408) return 'timeout';
  if (error.status === 429) return 'rate_limit';
  return 'provider_error';
}

export function shouldFallbackToLegacy(
  error: unknown,
  options: {
    fallbackEnabled: boolean;
    fallbackOnOutputLimit: boolean;
    canFallback: boolean;
  },
): error is OpenAiResponsesError {
  if (
    !(error instanceof OpenAiResponsesError) ||
    !options.fallbackEnabled ||
    !options.canFallback
  ) {
    return false;
  }
  if (error.retryableAvailabilityFailure) return true;
  return (
    options.fallbackOnOutputLimit &&
    error.kind === 'incomplete' &&
    (error.incompleteReason === 'max_output_tokens' ||
      error.incompleteReason === 'max_tokens')
  );
}

export async function processStructuredLlm(
  request: StructuredLlmRequest,
): Promise<StructuredLlmResult> {
  const requestedModel = modelForProfile(request.runtime.profile);
  if (request.runtime.profile === 'nano-legacy') {
    const text = await runLegacyNano(request);
    return {
      text,
      requestedModel,
      actualModel: requestedModel,
      fallbackReason: null,
      responses: null,
      telemetry: buildTelemetry(request, null, 'chat-completions', 'disabled'),
    };
  }

  const usesStablePrefix =
    request.runtime.profile === 'nano-implicit' ||
    request.runtime.profile === 'luna-prefix' ||
    request.runtime.profile === 'luna-explicit';
  let completedExternalRequestIndex = 0;
  try {
    const cacheMode =
      request.runtime.profile === 'luna-explicit'
        ? 'explicit'
        : request.runtime.profile === 'nano-implicit'
          ? 'implicit'
          : 'disabled';
    const responses = await runExternalRequest(
      request,
      {
        apiEndpoint: 'responses',
        model: requestedModel,
        maxOutputTokens: request.maxOutputTokens,
        metadata: {
          requestedTier: request.runtime.serviceTier,
          cacheMode,
        },
      },
      async (
        markFirstChunk,
        setExternalMetadata,
        externalRequestIndex,
      ) => {
        completedExternalRequestIndex = externalRequestIndex;
        request.onExternalRequestStart?.(externalRequestIndex);
        const response = await streamOpenAiResponse({
          apiKey: request.apiKey,
          model: requestedModel,
          staticPrompt: usesStablePrefix
            ? request.staticPrompt
            : request.legacyPrompt,
          dynamicPrompt: usesStablePrefix ? request.dynamicPrompt : undefined,
          history: request.history,
          userMessage: request.userMessage,
          output: request.output,
          maxOutputTokens: request.maxOutputTokens,
          serviceTier: request.runtime.serviceTier,
          reasoningEffort:
            request.runtime.profile === 'nano-implicit' ? 'minimal' : 'none',
          ...(request.runtime.profile === 'luna-explicit'
            ? {
                cache: {
                  key: request.cacheKey,
                  mode: 'explicit' as const,
                },
              }
            : request.runtime.profile === 'nano-implicit'
              ? {
                  cache: {
                    key: request.cacheKey,
                    mode: 'implicit' as const,
                  },
                }
              : {}),
          signal: request.signal,
          onTextDelta: (delta) => {
            if (delta) markFirstChunk();
            request.onTextDelta?.(delta, externalRequestIndex);
          },
        });
        setExternalMetadata(
          responseExternalMetadata(request, response, cacheMode),
        );
        return response;
      },
    );
    await request.onComplete?.(
      responses.text,
      completedExternalRequestIndex,
    );
    return {
      text: responses.text.trim(),
      requestedModel,
      actualModel: requestedModel,
      fallbackReason: null,
      responses,
      telemetry: buildTelemetry(
        request,
        responses,
        'responses',
        cacheMode,
      ),
    };
  } catch (error) {
    if (
      !shouldFallbackToLegacy(error, {
        fallbackEnabled: request.runtime.fallbackEnabled,
        fallbackOnOutputLimit: request.fallbackOnOutputLimit === true,
        canFallback: request.canFallback?.() !== false,
      })
    ) {
      throw error;
    }
    const reason = fallbackReason(error);
    request.onFallback?.(reason);
    const text = await runLegacyNano(request);
    return {
      text,
      requestedModel,
      actualModel: String(MODEL_GPT_5_NANO),
      fallbackReason: reason,
      responses: null,
      telemetry: buildTelemetry(request, null, 'chat-completions', 'disabled'),
    };
  }
}
