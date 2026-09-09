// Keep the existing production keys. Staging shares the origin, but not saved state.
export function environmentStorageKey(key: string): string {
  const browser = globalThis as typeof globalThis & { window?: { location?: { pathname?: string } } };
  const path = browser.window?.location?.pathname ?? '';
  return path === '/staging' || path.startsWith('/staging/') ? `staging:${key}` : key;
}
