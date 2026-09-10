import type { IncomingMessage, ServerResponse } from 'node:http';
import { splitSpeechAtBoundaries } from '../src/conversation/cardContinuation.js';
import { performance } from 'node:perf_hooks';
import {
  classifyViewerMessageFastPath
} from '../src/performer/runtime.js';
import { generateInteractiveResponse, generateReply } from './chatGeneration.js';
import { readChatRequest } from './chatValidation.js';
import {
  type LlmProviderEvent
} from './llmProviderTelemetry.js';
import { DEFAULT_LLM_RUNTIME, RequestError, bindLlmProviderAbort, providerRequestCounts, resolveLlmProviderSource, sendJson, startNdjson, writeNdjson, type CardAssistantResponse, type LlmRequestContext, type LocalApiConfig, type StreamingReplyCallbacks } from './localApiSupport.js';
import { createRequestLlmProviderTracker, logStructuredEvent, recordStructuredEvent } from './localApiTelemetry.js';

export async function handleChatRequest(request: IncomingMessage, response: ServerResponse, config: LocalApiConfig, payload: unknown, requestId: string, headerTurnId: string | null, playcheckRunId: string | undefined): Promise<void> {
  if (!config.openAiApiKey) {
    throw new RequestError(
      'OPENAI_API_KEY is not available in the process environment. Start with `npm run dev:op` or `npm run exhibition:start:op` after configuring 1Password.',
      503,
    );
  }
  const {
    mode,
    greeting,
    message,
    characterIdentity,
    history,
    brainCardIds,
    forcedCardId,
    topic,
    topicTurns,
    viewerIntent,
    viewerTurnsSince,
    viewerEngagement,
    programContext,
    performerState,
    lastSelfUtterance,
    performanceContext,
    autonomyCandidate,
    streamSpeech,
    earlySpeechLead,
    recentExpressionLevels,
    cardContinuation,
  } = readChatRequest(payload);
  const startedAt = performance.now();
  const providerTurnId = headerTurnId ?? requestId;
  const providerSource = resolveLlmProviderSource(
    mode,
    forcedCardId,
    programContext,
  );
  const providerAbortController = new AbortController();
  const unbindProviderAbort = bindLlmProviderAbort(
    request,
    response,
    providerAbortController,
  );
  if (streamSpeech) startNdjson(response);
  const telemetry = createRequestLlmProviderTracker(config, {
    requestId,
    runId: playcheckRunId,
    turnId: providerTurnId,
    source: providerSource,
    signal: providerAbortController.signal,
    ...(streamSpeech
      ? {
        observe: (event: LlmProviderEvent) => {
          const milestone =
            event.event === 'llm_provider_start'
              ? 'start'
              : event.event === 'llm_provider_first_chunk'
                ? 'first_chunk'
                : 'done';
          writeNdjson(response, {
            type: 'provider_timing',
            milestone,
            purpose: event.purpose,
            callIndex: event.callIndex,
            retry: event.retry,
          });
        },
      }
      : {}),
  });
  const llm: LlmRequestContext = {
    apiKey: config.openAiApiKey,
    runtime: config.llmRuntime ?? DEFAULT_LLM_RUNTIME,
    signal: providerAbortController.signal,
    warmup: false,
    onFallback: (reason) => {
      void recordStructuredEvent(config, 'llm_fallback', {
        origin: 'server',
        requestId,
        runId: playcheckRunId,
        turnId: providerTurnId,
        source: providerSource,
        reason,
      });
    },
  };
  let stateRejected = false;
  let deliveryMetadataRejected = false;
  let emittedUnitCount = 0;
  const streamingCallbacks: StreamingReplyCallbacks | null = streamSpeech
    ? {
      onSpeechUnit: (_index, unit, candidate) => {
        const streamedCandidate =
          mode === 'voice'
            ? { ...candidate, interactionAction: candidate.voiceAction }
            : candidate;
        for (const text of splitSpeechAtBoundaries(unit)) {
          writeNdjson(response, { type: 'speech_unit', index: emittedUnitCount++, text, response: streamedCandidate });
        }
      },
      onStateRejected: () => {
        stateRejected = true;
      },
      onDeliveryMetadataRejected: () => {
        deliveryMetadataRejected = true;
      },
      onParserMilestone: (parserMilestone, metadata) => {
        void recordStructuredEvent(config, 'llm_parser_milestone', {
          origin: 'server',
          requestId,
          runId: playcheckRunId,
          turnId: providerTurnId,
          source: providerSource,
          parserMilestone,
          ...metadata,
        });
      },
    }
    : null;
  try {
    const fastPathDecision =
      mode === 'manual'
        ? classifyViewerMessageFastPath(message!)
        : null;
    const bypassesLlm =
      fastPathDecision !== null && fastPathDecision.action !== 'take_floor';
    if (!bypassesLlm) {
      logStructuredEvent('llm_start', {
        origin: 'server',
        requestId,
        runId: playcheckRunId,
        turnId: providerTurnId,
        source: providerSource,
        activeRequests: providerRequestCounts.active,
      });
    }
    let assistantResponse: CardAssistantResponse;
    let providerCallCount: number | null = null;
    if (mode === 'manual') {
      assistantResponse = await generateInteractiveResponse(
        llm,
        mode,
        message!,
        history,
        brainCardIds,
        forcedCardId,
        performanceContext,
        characterIdentity,
        programContext,
        telemetry,
        streamingCallbacks,
        earlySpeechLead,
        recentExpressionLevels,
        greeting,
        cardContinuation,
      );
    } else {
      const generatedResponse = await generateReply(
        llm,
        mode,
        message,
        history,
        brainCardIds,
        forcedCardId,
        topic,
        topicTurns,
        viewerIntent,
        viewerTurnsSince,
        viewerEngagement,
        performerState,
        lastSelfUtterance,
        performanceContext,
        characterIdentity,
        programContext,
        autonomyCandidate,
        telemetry,
        streamingCallbacks,
        earlySpeechLead,
        recentExpressionLevels,
        greeting,
        cardContinuation,
      );
      assistantResponse =
        mode === 'voice'
          ? {
            ...generatedResponse.response,
            interactionAction: generatedResponse.response.voiceAction,
          }
          : generatedResponse.response;
    }
    if (mode === 'manual' || mode === 'voice') {
      assistantResponse = {
        ...assistantResponse,
        internalDelta: { reasonUpdates: [] },
      };
    }
    providerCallCount = telemetry.callCount;
    if (!bypassesLlm) {
      logStructuredEvent('llm_done', {
        origin: 'server',
        requestId,
        runId: playcheckRunId,
        turnId: providerTurnId,
        source: providerSource,
        durationMs: Math.round(performance.now() - startedAt),
        ...(providerCallCount === null ? {} : { providerCallCount }),
        activeRequests: providerRequestCounts.active,
      });
    }
    if (streamSpeech) {
      if (deliveryMetadataRejected) {
        await recordStructuredEvent(config, 'delivery_metadata_rejected', {
          origin: 'server',
          requestId,
          runId: playcheckRunId,
          turnId: providerTurnId,
          source: providerSource,
          reason: 'invalid_request',
        });
      }
      if (stateRejected) {
        await recordStructuredEvent(config, 'internal_delta_rejected', {
          origin: 'server',
          requestId,
          runId: playcheckRunId,
          turnId: providerTurnId,
          source: providerSource,
          reason: 'invalid_request',
        });
      }
      writeNdjson(response, {
        type: 'state',
        internalDelta: assistantResponse.internalDelta ?? { reasonUpdates: [] },
        rejected: stateRejected,
      });
      writeNdjson(response, { type: 'done', response: assistantResponse });
      response.end();
    } else {
      sendJson(response, 200, assistantResponse);
    }
    return;
  } finally {
    unbindProviderAbort();
  }
}
