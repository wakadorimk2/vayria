import type {
  MotionAssetDescriptor,
  MotionProvider,
  MotionRequest,
} from '../../src/avatar/motion/motionTypes.js';
import {
  isMotionAssetDescriptor,
  type MotionServiceGenerateResponse,
  type MotionServiceHealth,
} from './motionContracts.js';

export interface ArdyMotionServiceConfig {
  baseUrl: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class ArdyMotionProvider implements MotionProvider {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;

  constructor(config: ArdyMotionServiceConfig) {
    this.baseUrl = new URL(config.baseUrl);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (this.timeoutMs <= 0 || !Number.isFinite(this.timeoutMs)) {
      throw new Error('ARDY motion service timeout must be positive.');
    }
  }

  async generate(
    request: MotionRequest,
    signal: AbortSignal,
  ): Promise<MotionAssetDescriptor> {
    const payload = await this.requestJson<MotionServiceGenerateResponse>(
      '/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request }),
      },
      signal,
    );
    if (!isMotionAssetDescriptor(payload.asset) || payload.asset.source !== 'ardy') {
      throw new Error('ARDY motion service returned an invalid asset descriptor.');
    }
    return payload.asset;
  }

  async health(signal?: AbortSignal): Promise<MotionServiceHealth> {
    try {
      const payload = await this.requestJson<MotionServiceHealth>(
        '/health',
        { method: 'GET' },
        signal,
      );
      if (
        payload.status !== 'loading' &&
        payload.status !== 'ready' &&
        payload.status !== 'error' &&
        payload.status !== 'unavailable'
      ) {
        throw new Error('ARDY motion service returned an invalid health status.');
      }
      return payload;
    } catch (error) {
      return {
        status: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async requestJson<T>(
    pathname: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await fetch(new URL(pathname, this.baseUrl), {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `ARDY motion service returned HTTP ${response.status}.`,
        );
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
