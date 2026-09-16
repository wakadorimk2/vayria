import type { FormEvent } from 'react';

interface MuteVolumeControlsProps {
  isMuted: boolean;
  onMuteToggle: () => void;
  onVolumeInput: (event: FormEvent<HTMLInputElement>) => void;
  volume: number;
}

export function MuteVolumeControls({
  isMuted,
  onMuteToggle,
  onVolumeInput,
  volume,
}: MuteVolumeControlsProps) {
  const volumePercent = Math.round(volume * 100);
  return (
    <>
      <button
        aria-label={
          isMuted ? '音声をオンにする' : '音声をミュートする'
        }
        aria-pressed={isMuted}
        className="mute-button"
        onClick={onMuteToggle}
        title={isMuted ? 'Muted' : 'Autonomous talk active'}
        type="button"
      >
        <span aria-hidden="true">{isMuted ? '🔇' : '🔊'}</span>
      </button>
      <label className="visually-hidden" htmlFor="playback-volume">
        再生音量
      </label>
      <input
        aria-valuetext={
          isMuted
            ? `ミュート中、設定音量 ${volumePercent}%`
            : `音量 ${volumePercent}%`
        }
        className="volume-slider"
        id="playback-volume"
        max="100"
        min="0"
        onInput={onVolumeInput}
        step="5"
        type="range"
        value={volumePercent}
      />
      <span className="volume-value" aria-hidden="true">
        {volumePercent}%
      </span>
    </>
  );
}
