import { readPlaycheckRunId } from './playcheck';

const APP_MODES = ['local', 'exhibition', 'public'] as const;
const VOICE_INPUT_TRANSPORTS = ['web-speech', 'remote'] as const;

export type AppMode = (typeof APP_MODES)[number];
export type VoiceInputTransport = (typeof VOICE_INPUT_TRANSPORTS)[number];

const DEFAULT_APP_MODE: AppMode = 'local';

function readAppMode(value: unknown): AppMode {
  if (
    typeof value === 'string' &&
    (APP_MODES as readonly string[]).includes(value)
  ) {
    return value as AppMode;
  }

  return DEFAULT_APP_MODE;
}

function readApiBaseUrl(value: unknown): string {
  const rawValue = typeof value === 'string' ? value.trim() : '';
  if (!rawValue || rawValue === '/') return '';

  let parsed: URL;
  try {
    parsed = new URL(rawValue, 'http://performer.invalid');
  } catch {
    throw new Error('VITE_API_BASE_URL must be a valid URL or path.');
  }

  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:'
  ) {
    throw new Error('VITE_API_BASE_URL must use HTTP or HTTPS.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('VITE_API_BASE_URL must not contain a query or hash.');
  }

  return rawValue.replace(/\/+$/, '');
}

function readVoiceInputTransport(
  value: unknown,
  mode: AppMode,
): VoiceInputTransport {
  if (
    typeof value === 'string' &&
    (VOICE_INPUT_TRANSPORTS as readonly string[]).includes(value)
  ) {
    return value as VoiceInputTransport;
  }

  return mode === 'exhibition' ? 'remote' : 'web-speech';
}

const mode = readAppMode(import.meta.env.VITE_APP_MODE);
function readAudioLabEnabled(search: string): boolean {
  if (!import.meta.env.DEV) return false;
  return new URLSearchParams(search).get('audioLab') === '1';
}

export const runtimeConfig = Object.freeze({
  apiBaseUrl: readApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
  audioLabEnabled:
    typeof window !== 'undefined' && readAudioLabEnabled(window.location.search),
  mode,
  voiceTransport: readVoiceInputTransport(
    import.meta.env.VITE_VOICE_INPUT_TRANSPORT,
    mode,
  ),
  playcheckRunId:
    typeof window === 'undefined'
      ? null
      : readPlaycheckRunId(window.location.search),
});

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${runtimeConfig.apiBaseUrl}${normalizedPath}`;
}
