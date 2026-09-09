import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Plugin } from 'vite';
import {
  type AssistantResponse
} from '../src/character/emotion.js';
import type {
  NetworkAvailability
} from '../src/networkState.js';
import { generateCardPreviewReply, warmInteractiveLlmCache } from './chatGeneration.js';
import { handleChatRequest } from './chatHandler.js';
import { readCardPreviewRequest, readConversationEvent } from './chatValidation.js';
import {
  createExhibitionCapture
} from './exhibitionCaptureStore.js';
import { AivisSpeechError, CARD_PREVIEW_PATH, CHAT_PATH, DEFAULT_LLM_RUNTIME, EVENTS_PATH, HEALTH_PATH, ROUTER_EVENTS_PATH, RequestError, TTS_PATH, VOICE_LAB_EVENTS_PATH, bindLlmProviderAbort, createHealthResponse, providerRequestCounts, readJsonBody, readPlaycheckRunIdHeader, readTurnIdHeader, sendJson, sendNoContent, writeNdjson, type LlmRequestContext, type LocalApiConfig } from './localApiSupport.js';
import { createRequestLlmProviderTracker, logStructuredEvent, recordStructuredEvent } from './localApiTelemetry.js';
import { OpenAiResponsesError } from './openAiResponses.js';
import {
  appendRouterEvent,
  readRouterEvent,
} from './routerStore.js';
import {
  AivisCloudError
} from './tts/aivisCloud.js';
import { handleTtsRequest } from './ttsHandler.js';
import { createAivisSpeakerCatalogCache, readTtsBackend, reportAivisSelection } from './ttsService.js';
import {
  appendVoiceLabRecord,
  readVoiceLabRecord,
} from './voiceLabStore.js';

