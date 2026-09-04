export const LLM_PROVIDER_EVENTS = [
  'llm_provider_start',
  'llm_provider_first_chunk',
  'llm_provider_done',
] as const;

export type LlmProviderEventName = (typeof LLM_PROVIDER_EVENTS)[number];
export const LLM_EXTERNAL_REQUEST_EVENTS = [
  'llm_external_request_start',
  'llm_external_request_first_chunk',
  'llm_external_request_done',
] as const;
export type LlmExternalRequestEventName =
  (typeof LLM_EXTERNAL_REQUEST_EVENTS)[number];
export type LlmExternalRequestEndpoint = 'responses' | 'chat-completions';
export type LlmExternalRequestTerminationKind =
  | 'success'
  | 'incomplete'
  | 'http_error'
  | 'connection_error'
  | 'provider_error'
  | 'aborted'
  | 'unknown_error';
export type LlmProviderPurpose =
  | 'conversation-policy'
  | 'response-generation'
  | 'card-preview';
export type LlmProviderSource =
  | 'voice'
  | 'manual'
  | 'card_change'
  | 'autonomous'
  | 'card-preview';

export interface LlmProviderEvent {
  event: LlmProviderEventName;
  turnId: string;
  provider: string;
  model: string;
  purpose: LlmProviderPurpose;
  source: LlmProviderSource;
  callIndex: number;
  retry: number;
  elapsedMs: number;
  profile?: string;
  apiEndpoint?: string;
  cacheMode?: string;
  cacheKeyVersion?: string;
  cacheStatus?: string;
  requestedTier?: string;
  actualTier?: string;
  actualModel?: string;
  inputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  staticPrefixChars?: number;
  dynamicContextChars?: number;
  schemaBytes?: number;
  historyItemCount?: number;
  historyChars?: number;
  requestBytes?: number;
  warmup?: number;
  fallbackReason?: string;
}

export interface LlmExternalRequestEvent {
  event: LlmExternalRequestEventName;
  turnId: string;
  source: LlmProviderSource;
  purpose: LlmProviderPurpose;
  callIndex: number;
  retry: number;
  externalRequestIndex: number;
  provider: string;
  model: string;
  apiEndpoint: LlmExternalRequestEndpoint;
  elapsedMs: number;
  maxOutputTokens?: number;
  terminationKind?: LlmExternalRequestTerminationKind;
  httpStatus?: number;
  incompleteReason?: string;
  inputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  requestedTier?: string;
  actualTier?: string;
  cacheMode?: string;
  cacheStatus?: string;
}

export type LlmExternalRequestMetadata = Omit<
  Partial<LlmExternalRequestEvent>,
  | 'event'
  | 'turnId'
  | 'source'
  | 'purpose'
  | 'callIndex'
  | 'retry'
  | 'externalRequestIndex'
  | 'provider'
  | 'model'
  | 'apiEndpoint'
  | 'elapsedMs'
  | 'maxOutputTokens'
  | 'terminationKind'
>;

export interface TrackLlmExternalRequestOptions {
  apiEndpoint: LlmExternalRequestEndpoint;
  model?: string;
  maxOutputTokens?: number;
  metadata?: LlmExternalRequestMetadata;
}

export type TrackLlmExternalRequest = <T>(
  options: TrackLlmExternalRequestOptions,
  execute: (
    markFirstChunk: () => void,
    setMetadata: (metadata: LlmExternalRequestMetadata) => void,
  ) => Promise<T>,
) => Promise<T>;

export type LlmProviderEventMetadata = Omit<
  Partial<LlmProviderEvent>,
  | 'event'
  | 'turnId'
  | 'provider'
  | 'model'
  | 'purpose'
  | 'source'
  | 'callIndex'
  | 'retry'
  | 'elapsedMs'
>;

