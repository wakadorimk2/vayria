const key = 'vayria-tutorial-dismissed-v1';
export function tutorialDismissed() {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
export function dismissTutorial() {
  try { localStorage.setItem(key, 'true'); } catch { /* Still dismiss for this page. */ }
  window.dispatchEvent(new Event('vayria-tutorial-dismiss'));
}