import { handleWorldRequest } from './worldHandler.js';

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: LocalApiConfig,
): Promise<void> {
  const pathname = new URL(
    request.url ?? '/',
    'http://127.0.0.1',
  ).pathname;

  if (pathname.startsWith('/api/world/')) {
    await handleWorldRequest(request, response, config);
    return;
  }
  if (pathname === HEALTH_PATH) {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    let internet: NetworkAvailability = 'unavailable';
    try {
      internet =
        (await config.internetConnectivity?.check()) ?? 'unavailable';
    } catch {
      // Internet probing is deliberately best effort. Local health remains 200.
      internet = 'unavailable';
    }
    sendJson(response, 200, createHealthResponse(config, internet));
    return;
  }

  const requestId = randomUUID();
  const headerTurnId = readTurnIdHeader(request);
  const isProviderRequest =
    pathname === CHAT_PATH ||
    pathname === CARD_PREVIEW_PATH ||
    pathname === TTS_PATH;
  const isLlmRequest =
    pathname === CHAT_PATH || pathname === CARD_PREVIEW_PATH;
  let requestPhase: 'llm' | 'tts' | null = null;
  let playcheckRunId: string | undefined;

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  if (isProviderRequest) providerRequestCounts.active += 1;

  try {
    const headerPlaycheckRunId = readPlaycheckRunIdHeader(request);
    if (headerPlaycheckRunId === null) {
      throw new RequestError('runId header is invalid.', 400);
    }
    playcheckRunId = headerPlaycheckRunId;
    const payload = await readJsonBody(request);

    if (pathname === VOICE_LAB_EVENTS_PATH) {
      let record;
      try {
        record = readVoiceLabRecord(payload);
      } catch (error) {
        throw new RequestError(
          error instanceof Error ? error.message : 'Voice Lab record is invalid.',
          400,
        );
      }
      await appendVoiceLabRecord(
        config.playcheckRoot ?? 'playcheck-results/local',
        record,
      );
      sendNoContent(response);
      return;
    }

    if (pathname === ROUTER_EVENTS_PATH) {
      let event;
      try {
        event = readRouterEvent(payload);
      } catch (error) {
        throw new RequestError(
          error instanceof Error ? error.message : 'Router event is invalid.',
          400,
        );
      }
      await appendRouterEvent(
        config.playcheckRoot ?? 'playcheck-results/local',
        event,
      );
      sendNoContent(response);
      return;
    }

    if (pathname === EVENTS_PATH) {
      const event = readConversationEvent(payload);
      if (
        event.runId !== undefined &&
        playcheckRunId !== undefined &&
        event.runId !== playcheckRunId
      ) {
        throw new RequestError('runId header does not match the event.', 400);
      }
      await recordStructuredEvent(config, event.event, {
        origin: 'client',
        requestId,
        runId: event.runId ?? playcheckRunId,
        turnId: event.turnId,
        source: event.source,
        clientAt: event.at,
        elapsedMs: event.elapsedMs,
        ...(event.durationMs === undefined
          ? {}
          : { durationMs: event.durationMs }),
        ...(event.emotion === undefined ? {} : { emotion: event.emotion }),
        ...(event.phase === undefined ? {} : { phase: event.phase }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.interactionAction === undefined
          ? {}
          : { interactionAction: event.interactionAction }),
        ...(event.purpose === undefined ? {} : { purpose: event.purpose }),
        ...(event.callIndex === undefined ? {} : { callIndex: event.callIndex }),
        ...(event.retry === undefined ? {} : { retry: event.retry }),
        ...(event.unitIndex === undefined ? {} : { unitIndex: event.unitIndex }),
        ...(event.gateEvent === undefined
          ? {}
          : { gateEvent: event.gateEvent }),
        ...(event.gatePhase === undefined
          ? {}
          : { gatePhase: event.gatePhase }),
        ...(event.transition === undefined
          ? {}
          : { transition: event.transition }),
        ...(event.blockedBy === undefined
          ? {}
          : { blockedBy: event.blockedBy }),
        ...(event.externalEvent === undefined
          ? {}
          : { externalEvent: event.externalEvent }),
        ...(event.candidateEpisodeId === undefined
          ? {}
          : { candidateEpisodeId: event.candidateEpisodeId }),
        ...(event.candidateReasonIds === undefined
          ? {}
          : { candidateReasonIds: event.candidateReasonIds }),
        ...(event.candidateEvidenceIds === undefined
          ? {}
          : { candidateEvidenceIds: event.candidateEvidenceIds }),
        ...(event.usedReasonIds === undefined
          ? {}
          : { usedReasonIds: event.usedReasonIds }),
        ...(event.internalDeltaOperations === undefined
          ? {}
          : { internalDeltaOperations: event.internalDeltaOperations }),
        ...(event.affectedReasonIds === undefined
          ? {}
          : { affectedReasonIds: event.affectedReasonIds }),
        ...(event.createdReasonIds === undefined
          ? {}
          : { createdReasonIds: event.createdReasonIds }),
        ...(event.resolvedReasonIds === undefined
          ? {}
          : { resolvedReasonIds: event.resolvedReasonIds }),
        ...(event.externalAction === undefined
          ? {}
          : { externalAction: event.externalAction }),
        ...(event.nextEligibleAt === undefined
          ? {}
          : { nextEligibleAt: event.nextEligibleAt }),
        ...(event.delayMs === undefined ? {} : { delayMs: event.delayMs }),
        ...(event.timingMode === undefined
          ? {}
          : { timingMode: event.timingMode }),
        ...(event.elapsedSilenceMs === undefined
          ? {}
          : { elapsedSilenceMs: event.elapsedSilenceMs }),
        ...(event.readiness === undefined
          ? {}
          : { readiness: event.readiness }),
        ...(event.threshold === undefined
          ? {}
          : { threshold: event.threshold }),
        ...(event.opportunityOutcome === undefined
          ? {}
          : { opportunityOutcome: event.opportunityOutcome }),
        ...(event.sessionGeneration === undefined
          ? {}
          : { sessionGeneration: event.sessionGeneration }),
      });
      sendNoContent(response);
      return;
    }

    if (pathname === CARD_PREVIEW_PATH) {
      requestPhase = 'llm';
      if (!config.openAiApiKey) {
        throw new RequestError(
          'OPENAI_API_KEY is not available in the process environment. Start with `npm run dev:op` or `npm run exhibition:start:op` after configuring 1Password.',
          503,
        );
      }
      const { cardId, performanceContext } = readCardPreviewRequest(payload);
      const startedAt = performance.now();
      const providerTurnId = headerTurnId ?? requestId;
      const providerAbortController = new AbortController();
      const unbindProviderAbort = bindLlmProviderAbort(
        request,
        response,
        providerAbortController,
      );
      const telemetry = createRequestLlmProviderTracker(config, {
        requestId,
        runId: playcheckRunId,
        turnId: providerTurnId,
        source: 'card-preview',
        signal: providerAbortController.signal,
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
            source: 'card-preview',
            reason,
          });
        },
      };
      logStructuredEvent('llm_start', {
        origin: 'server',
        requestId,
        turnId: providerTurnId,
        source: 'card-preview',
        cardId,
        activeRequests: providerRequestCounts.active,
      });
      let previewResponse: AssistantResponse;
      try {
        previewResponse = await generateCardPreviewReply(
          llm,
          cardId,
          performanceContext,
          telemetry,
        );
      } finally {
        unbindProviderAbort();
      }
      logStructuredEvent('llm_done', {
        origin: 'server',
        requestId,
        turnId: providerTurnId,
        source: 'card-preview',
        cardId,
        durationMs: Math.round(performance.now() - startedAt),
        activeRequests: providerRequestCounts.active,
      });
      sendJson(response, 200, previewResponse);
      return;
    }

    if (pathname === CHAT_PATH) { requestPhase = 'llm'; await handleChatRequest(request, response, config, payload, requestId, headerTurnId, playcheckRunId); return; }

    requestPhase = 'tts';
    await handleTtsRequest(request, response, config, payload, requestId, headerTurnId, playcheckRunId);
  } catch (error) {
    if (request.aborted) {
      if (!response.destroyed) response.destroy();
      return;
    }
    if (
      response.headersSent &&
      typeof response.getHeader === 'function' &&
      String(response.getHeader('Content-Type') ?? '').startsWith(
        'application/x-ndjson',
      )
    ) {
      if (error instanceof OpenAiResponsesError) {
        console.error('Local chat Responses request failed.', {
          kind: error.kind,
          status: error.status,
          incompleteReason: error.incompleteReason,
          outputTokens: error.usage?.outputTokens ?? null,
          reasoningTokens: error.usage?.reasoningTokens ?? null,
        });
      }
      writeNdjson(response, {
        type: 'error',
        error:
          error instanceof RequestError
            ? error.message
            : 'The chat provider request failed.',
      });
      response.end();
      return;
    }
    if (error instanceof RequestError) {
      if (requestPhase) {
        await recordStructuredEvent(config, 'turn_failed', {
          origin: 'server',
          requestId,
          runId: playcheckRunId,
          turnId: headerTurnId,
          phase: requestPhase,
          reason: 'request_invalid',
          activeRequests: providerRequestCounts.active,
        });
      }
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }

    if (error instanceof AivisSpeechError) {
      if (requestPhase) {
        await recordStructuredEvent(config, 'turn_failed', {
          origin: 'server',
          requestId,
          runId: playcheckRunId,
          turnId: headerTurnId,
          phase: requestPhase,
          reason: 'provider_error',
          activeRequests: providerRequestCounts.active,
        });
      }
      sendJson(response, 502, { error: error.userMessage });
      return;
    }

    if (error instanceof AivisCloudError) {
      if (requestPhase) {
        await recordStructuredEvent(config, 'turn_failed', {
          origin: 'server',
          requestId,
          runId: playcheckRunId,
          turnId: headerTurnId,
          phase: requestPhase,
          reason: error.kind,
          activeRequests: providerRequestCounts.active,
        });
      }
      console.error('Aivis Cloud API request failed.', {
        kind: error.kind,
        upstreamStatus: error.upstreamStatus,
      });
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, error.kind === 'timeout' ? 504 : error.kind === 'configuration' ? 503 : 502, {
        error: error.userMessage,
      });
      return;
    }

    if (requestPhase) {
      await recordStructuredEvent(config, 'turn_failed', {
        origin: 'server',
        requestId,
        runId: playcheckRunId,
        turnId: headerTurnId,
        phase: requestPhase,
        reason: 'provider_error',
        activeRequests: providerRequestCounts.active,
      });
    }

    console.error(
      isLlmRequest
        ? 'Local chat provider request failed.'
        : 'Local TTS provider request failed.',
      error,
    );
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendJson(response, 502, {
      error:
        isLlmRequest
          ? 'The chat provider request failed.'
          : 'The TTS provider request failed.',
    });
  } finally {
    if (isProviderRequest) providerRequestCounts.active -= 1;
  }
}