export interface LlmProviderLatencySummary {
  source: 'voice' | 'manual' | 'card_change';
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

type RecordLlmProviderEvent = (event: LlmProviderEvent) => void | Promise<void>;
type RecordLlmExternalRequestEvent = (
  event: LlmExternalRequestEvent,
) => void | Promise<void>;

interface LlmProviderCallTrackerOptions {
  turnId: string;
  provider: string;
  model: string;
  source: LlmProviderSource;
  record: RecordLlmProviderEvent;
  recordExternal?: RecordLlmExternalRequestEvent;
  observe?: (event: LlmProviderEvent) => void;
  now?: () => number;
  signal?: AbortSignal;
}

interface RunLlmProviderCallOptions {
  purpose: LlmProviderPurpose;
  retry: number;
}

export interface LlmProviderCallTracker {
  readonly callCount: number;
  run<T>(
    options: RunLlmProviderCallOptions,
    execute: (
      markFirstChunk: () => void,
      setMetadata: (metadata: LlmProviderEventMetadata) => void,
      trackExternalRequest: TrackLlmExternalRequest,
    ) => Promise<T>,
  ): Promise<T>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function safeErrorRecord(error: unknown): Record<string, unknown> | null {
  return error && typeof error === 'object'
    ? (error as Record<string, unknown>)
    : null;
}

function classifyExternalRequestError(error: unknown): {
  terminationKind: LlmExternalRequestTerminationKind;
  metadata: LlmExternalRequestMetadata;
} {
  const record = safeErrorRecord(error);
  const name = record?.name;
  const kind = record?.kind;
  const status = safeHttpStatus(record?.status);
  const metadata: LlmExternalRequestMetadata = {};
  if (status !== undefined) metadata.httpStatus = status;

  if (name === 'OpenAiResponsesError') {
    if (kind === 'incomplete') {
      const incompleteReason = record?.incompleteReason;
      if (typeof incompleteReason === 'string') {
        metadata.incompleteReason = incompleteReason;
      }
      const usage = safeErrorRecord(record?.usage);
      for (const field of [
        'inputTokens',
        'cachedTokens',
        'cacheWriteTokens',
        'outputTokens',
        'reasoningTokens',
      ] as const) {
        const value = finiteNumber(usage?.[field]);
        if (value !== undefined) metadata[field] = value;
      }
      return { terminationKind: 'incomplete', metadata };
    }
    if (kind === 'http') return { terminationKind: 'http_error', metadata };
    if (kind === 'connection') {
      return { terminationKind: 'connection_error', metadata };
    }
    if (kind === 'provider') {
      return { terminationKind: 'provider_error', metadata };
    }
    if (kind === 'aborted') return { terminationKind: 'aborted', metadata };
  }
  if (name === 'HttpError' && status !== undefined) {
    return { terminationKind: 'http_error', metadata };
  }
  if (name === 'AbortError') return { terminationKind: 'aborted', metadata };
  if (name === 'TypeError') {
    return { terminationKind: 'connection_error', metadata };
  }
  return { terminationKind: 'unknown_error', metadata };
}

function createAbortError(): Error {
  const error = new Error('The LLM provider call was aborted.');
  error.name = 'AbortError';
  return error;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(createAbortError());

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(createAbortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

export function createLlmProviderCallTracker(
  options: LlmProviderCallTrackerOptions,
): LlmProviderCallTracker {
  const now = options.now ?? performance.now.bind(performance);
  let callCount = 0;
  let externalRequestCount = 0;
  let externalRecordQueue: Promise<void> | null = null;

  return {
    get callCount() {
      return callCount;
    },
    async run<T>(
      callOptions: RunLlmProviderCallOptions,
      execute: (
        markFirstChunk: () => void,
        setMetadata: (metadata: LlmProviderEventMetadata) => void,
        trackExternalRequest: TrackLlmExternalRequest,
      ) => Promise<T>,
    ) {
      callCount += 1;
      const callIndex = callCount;
      const startedAt = now();
      let active = true;
      let firstChunkRecorded = false;
      let metadata: LlmProviderEventMetadata = {};
      let recordQueue: Promise<void> | null = null;
      const record = (event: LlmProviderEventName): Promise<void> => {
        const payload: LlmProviderEvent = {
          event,
          turnId: options.turnId,
          provider: options.provider,
          model: options.model,
          purpose: callOptions.purpose,
          source: options.source,
          callIndex,
          retry: callOptions.retry,
          elapsedMs: Math.max(0, Math.round(now() - startedAt)),
          ...(event === 'llm_provider_done' ? metadata : {}),
        };
        try {
          options.observe?.(payload);
        } catch (error) {
          console.warn('LLM provider telemetry observer failed.', error);
        }
        const write = async (): Promise<void> => {
          try {
            await options.record(payload);
          } catch (error) {
            console.warn('LLM provider telemetry recording failed.', error);
          }
        };
        recordQueue = recordQueue ? recordQueue.then(write) : write();
        return recordQueue;
      };
      const markFirstChunk = (): void => {
        if (!active || firstChunkRecorded) return;
        firstChunkRecorded = true;
        void record('llm_provider_first_chunk');
      };
      const setMetadata = (next: LlmProviderEventMetadata): void => {
        metadata = { ...metadata, ...next };
      };
      const trackExternalRequest: TrackLlmExternalRequest = async (
        externalOptions,
        externalExecute,
      ) => {
        externalRequestCount += 1;
        const externalRequestIndex = externalRequestCount;
        const externalStartedAt = now();
        let externalActive = true;
        let externalFirstChunkRecorded = false;
        let externalMetadata = externalOptions.metadata ?? {};
        let terminationKind: LlmExternalRequestTerminationKind = 'success';
        const recordExternal = (
          event: LlmExternalRequestEventName,
        ): Promise<void> => {
          if (!options.recordExternal) return Promise.resolve();
          const payload: LlmExternalRequestEvent = {
            event,
            turnId: options.turnId,
            source: options.source,
            purpose: callOptions.purpose,
            callIndex,
            retry: callOptions.retry,
            externalRequestIndex,
            provider: options.provider,
            model: externalOptions.model ?? options.model,
            apiEndpoint: externalOptions.apiEndpoint,
            elapsedMs: Math.max(0, Math.round(now() - externalStartedAt)),
            ...(externalOptions.maxOutputTokens !== undefined
              ? { maxOutputTokens: externalOptions.maxOutputTokens }
              : {}),
            ...(event === 'llm_external_request_done'
              ? { terminationKind, ...externalMetadata }
              : {}),
          };
          const write = async (): Promise<void> => {
            try {
              await options.recordExternal?.(payload);
            } catch (recordError) {
              console.warn(
                'LLM external request telemetry recording failed.',
                recordError,
              );
            }
          };
          externalRecordQueue = externalRecordQueue
            ? externalRecordQueue.then(write)
            : write();
          return externalRecordQueue;
        };
        const markExternalFirstChunk = (): void => {
          if (!externalActive || externalFirstChunkRecorded) return;
          externalFirstChunkRecorded = true;
          void recordExternal('llm_external_request_first_chunk');
        };
        const setExternalMetadata = (
          next: LlmExternalRequestMetadata,
        ): void => {
          externalMetadata = { ...externalMetadata, ...next };
        };

        void recordExternal('llm_external_request_start');
        try {
          return await externalExecute(
            markExternalFirstChunk,
            setExternalMetadata,
          );
        } catch (error) {
          const classified = classifyExternalRequestError(error);
          terminationKind = classified.terminationKind;
          externalMetadata = {
            ...externalMetadata,
            ...classified.metadata,
          };
          throw error;
        } finally {
          externalActive = false;
          void recordExternal('llm_external_request_done');
        }
      };

      void record('llm_provider_start');
      try {
        const providerCall = execute(
          markFirstChunk,
          setMetadata,
          trackExternalRequest,
        );
        return options.signal
          ? await raceWithAbort(providerCall, options.signal)
          : await providerCall;
      } finally {
        active = false;
        await record('llm_provider_done');
      }
    },
  };
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? null;
}

export function summarizeInteractiveLlmProviderLatency(
  events: readonly LlmProviderEvent[],
): LlmProviderLatencySummary[] {
  const interactiveSources = ['voice', 'manual', 'card_change'] as const;
  return interactiveSources.map((source) => {
    const samples = events
      .filter(
        (event) =>
          event.event === 'llm_provider_done' &&
          event.source === source &&
          event.warmup !== 1,
      )
      .map((event) => event.elapsedMs);
    return {
      source,
      sampleCount: samples.length,
      p50Ms: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
    };
  });
}
