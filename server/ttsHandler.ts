import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import {
  VOICE_STYLE_BY_EMOTION
} from '../src/character/emotion.js';
import { readTtsRequest } from './chatValidation.js';
import { bindLlmProviderAbort, providerRequestCounts, type LocalApiConfig, type PreparedAivisCloudAudio } from './localApiSupport.js';
import { recordStructuredEvent } from './localApiTelemetry.js';
import {
  AivisCloudError,
  synthesizeAivisCloudSpeech
} from './tts/aivisCloud.js';
import { prepareAivisCloudAudio, readAivisTtsSettings, readTtsBackend, streamAivisCloudAudio, synthesizeLocalSpeech } from './ttsService.js';

export async function handleTtsRequest(request: IncomingMessage, response: ServerResponse, config: LocalApiConfig, payload: unknown, requestId: string, headerTurnId: string | null, playcheckRunId: string | undefined): Promise<void> {
  const { text, emotion, ttsProfile, unitIndex } = readTtsRequest(payload);
  const ttsBackend = readTtsBackend(config.ttsBackend);
  const settings = readAivisTtsSettings(config);
  const effectiveSettings = ttsProfile
    ? {
      ...settings,
      speedScale: Math.max(
        0.5,
        Math.min(2, settings.speedScale * ttsProfile.rateScale),
      ),
      intonationScale: Math.max(
        0,
        Math.min(2, settings.intonationScale * ttsProfile.intonationScale),
      ),
    }
    : settings;
  const startedAt = performance.now();
  const characterCount = Array.from(text).length;
  let ttsStageRecordQueue = Promise.resolve();
  const recordLocalTtsStage = (
    stage:
      | 'speaker_catalog_ready'
      | 'audio_query_done'
      | 'synthesis_headers_ready'
      | 'synthesis_body_done',
  ): void => {
    const durationMs = Math.round(performance.now() - startedAt);
    ttsStageRecordQueue = ttsStageRecordQueue.then(() =>
      recordStructuredEvent(config, `tts_${stage}`, {
        origin: 'server',
        requestId,
        runId: playcheckRunId,
        turnId: headerTurnId,
        provider: 'local',
        unitIndex,
        characterCount,
        durationMs,
      }),
    );
  };
  await recordStructuredEvent(config, 'tts_start', {
    origin: 'server',
    requestId,
    runId: playcheckRunId,
    turnId: headerTurnId,
    provider: ttsBackend,
    unitIndex,
    characterCount,
    activeRequests: providerRequestCounts.active,
  });
  const ttsAbortController = new AbortController();
  const unbindTtsAbort = bindLlmProviderAbort(request, response, ttsAbortController);
  try {
    ttsAbortController.signal.throwIfAborted();
    if (ttsBackend !== 'local') {
      const styleName = VOICE_STYLE_BY_EMOTION[emotion];

      let preparedCloud: PreparedAivisCloudAudio;
      try {
        const cloudResult = await synthesizeAivisCloudSpeech({
          apiKey: config.aivisCloudApiKey ?? '',
          baseUrl: config.aivisCloudBaseUrl,
          emotionalIntensity: effectiveSettings.intonationScale,
          firstAudioTimeoutMs: config.aivisCloudFirstAudioTimeoutMs ?? 2_000,
          modelUuid: config.aivisCloudModelUuid ?? '',
          pitch: effectiveSettings.pitchScale,
          signal: ttsAbortController.signal,
          speakingRate: effectiveSettings.speedScale,
          styleName,
          tempoDynamics: effectiveSettings.tempoDynamicsScale,
          text,
          timeoutMs: config.aivisCloudTimeoutMs,
        });
        preparedCloud = await prepareAivisCloudAudio(cloudResult, request);
      } catch (error) {

        if (
          ttsAbortController.signal.aborted ||
          (error instanceof AivisCloudError && error.kind === 'aborted')
        ) {
          if (!response.destroyed) response.destroy();
          return;
        }
        if (
          ttsBackend !== 'cloud-with-fallback' ||
          !(error instanceof AivisCloudError)
        ) {
          throw error;
        }

        console.warn('Aivis Cloud TTS is falling back to local synthesis.', {
          kind: error.kind,
          upstreamStatus: error.upstreamStatus,
        });
        await recordStructuredEvent(config, 'tts_fallback_started', {
          origin: 'server',
          requestId,
          runId: playcheckRunId,
          turnId: headerTurnId,
          provider: 'local',
          reason: error.kind,
          durationMs: Math.round(performance.now() - startedAt),
          unitIndex,
          characterCount,
        });

        const audio: Buffer = await synthesizeLocalSpeech(
          config,
          emotion,
          effectiveSettings,
          text,
          ttsAbortController.signal,
          recordLocalTtsStage,
        );
        if (ttsAbortController.signal.aborted) {
          if (!response.destroyed) response.destroy();
          return;
        }
        await recordStructuredEvent(config, 'tts_first_audio', {
          origin: 'server',
          requestId,
          runId: playcheckRunId,
          turnId: headerTurnId,
          provider: 'local',
          reason: error.kind,
          durationMs: Math.round(performance.now() - startedAt),
          audioBytes: audio.byteLength,
          activeRequests: providerRequestCounts.active,
          unitIndex,
          characterCount,
        });
        await recordStructuredEvent(config, 'tts_completed', {
          origin: 'server',
          requestId,
          runId: playcheckRunId,
          turnId: headerTurnId,
          provider: 'local',
          reason: error.kind,
          durationMs: Math.round(performance.now() - startedAt),
          audioBytes: audio.byteLength,
          activeRequests: providerRequestCounts.active,
          unitIndex,
          characterCount,
        });
        await recordStructuredEvent(config, 'tts_fallback_completed', {
          origin: 'server',
          requestId,
          runId: playcheckRunId,
          turnId: headerTurnId,
          provider: 'local',
          reason: error.kind,
          durationMs: Math.round(performance.now() - startedAt),
          unitIndex,
          characterCount,
        });
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Length': audio.byteLength,
          'Content-Type': 'audio/wav',
          'X-Content-Type-Options': 'nosniff',
          'X-Vayria-Tts-Backend': 'local',
          'X-Vayria-Tts-Fallback-From': 'aivis-cloud',
          'X-Vayria-Tts-Fallback-Reason': error.kind,
        });
        response.end(audio);
        return;
      }

      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': preparedCloud.result.contentType,
        'X-Content-Type-Options': 'nosniff',
        'X-Vayria-Tts-Backend': 'aivis-cloud',
      });
      const audioBytes = await streamAivisCloudAudio(
        preparedCloud,
        request,
        response,
        async (firstChunkBytes) => {
          await recordStructuredEvent(config, 'tts_first_audio', {
            origin: 'server',
            requestId,
            runId: playcheckRunId,
            turnId: headerTurnId,
            provider: 'aivis-cloud',
            durationMs: Math.round(performance.now() - startedAt),
            audioBytes: firstChunkBytes,
            activeRequests: providerRequestCounts.active,
            unitIndex,
            characterCount,
          });
        },
      );
      await recordStructuredEvent(config, 'tts_completed', {
        origin: 'server',
        requestId,
        runId: playcheckRunId,
        turnId: headerTurnId,
        provider: 'aivis-cloud',
        durationMs: Math.round(performance.now() - startedAt),
        audioBytes,
        activeRequests: providerRequestCounts.active,
        unitIndex,
        characterCount,
      });
      return;
    }

    const audio: Buffer = await synthesizeLocalSpeech(
      config,
      emotion,
      effectiveSettings,
      text,
      ttsAbortController.signal,
      recordLocalTtsStage,
    );
    if (ttsAbortController.signal.aborted) {
      if (!response.destroyed) response.destroy();
      return;
    }
    await recordStructuredEvent(config, 'tts_first_audio', {
      origin: 'server',
      requestId,
      runId: playcheckRunId,
      turnId: headerTurnId,
      provider: ttsBackend,
      durationMs: Math.round(performance.now() - startedAt),
      audioBytes: audio.byteLength,
      activeRequests: providerRequestCounts.active,
      unitIndex,
      characterCount,
    });
    await recordStructuredEvent(config, 'tts_completed', {
      origin: 'server',
      requestId,
      runId: playcheckRunId,
      turnId: headerTurnId,
      provider: ttsBackend,
      durationMs: Math.round(performance.now() - startedAt),
      audioBytes: audio.byteLength,
      activeRequests: providerRequestCounts.active,
      unitIndex,
      characterCount,
    });
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': audio.byteLength,
      'Content-Type': 'audio/wav',
      'X-Content-Type-Options': 'nosniff',
      'X-Vayria-Tts-Backend': ttsBackend,
    });
    response.end(audio);
  } finally { unbindTtsAbort(); }
}
