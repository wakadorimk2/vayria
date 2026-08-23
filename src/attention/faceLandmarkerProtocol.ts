import type { AttentionPosition } from '../performer/types.js';

export type FaceLandmarkerWorkerRequest =
  | {
      type: 'init';
      modelAssetPath: string;
      wasmBasePath: string;
    }
  | {
      type: 'detect';
      frame: ImageBitmap;
      timestamp: number;
    }
  | {
      type: 'close';
    };

export type FaceLandmarkerWorkerResponse =
  | {
      type: 'ready';
    }
  | {
      type: 'result';
      position: AttentionPosition | null;
    }
  | {
      type: 'error';
      code: 'model-failed' | 'worker-failed';
    };
