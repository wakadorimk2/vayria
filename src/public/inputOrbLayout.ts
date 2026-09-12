export function smoothInputLevel(previous: number, level: number | null, milliseconds: number) {
  const target = level !== null && Number.isFinite(level) ? Math.min(1, Math.max(0, level - .025) / .975) : 0;
  return previous + (target - previous) * (1 - Math.exp(-milliseconds / (target > previous ? 70 : 220)));
}