export function localApiPlugin(config: LocalApiConfig): Plugin {
  return {
    name: 'performer-local-api',
    configureServer(server) {
      const exhibitionCapture = config.exhibitionCaptureEnabled
        ? createExhibitionCapture(
          config.playcheckRoot ?? 'playcheck-results/local',
        )
        : undefined;
      const aivisSpeakerCatalog = createAivisSpeakerCatalogCache();
      const requestConfig = {
        ...config,
        ...(exhibitionCapture ? { exhibitionCapture } : {}),
        aivisSpeakerCatalog,
      };

      if (exhibitionCapture) {
        let stoppingFromInterrupt = false;
        const finishCapture = async (): Promise<void> => {
          await exhibitionCapture.finish();
        };
        const onInterrupt = (): void => {
          if (stoppingFromInterrupt) return;
          stoppingFromInterrupt = true;
          void (async () => {
            try {
              await server.close();
              await finishCapture();
            } catch (error) {
              console.warn('Exhibition capture shutdown failed.', error);
            } finally {
              process.exitCode = 130;
            }
          })();
        };
        process.once('SIGINT', onInterrupt);

        void exhibitionCapture.ready
          .then(() => {
            console.info(
              '[exhibition-capture]',
              `captureId=${exhibitionCapture.captureId}`,
              `path=${exhibitionCapture.paths.directoryPath}`,
            );
            console.info(
              '[exhibition-capture]',
              `observe=npm run exhibition:observe -- --capture-id ${exhibitionCapture.captureId}`,
            );
          })
          .catch((error: unknown) => {
            console.warn(
              'Exhibition capture initialization failed.',
              error,
            );
          });
        server.httpServer?.once('close', () => {
          process.removeListener('SIGINT', onInterrupt);
          void finishCapture().catch((error: unknown) => {
            console.warn('Exhibition capture finalization failed.', error);
          });
        });
      }

      if (readTtsBackend(config.ttsBackend) === 'local') {
        void reportAivisSelection(requestConfig);
      }
      void (exhibitionCapture?.ready ?? Promise.resolve())
        .then(() => warmInteractiveLlmCache(requestConfig))
        .then((warmed) => {
          if (warmed) {
            console.info('[llm-cache] voice cache warmup completed.');
          }
        })
        .catch((error: unknown) => {
          console.warn('LLM cache warmup failed.', error);
        });
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(
          request.url ?? '/',
          'http://127.0.0.1',
        ).pathname;
        if (
          pathname !== HEALTH_PATH &&
          pathname !== CHAT_PATH &&
          pathname !== CARD_PREVIEW_PATH &&
          pathname !== TTS_PATH &&
          pathname !== EVENTS_PATH &&
          pathname !== VOICE_LAB_EVENTS_PATH &&
          pathname !== ROUTER_EVENTS_PATH &&
          !pathname.startsWith('/api/world/')
        ) {
          next();
          return;
        }

        void handleRequest(request, response, requestConfig);
      });
    },
  };
}
export {
  isActionCommitmentMessage,
  isContentBearingVoiceMessage,
  isDirectActionRequestMessage,
  isMetaOnlyActionResponse
} from '../src/performer/runtime.js';
export { buildAutonomousDirectorInstruction, buildCardPreviewStaticPrompt, buildCardPreviewSystemPrompt, buildCharacterIdentityDynamicPrompt, buildCharacterIdentityStaticPrompt, buildCharacterIdentitySystemPrompt, buildConversationActionPolicyStaticPrompt, buildConversationActionPolicySystemPrompt, buildProgramContextDynamicPrompt, buildProgramContextStaticPrompt, buildProgramContextSystemPrompt, buildUtterancePlanInstruction, buildUtterancePlanStaticInstruction, buildVoiceInteractionPolicyStaticPrompt, buildVoiceInteractionPolicySystemPrompt, createInteractionReactionResponse, createVoiceReactionResponse, resolveProvisionalActivatedCards } from './chatGeneration.js';
export { parseAutonomousAssistantResponse, parseCardPreviewResponse, parseConversationActionPolicy, parseVoiceAssistantResponse, parseVoiceInteractionPolicy, readAutonomyCandidate, readCardPreviewRequest, readConversationEvent, readPerformerStateContext } from './chatValidation.js';
export { VOICE_REPLY_INSTRUCTION, bindLlmProviderAbort, buildUsedReasonIdsProperty, createHealthResponse, isRetryableIncompleteResponseError, maxOutputTokensForChatMode, normalizeConversationActionDecision, normalizeVoiceInteractionDecision, resolveLlmProviderSource } from './localApiSupport.js';
export type { LocalApiConfig, PerformanceContextPayload, TtsBackend } from './localApiSupport.js';
export { createAivisSpeakerCatalogCache } from './ttsService.js';
export { formatSemanticBiasesForPrompt } from './chatGeneration.js';
export { classifyTerminalStreamingEnvelope, runtimeForReplyAttempt } from './localApiSupport.js';
export type { ChatRetryCause } from './localApiSupport.js';
