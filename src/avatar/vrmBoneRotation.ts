/**
 * Rotation values expressed in the local Euler space of a normalized VRM bone.
 */
export interface VrmBoneBias {
  readonly yawDegrees: number;
  readonly pitchDegrees: number;
}

/**
 * Viewer pitch is positive toward the top of the screen.
 * VRM head and neck bone pitch uses the opposite Euler X direction.
 */
export function toVrmBonePitchDegrees(viewerPitchDegrees: number): number {
  if (viewerPitchDegrees === 0) return 0;
  return -viewerPitchDegrees;
}
