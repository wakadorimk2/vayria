import { useLayoutEffect, useRef } from 'react';

// Keep closing panels visible for the fade, but immediately remove interaction.
export function usePanelVisibility<T extends HTMLElement>(open: boolean, trigger: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    if (!open && panel.contains(document.activeElement)) {
      document.querySelector<HTMLElement>(trigger)?.focus();
    }
    panel.inert = !open;
    panel.setAttribute('aria-hidden', String(!open));
  }, [open, trigger]);
  return ref;
}
