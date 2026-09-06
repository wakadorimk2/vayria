import { isPlaycheckRunId } from '../src/playcheck.js';
import {
  type ExhibitionEventRecord
} from './exhibitionCaptureStore.js';
import {
  createLlmProviderCallTracker,
  type LlmProviderCallTracker,
  type LlmProviderEvent,
  type LlmProviderSource
} from './llmProviderTelemetry.js';
import {
  modelForProfile
} from './llmRuntime.js';
import { DEFAULT_LLM_RUNTIME, PLAYCHECK_RECORD_FIELDS, SAFE_PLAYCHECK_REASONS, type LocalApiConfig } from './localApiSupport.js';
import {
  appendPlaycheckRecord,
  type PlaycheckRecord,
} from './playcheckStore.js';

export function logStructuredEvent(
  event: string,
  fields: Record<string, unknown>,
): void {
  console.info(
    '[performer-event]',
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...fields,
    }),
  );
}

export async function recordStructuredEvent(
  config: LocalApiConfig,
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  logStructuredEvent(event, fields);

  const runId = fields.runId;
  if (isPlaycheckRunId(runId)) {
    const record: PlaycheckRecord = {
      at: new Date().toISOString(),
      event,
      runId,
    };
    for (const field of PLAYCHECK_RECORD_FIELDS) {
      const value = fields[field];
      if (typeof value === 'string' || typeof value === 'number') {
        if (
          field === 'reason' &&
          (typeof value !== 'string' || !SAFE_PLAYCHECK_REASONS.has(value))
        ) {
          continue;
        }
        record[field] = value;
      } else if (
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
      ) {
        record[field] = value;
      }
    }

    try {
      await appendPlaycheckRecord(
        config.playcheckRoot ?? 'playcheck-results/local',
        runId,
        record,
      );
    } catch (error) {
      console.warn('Playcheck event recording failed.', error);
    }
    return;
  }

  const capture = config.exhibitionCapture;
  if (!capture) return;

  const record: ExhibitionEventRecord = {
    captureId: capture.captureId,
    at: new Date().toISOString(),
    event,
  };
  for (const field of ['origin', ...PLAYCHECK_RECORD_FIELDS]) {
    const value = fields[field];
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      !(
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
      )
    ) {
      continue;
    }
    if (
      field === 'reason' &&
      (typeof value !== 'string' || !SAFE_PLAYCHECK_REASONS.has(value))
    ) {
      continue;
    }
    if (field === 'origin' && value !== 'client' && value !== 'server') {
      continue;
    }
    record[field] = value;
  }

  try {
    await capture.appendEvent(record);
  } catch (error) {
    console.warn('Exhibition event recording failed.', error);
  }
}

export function createRequestLlmProviderTracker(
  config: LocalApiConfig,
  fields: {
    requestId: string;
    runId?: string;
    turnId: string;
    source: LlmProviderSource;
    signal: AbortSignal;
    observe?: (event: LlmProviderEvent) => void;
  },
): LlmProviderCallTracker {
  return createLlmProviderCallTracker({
    turnId: fields.turnId,
    provider: 'openai',
    model: modelForProfile(
      config.llmRuntime?.profile ?? DEFAULT_LLM_RUNTIME.profile,
    ),
    source: fields.source,
    signal: fields.signal,
    observe: fields.observe,
    record: ({ event, ...providerFields }) =>
      recordStructuredEvent(config, event, {
        origin: 'server',
        requestId: fields.requestId,
        runId: fields.runId,
        ...providerFields,
      }),
  });
}
