import type { StreamObserverStatus } from './streamObserver.js';
import './streamUi.css';

interface StreamPanelProps {
  status: StreamObserverStatus;
  captureError: string | null;
  onStart: () => Promise<void>;
  onStop: () => void;
}

const formatTime = (at: number | null): string =>
  at === null ? '—' : new Date(at).toLocaleTimeString();

// Minimal stream-mode control: manual screen-share start (the browser
// requires a user gesture), capture/observe health, and the latest
// detected change summary.
export function StreamPanel({
  status,
  captureError,
  onStart,
  onStop,
}: StreamPanelProps) {
  const sharing = status.capturing;
  const summary = status.lastObservation?.changeSummary ?? '';
  return (
    <div className="stream-panel" role="status" aria-live="polite">
      {sharing ? (
        <button type="button" onClick={() => onStop()}>
          共有を停止
        </button>
      ) : (
        <button type="button" onClick={() => void onStart()}>
          画面共有を開始
        </button>
      )}
      <span className="stream-panel__status">
        {captureError
          ? `共有エラー: ${captureError}`
          : sharing
            ? `観測中 / 最終判定 ${formatTime(status.lastObserveAt)}`
            : '未共有'}
      </span>
      {sharing && summary && (
        <span className="stream-panel__summary" title={summary}>
          {summary}
        </span>
      )}
      {sharing && status.episodeSummary && (
        <span
          className="stream-panel__episode"
          title={status.episodeSummary}
        >
          ⚔ {status.episodeSummary}
        </span>
      )}
      {status.consecutiveErrors > 0 && (
        <span className="stream-panel__errors">
          エラー×{status.consecutiveErrors}
        </span>
      )}
    </div>
  );
}
