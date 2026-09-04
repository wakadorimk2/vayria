export const LLM_PROVIDER_EVENTS = [
  'llm_provider_start',
  'llm_provider_first_chunk',
  'llm_provider_done',
] as const;

export type LlmProviderEventName = (typeof LLM_PROVIDER_EVENTS)[number];
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

interface LlmProviderCallTrackerOptions {
  turnId: string;
  provider: string;
  model: string;
  source: LlmProviderSource;
  record: RecordLlmProviderEvent;
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
    ) => Promise<T>,
  ): Promise<T>;
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

  return {
    get callCount() {
      return callCount;
    },
    async run<T>(
      callOptions: RunLlmProviderCallOptions,
      execute: (
        markFirstChunk: () => void,
        setMetadata: (metadata: LlmProviderEventMetadata) => void,
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

      void record('llm_provider_start');
      try {
        const providerCall = execute(markFirstChunk, setMetadata);
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
