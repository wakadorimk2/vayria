const DEFAULT_AIVIS_CLOUD_BASE_URL = 'https://api.aivis-project.com';
const DEFAULT_AIVIS_CLOUD_TIMEOUT_MS = 15_000;
const MODEL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type AivisCloudErrorKind =
  | 'authentication'
  | 'configuration'
  | 'invalid_request'
  | 'model'
  | 'provider'
  | 'quota'
  | 'rate_limit'
  | 'timeout';

export class AivisCloudError extends Error {
  constructor(
    readonly kind: AivisCloudErrorKind,
    readonly userMessage: string,
    readonly upstreamStatus?: number,
  ) {
    super(userMessage);
    this.name = 'AivisCloudError';
  }
}

export interface AivisCloudSynthesisInput {
  apiKey: string;
  baseUrl?: string;
  emotionalIntensity: number;
  fetchImpl?: typeof fetch;
  modelUuid: string;
  pitch: number;
  speakingRate: number;
  styleName: string;
  tempoDynamics: number;
  text: string;
  timeoutMs?: number;
}

export interface AivisCloudSynthesisResult {
  body: ReadableStream<Uint8Array>;
  contentType: 'audio/mpeg';
  didTimeout(): boolean;
  dispose(): void;
}

function readBaseUrl(value: string | undefined): URL {
  try {
    const url = new URL(value?.trim() || DEFAULT_AIVIS_CLOUD_BASE_URL);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('Cloud API requires HTTPS.');
    }
    return url;
  } catch {
    throw new AivisCloudError(
      'configuration',
      'AIVIS_CLOUD_BASE_URL must be a valid HTTPS URL.',
    );
  }
}

function readRequired(value: string, variableName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AivisCloudError(
      'configuration',
      `${variableName} is required when VAYRIA_TTS_BACKEND is aivis-cloud.`,
    );
  }
  return normalized;
}

function mapUpstreamError(status: number): AivisCloudError {
  switch (status) {
    case 401:
      return new AivisCloudError(
        'authentication',
        'Aivis Cloud API authentication failed.',
        status,
      );
    case 402:
      return new AivisCloudError(
        'quota',
        'Aivis Cloud API credit is unavailable.',
        status,
      );
    case 404:
      return new AivisCloudError(
        'model',
        'The configured Aivis Cloud model was not found.',
        status,
      );
    case 422:
      return new AivisCloudError(
        'invalid_request',
        'Aivis Cloud API rejected the synthesis settings.',
        status,
      );
    case 429:
      return new AivisCloudError(
        'rate_limit',
        'Aivis Cloud API rate limit was reached.',
        status,
      );
    default:
      return new AivisCloudError(
        'provider',
        'Aivis Cloud API synthesis failed.',
        status,
      );
  }
}

export async function synthesizeAivisCloudSpeech(
  input: AivisCloudSynthesisInput,
): Promise<AivisCloudSynthesisResult> {
  const apiKey = readRequired(input.apiKey, 'AIVIS_CLOUD_API_KEY');
  const modelUuid = readRequired(input.modelUuid, 'AIVIS_CLOUD_MODEL_UUID');
  if (!MODEL_UUID_PATTERN.test(modelUuid)) {
    throw new AivisCloudError(
      'configuration',
      'AIVIS_CLOUD_MODEL_UUID must be a UUID.',
    );
  }

  const endpoint = new URL('/v1/tts/synthesize', readBaseUrl(input.baseUrl));
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? DEFAULT_AIVIS_CLOUD_TIMEOUT_MS;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const dispose = () => {
    clearTimeout(timeout);
    controller.abort();
  };

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'audio/mpeg',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_uuid: modelUuid,
        text: input.text,
        use_ssml: false,
        style_name: input.styleName,
        speaking_rate: input.speakingRate,
        emotional_intensity: input.emotionalIntensity,
        tempo_dynamics: input.tempoDynamics,
        pitch: input.pitch,
        leading_silence_seconds: 0,
        output_format: 'mp3',
        output_bitrate: 192,
        output_sampling_rate: 44_100,
        output_audio_channels: 'mono',
      }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new AivisCloudError(
        'timeout',
        'Aivis Cloud API synthesis timed out.',
      );
    }
    throw new AivisCloudError(
      'provider',
      'Aivis Cloud API could not be reached.',
    );
  }

  if (!response.ok) {
    dispose();
    throw mapUpstreamError(response.status);
  }
  if (!response.body) {
    dispose();
    throw new AivisCloudError(
      'provider',
      'Aivis Cloud API returned no audio stream.',
    );
  }

  return {
    body: response.body,
    contentType: 'audio/mpeg',
    didTimeout: () => timedOut,
    dispose,
  };
}
