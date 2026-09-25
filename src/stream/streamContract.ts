export const STREAM_BENCH_PATH = '/api/stream/vlm-bench';

export const STREAM_VISION_PROVIDER_IDS = [
  'openai-nano',
  'groq-vision',
  'gemini-flash-lite',
] as const;

export type StreamVisionProviderId =
  (typeof STREAM_VISION_PROVIDER_IDS)[number];

export interface StreamObservedEvent {
  kind: string;
  summary: string;
  significance: 'low' | 'medium' | 'high';
}

export interface StreamObservation {
  changed: boolean;
  changeSummary: string;
  events: StreamObservedEvent[];
  scene: {
    setting: 'outdoor' | 'indoor' | 'underground' | 'menu' | 'loading' | 'unknown';
    timeOfDay: 'day' | 'dusk' | 'night' | 'dawn' | 'unknown';
    bloodMoon: boolean;
  };
  player: {
    activity: string;
    healthState: 'ok' | 'hurt' | 'critical' | 'dead' | 'unknown';
  };
}

export interface StreamBenchFixtureSummary {
  id: string;
  category: string;
  expectedChanged: boolean | null;
  expectedEventKinds: string[];
  notes: string;
}

export interface StreamBenchProviderInfo {
  id: StreamVisionProviderId;
  label: string;
  model: string;
  configured: boolean;
  usdPerMillionTokens: { input: number; output: number };
}

export interface StreamBenchRunResult {
  fixtureId: string;
  providerId: StreamVisionProviderId;
  model: string;
  ok: boolean;
  jsonOk: boolean;
  parseOk: boolean;
  latencyMs: number;
  observation: StreamObservation | null;
  rawText?: string;
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
  error?: {
    kind: string;
    message: string;
    status?: number;
  };
  expected?: {
    changed: boolean | null;
    eventKinds: string[];
  };
}

export interface StreamBenchRunRequest {
  fixtureId: string;
  providerId: StreamVisionProviderId;
  model?: string;
}
