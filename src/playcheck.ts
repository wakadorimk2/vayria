export const PLAYCHECK_RUN_ID_PATTERN = /^pc-[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

export function isPlaycheckRunId(value: unknown): value is string {
  return typeof value === 'string' && PLAYCHECK_RUN_ID_PATTERN.test(value);
}

export function readPlaycheckRunId(search: string): string | null {
  try {
    const value = new URLSearchParams(search).get('playcheckRunId');
    return isPlaycheckRunId(value) ? value : null;
  } catch {
    return null;
  }
}
