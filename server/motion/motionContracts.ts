import type {
  MotionAssetDescriptor,
  MotionRequest,
  MotionSource,
} from '../../src/avatar/motion/motionTypes.js';

export interface MotionServiceGenerateRequest {
  request: MotionRequest;
}

export interface MotionServiceGenerateResponse {
  asset: MotionAssetDescriptor;
}

export type MotionServiceStatus = 'loading' | 'ready' | 'error' | 'unavailable';

export interface MotionServiceHealth {
  status: MotionServiceStatus;
  provider?: MotionSource;
  detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isMotionAssetDescriptor(
  value: unknown,
): value is MotionAssetDescriptor {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.assetId === 'string' &&
    value.format === 'vrma' &&
    (value.source === 'saved' || value.source === 'ardy') &&
    typeof value.url === 'string' &&
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    value.durationMs > 0 &&
    typeof value.fps === 'number' &&
    Number.isFinite(value.fps) &&
    value.fps > 0 &&
    typeof value.loop === 'boolean' &&
    Array.isArray(value.tags) &&
    typeof value.correctionProfileId === 'string' &&
    typeof value.contentSha256 === 'string'
  );
}
