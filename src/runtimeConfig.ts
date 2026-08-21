const APP_MODES = ['local', 'exhibition', 'public'] as const;

export type AppMode = (typeof APP_MODES)[number];

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
    parsed = new URL(rawValue, 'http://wildcard.invalid');
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

export const runtimeConfig = Object.freeze({
  apiBaseUrl: readApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
  mode: readAppMode(import.meta.env.VITE_APP_MODE),
});

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${runtimeConfig.apiBaseUrl}${normalizedPath}`;
}
