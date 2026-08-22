import {
  DirectionalLight,
  HemisphereLight,
  type Scene,
} from 'three';
import { STAGE_PRESET } from './stagePreset';

interface StageLighting {
  hemisphere: {
    skyColor: string;
    groundColor: string;
    intensity: number;
  };
  key: {
    color: string;
    intensity: number;
    position: readonly [number, number, number];
  };
  fill: {
    color: string;
    intensity: number;
    position: readonly [number, number, number];
  };
  back: {
    color: string;
    intensity: number;
    position: readonly [number, number, number];
  };
}

export function setupStageLighting(
  scene: Scene,
  lighting: StageLighting = STAGE_PRESET.lighting,
): void {
  const hemisphere = lighting.hemisphere;
  scene.add(
    new HemisphereLight(
      hemisphere.skyColor,
      hemisphere.groundColor,
      hemisphere.intensity,
    ),
  );

  addDirectionalLight(scene, lighting.key);
  addDirectionalLight(scene, lighting.fill);
  addDirectionalLight(scene, lighting.back);
}

function addDirectionalLight(
  scene: Scene,
  preset: {
    color: string;
    intensity: number;
    position: readonly [number, number, number];
  },
): void {
  const light = new DirectionalLight(preset.color, preset.intensity);
  light.position.set(...preset.position);
  scene.add(light);
}
