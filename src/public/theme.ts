import { environmentStorageKey } from '../storageKey';
export type ThemePreference = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
const key = environmentStorageKey('vayria-public-theme');
let preference: ThemePreference = 'auto';
let resolved: ResolvedTheme = 'light';
let media: MediaQueryList | null = null;
const listeners = new Set<() => void>();
export const readThemePreference = () => preference;
export const readResolvedTheme = () => resolved;
export const subscribeTheme = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function normalizeTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'auto';
}
function apply() {
  resolved = preference === 'auto' ? media?.matches ? 'dark' : 'light' : preference;
  document.documentElement.dataset.publicTheme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#292331' : '#cbbacb');
  for (const listener of listeners) listener();
}
export function initializePublicTheme() {
  if (media) return;
  try { preference = normalizeTheme(localStorage.getItem(key)); } catch { preference = 'auto'; }
  media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', apply);
  apply();
}
export function setThemePreference(value: ThemePreference) {
  preference = normalizeTheme(value);
  try { localStorage.setItem(key, preference); } catch { /* Keep the selection for this page. */ }
  apply();
}
