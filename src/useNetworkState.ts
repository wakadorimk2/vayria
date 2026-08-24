import { useEffect, useState } from 'react';
import { apiUrl } from './runtimeConfig';
import type {
  NetworkAvailability,
  NetworkState,
  VayriaHealthResponse,
} from './networkState';

const POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 2_000;

const INITIAL_NETWORK_STATE: NetworkState = {
  localNetwork: 'available',
  internet: 'unavailable',
};

function isAvailability(value: unknown): value is NetworkAvailability {
  return value === 'available' || value === 'unavailable';
}

function isHealthResponse(value: unknown): value is VayriaHealthResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<VayriaHealthResponse>;
  return Boolean(
    response.ok === true &&
      response.network &&
      isAvailability(response.network.localNetwork) &&
      isAvailability(response.network.internet),
  );
}

export function useNetworkState(enabled: boolean): NetworkState {
  const [state, setState] = useState<NetworkState>(INITIAL_NETWORK_STATE);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    let active = true;
    let request: AbortController | null = null;

    const load = async (): Promise<void> => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const timeout = window.setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );
      try {
        const response = await fetch(apiUrl('/api/health'), {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Health request failed: ${response.status}`);
        }
        const payload: unknown = await response.json();
        if (!active || !isHealthResponse(payload)) {
          throw new Error('Invalid health response.');
        }
        setState(payload.network);
      } catch {
        if (!active) return;
        setState((current) => ({
          localNetwork: 'unavailable',
          internet: current.internet,
        }));
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const handleConnectivityChange = (): void => {
      void load();
    };
    window.addEventListener('online', handleConnectivityChange);
    window.addEventListener('offline', handleConnectivityChange);
    void load();
    const interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);

    return () => {
      active = false;
      request?.abort();
      window.clearInterval(interval);
      window.removeEventListener('online', handleConnectivityChange);
      window.removeEventListener('offline', handleConnectivityChange);
    };
  }, [enabled]);

  return state;
}
