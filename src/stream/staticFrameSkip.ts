// Mean absolute difference between two luminance grids, normalized to
// 0..1. Grids are produced by GameCapture from a heavily downscaled
// frame so small HUD flicker does not register as scene change.
export function computeLumaDiff(
  previous: Uint8ClampedArray,
  current: Uint8ClampedArray,
): number {
  const length = Math.min(previous.length, current.length);
  if (length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += Math.abs(current[index] - previous[index]);
  }
  return sum / (length * 255);
}

// A frame counts as static when its mean luminance change stays below
// the threshold. 0.02 matches the fixture extraction pipeline tuning.
export function isStaticFrame(diff: number, threshold = 0.02): boolean {
  return diff < threshold;
}
