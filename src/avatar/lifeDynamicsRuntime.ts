import {
  resolveLifeDynamicsProfileId,
  type LifeDynamicsProfileId,
} from './lifeDynamics.js';

export type LifeDynamicsGazeProbeMode =
  | 'full'
  | 'eye-only'
  | 'no-neck'
  | 'fixed-target';

export interface LifeDynamicsRuntimeOptions {
  readonly enabled: boolean;
  readonly debug: boolean;
  readonly profileId: LifeDynamicsProfileId;
  readonly gazeProbe: LifeDynamicsGazeProbeMode;
}

/** Resolves the production LifeDynamics mode and its diagnostic options. */
export function resolveLifeDynamicsRuntimeOptions(
  search: string,
): LifeDynamicsRuntimeOptions {
  const params = new URLSearchParams(search);
  const enabled = params.get('life-dynamics') !== 'legacy';
  const debug = enabled && params.get('life-dynamics-debug') === '1';

  return {
    enabled,
    debug,
    profileId: resolveLifeDynamicsProfileId(
      params.get('life-dynamics-profile'),
    ),
    gazeProbe: debug
      ? readGazeProbe(
          params.get('gazeProbe') ??
            params.get('life-dynamics-gaze-probe'),
        )
      : 'full',
  };
}

function readGazeProbe(value: string | null): LifeDynamicsGazeProbeMode {
  switch (value) {
    case 'eye-only':
    case 'no-neck':
    case 'fixed-target':
      return value;
    default:
      return 'full';
  }
}
