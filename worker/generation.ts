import type { createGenerationMeasurements } from './diagnostics';
import { generateReply, generateInteractiveResponse, generateCardPreviewReply } from '../server/chatGeneration';
import { readChatRequest, readCardPreviewRequest } from '../server/chatValidation';
import { createLlmProviderCallTracker } from '../server/llmProviderTelemetry';
import type { StreamingReplyCallbacks, LlmRequestContext } from '../server/localApiSupport';

export async function generate(payload: unknown, preview: boolean, apiKey: string, signal: AbortSignal, callbacks: StreamingReplyCallbacks | null, measurements?: ReturnType<typeof createGenerationMeasurements>, manifestationEnabled = false, visualVideoEnabled = false) {
  const llm: LlmRequestContext = { manifestationEnabled, visualVideoEnabled, apiKey, signal, warmup: false, onFallback: () => {}, runtime: {
    profile: 'nano-implicit', serviceTier: 'standard', fallbackEnabled: false, cacheWarmupEnabled: false,
  } };
  const telemetry = createLlmProviderCallTracker({ turnId: crypto.randomUUID(), provider: 'openai', model: 'gpt-5-nano',
    source: preview ? 'card_change' : 'manual', signal, record: () => {}, recordExternal: event => { measurements?.record(event); } });
  if (preview) {
    const p = readCardPreviewRequest(payload);
    return generateCardPreviewReply(llm, p.cardId, p.performanceContext, telemetry);
  }
  const p = readChatRequest(payload);
  if (p.mode === 'manual') return generateInteractiveResponse(llm, p.mode, p.message!, p.history,
    p.brainCardIds, p.forcedCardId, p.performanceContext, p.characterIdentity, p.programContext,
    telemetry, callbacks, p.earlySpeechLead, p.recentExpressionLevels, p.greeting, p.cardContinuation);
  const result = await generateReply(llm, p.mode, p.message, p.history, p.brainCardIds, p.forcedCardId,
    p.topic, p.topicTurns, p.viewerIntent, p.viewerTurnsSince, p.viewerEngagement, p.performerState,
    p.lastSelfUtterance, p.performanceContext, p.characterIdentity, p.programContext, p.autonomyCandidate,
    telemetry, callbacks, p.earlySpeechLead, p.recentExpressionLevels, p.greeting, p.cardContinuation);
  return { ...result.response, ...(p.mode === 'voice' ? { interactionAction: result.response.voiceAction, internalDelta: { reasonUpdates: [] } } : {}) };
}
