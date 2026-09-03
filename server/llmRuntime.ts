import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import type { Message } from '@aituber-onair/chat';
import {
  OpenAiResponsesError,
  streamOpenAiResponse,
  type OpenAiResponseResult,
  type OpenAiServiceTier,
} from './openAiResponses.js';

const require = createRequire(import.meta.url);
const { ChatServiceFactory, MODEL_GPT_5_NANO } = require(
  '@aituber-onair/chat',
) as typeof import('@aituber-onair/chat');

export const LLM_PROFILES = [
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
  onFallback?: (reason: string) => void;
  onTextDelta?: (delta: string) => void;
  onComplete?: (text: string) => void | Promise<void>;
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
    cacheMode: 'disabled' | 'explicit';
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
): StructuredLlmResult['telemetry'] {
  const cacheMode =
    request.runtime.profile === 'luna-explicit' ? 'explicit' : 'disabled';
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
  const profile = values.profile?.trim() || 'luna-explicit';
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
  return profile === 'nano-legacy' ? String(MODEL_GPT_5_NANO) : 'gpt-5.6-luna';
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
  return chat
    .processChat(
      messages,
      (partial) => {
        streamed += partial;
        if (partial) request.onTextDelta?.(partial);
      },
      async (complete) => {
        completed = complete;
        await request.onComplete?.(complete);
      },
    )
    .then(() => (completed || streamed).trim());
}

function fallbackReason(error: OpenAiResponsesError): string {
  if (error.kind === 'connection') return 'connection';
  if (error.status === 408) return 'timeout';
  if (error.status === 429) return 'rate_limit';
  return 'provider_error';
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
      telemetry: buildTelemetry(request, null, 'chat-completions'),
    };
  }

  const usesStablePrefix =
    request.runtime.profile === 'luna-prefix' ||
    request.runtime.profile === 'luna-explicit';
  try {
    const responses = await streamOpenAiResponse({
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
      ...(request.runtime.profile === 'luna-explicit'
        ? {
            cache: {
              key: request.cacheKey,
              explicitBreakpoint: true,
            },
          }
        : {}),
      signal: request.signal,
      onTextDelta: request.onTextDelta,
    });
    await request.onComplete?.(responses.text);
    return {
      text: responses.text.trim(),
      requestedModel,
      actualModel: requestedModel,
      fallbackReason: null,
      responses,
      telemetry: buildTelemetry(request, responses, 'responses'),
    };
  } catch (error) {
    if (
      !(error instanceof OpenAiResponsesError) ||
      !error.retryableAvailabilityFailure ||
      !request.runtime.fallbackEnabled ||
      request.canFallback?.() === false
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
      telemetry: buildTelemetry(request, null, 'responses'),
    };
  }
}
