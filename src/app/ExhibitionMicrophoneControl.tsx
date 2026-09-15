import type { RefObject } from 'react';
import {
  VAD_THRESHOLD_MAX,
  VAD_THRESHOLD_MIN,
  VAD_THRESHOLD_STEP,
} from '../voice/audioLab.js';
import {
  EXHIBITION_MICROPHONE_PANEL_ID,
  type ExhibitionMicrophoneView,
} from './useExhibitionMicrophone';

function MicrophoneIcon() {
  return (
    <svg
      aria-hidden="true"
      className="control-icon"
      viewBox="0 0 24 24"
      focusable="false"
    >
      <path
        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0m6 6v4m-3 0h6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

interface ExhibitionMicrophoneControlProps {
  controlRef: RefObject<HTMLDivElement | null>;
  onDisclosureToggle: () => void;
  onVadThresholdChange: (threshold: number) => void;
  onVoiceToggle: () => void;
  view: ExhibitionMicrophoneView;
}

export function ExhibitionMicrophoneControl({
  controlRef,
  onDisclosureToggle,
  onVadThresholdChange,
  onVoiceToggle,
  view,
}: ExhibitionMicrophoneControlProps) {
  return (
    <div
      ref={controlRef}
      className="microphone-control"
      data-expanded={view.expanded ? 'true' : 'false'}
    >
      <button
        aria-controls={EXHIBITION_MICROPHONE_PANEL_ID}
        aria-expanded={view.expanded}
        aria-label={view.disclosureLabel}
        aria-busy={view.pending}
        className="audio-unlock-button microphone-disclosure-button"
        data-input-active={view.inputActive ? 'true' : 'false'}
        data-state={view.visualState}
        data-threshold-crossing={
          view.thresholdCrossed ? 'true' : 'false'
        }
        disabled={view.pending}
        onClick={onDisclosureToggle}
        style={view.feedbackStyle}
        title={`${view.disclosureLabel}。${view.statusLabel}`}
        type="button"
      >
        <MicrophoneIcon />
        <span className="visually-hidden">
          {`${view.disclosureLabel}。${view.statusLabel}。`}
        </span>
      </button>
      <div
        aria-label="マイク入力と反応ライン"
        className="microphone-adjuster"
        data-gate={view.gateAvailable ? 'enabled' : 'disabled'}
        data-state={view.visualState}
        data-threshold-crossing={
          view.thresholdCrossed ? 'true' : 'false'
        }
        hidden={!view.expanded}
        id={EXHIBITION_MICROPHONE_PANEL_ID}
      >
        <div
          aria-label="マイク入力レベル"
          aria-valuemax={view.meterMax}
          aria-valuemin={0}
          aria-valuenow={view.meterValue}
          aria-valuetext={
            view.displayedAudioLevel === null
              ? '入力レベル未取得'
              : `入力レベル ${view.displayedAudioLevel.toFixed(3)}`
          }
          className="microphone-vertical-meter"
          role="meter"
        >
          <span
            className="microphone-vertical-meter__fill"
            style={{ height: `${view.levelPercent}%` }}
          />
          {view.thresholdPercent !== null && (
            <span
              aria-hidden="true"
              className="microphone-vertical-meter__threshold"
              style={{ bottom: `${view.thresholdPercent}%` }}
            />
          )}
          <span className="visually-hidden">
            {view.displayThreshold === null
              ? '実効反応ラインは利用できません'
              : `実効反応ライン ${view.displayThreshold.toFixed(3)}`}
          </span>
          <input
            aria-label="マイクの反応ライン設定"
            aria-valuemax={VAD_THRESHOLD_MAX}
            aria-valuemin={VAD_THRESHOLD_MIN}
            aria-valuenow={view.thresholdSettingValue}
            aria-valuetext={`設定した反応ライン ${view.thresholdSettingValue.toFixed(3)}`}
            className="microphone-vertical-meter__input"
            disabled={!view.gateAvailable}
            max={VAD_THRESHOLD_MAX}
            min={VAD_THRESHOLD_MIN}
            onInput={(event) =>
              onVadThresholdChange(
                Number(event.currentTarget.value),
              )
            }
            step={VAD_THRESHOLD_STEP}
            type="range"
            value={view.thresholdSettingValue}
          />
        </div>
        <button
          aria-label={view.toggleLabel}
          aria-busy={view.pending}
          aria-pressed={view.visuallyEnabled}
          className="microphone-adjuster__toggle"
          data-state={view.visualState}
          disabled={view.pending}
          onClick={onVoiceToggle}
          title={view.toggleLabel}
          type="button"
        >
          <span
            aria-hidden="true"
            className="microphone-adjuster__switch"
          >
            <span className="microphone-adjuster__switch-thumb" />
          </span>
          <span className="visually-hidden">
            {view.toggleLabel}
          </span>
        </button>
      </div>
    </div>
  );
}
