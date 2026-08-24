import type {
  NetworkAvailability,
} from '../src/networkState.js';

const DEFAULT_INTERNET_PROBE_URL =
  'https://www.msftconnecttest.com/connecttest.txt';
const DEFAULT_CACHE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 1_500;

export interface InternetConnectivityProbe {
  check(): Promise<NetworkAvailability>;
  reset(): void;
}

export interface InternetConnectivityProbeOptions {
  url?: string;
  cacheMs?: number;
  timeoutMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export function createInternetConnectivityProbe(
  options: InternetConnectivityProbeOptions = {},
): InternetConnectivityProbe {
  const url = options.url ?? DEFAULT_INTERNET_PROBE_URL;
  const cacheMs = Math.max(0, options.cacheMs ?? DEFAULT_CACHE_MS);
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let cached: {
    checkedAt: number;
    value: NetworkAvailability;
  } | null = null;
  let inFlight: Promise<NetworkAvailability> | null = null;

  const check = async (): Promise<NetworkAvailability> => {
    const currentTime = now();
    if (cached && currentTime - cached.checkedAt < cacheMs) {
      return cached.value;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      let value: NetworkAvailability = 'unavailable';
      if (typeof fetchImpl === 'function') {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(url, {
            method: 'GET',
            signal: controller.signal,
            cache: 'no-store',
          });
          value =
            response.status >= 200 && response.status < 400
              ? 'available'
              : 'unavailable';
        } catch {
          value = 'unavailable';
        } finally {
          clearTimeout(timeout);
        }
      }

      cached = { checkedAt: now(), value };
      inFlight = null;
      return value;
    })();

    return inFlight;
  };

  return {
    check,
    reset() {
      cached = null;
    },
  };
}

export { DEFAULT_INTERNET_PROBE_URL };
