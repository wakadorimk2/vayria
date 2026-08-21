import {
  Color,
  DirectionalLight,
  HemisphereLight,
  type Scene,
} from 'three';
import { STAGE_PRESET } from './stagePreset';

export function setupStageLighting(scene: Scene): void {
  scene.background = new Color(STAGE_PRESET.backgroundColor);

  const hemisphere = STAGE_PRESET.lighting.hemisphere;
  scene.add(
    new HemisphereLight(
      hemisphere.skyColor,
      hemisphere.groundColor,
      hemisphere.intensity,
    ),
  );

  addDirectionalLight(scene, STAGE_PRESET.lighting.key);
  addDirectionalLight(scene, STAGE_PRESET.lighting.fill);
  addDirectionalLight(scene, STAGE_PRESET.lighting.back);
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
