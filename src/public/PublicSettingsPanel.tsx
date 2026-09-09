import type { SettingsLayout } from './settingsLayout';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export default function PublicSettingsPanel({ layout, open, onClose, children }: {
  layout: SettingsLayout; open: boolean; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    panel.inert = !open;
    if (!open) return;
    panel.querySelector<HTMLElement>('.public-controls__close')?.focus();
    panel.querySelector('.public-controls__panel-body')?.scrollTo(0, 0);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      // Keep focus with another toolbar action when switching to cards or text.
      if (panel.contains(document.activeElement)) {
        document.querySelector<HTMLElement>('.public-controls__disclosure')?.focus();
      }
    };
  }, [open, onClose]);
  return <div ref={ref} id="public-session-panel" className="public-controls__panel" data-open={open} data-layout={layout.mode} style={layout.mode === 'sidebar' ? { width: layout.width } : undefined}
    data-avatar-offset={open ? layout.avatarOffset : 0} role="dialog" aria-modal="false" aria-hidden={!open} aria-labelledby="public-settings-title">
    <div className="public-controls__panel-header">
      <h2 id="public-settings-title">設定</h2>
      <button className="public-controls__close" aria-label="閉じる" title="閉じる" onClick={onClose}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>
    <div className="public-controls__panel-body">{children}</div>
  </div>;
}
