import type {
  AudioLabMediaSettings,
  AudioLabMode,
  VoiceLabSnapshot,
} from './audioLab.js';
import {
  VAD_THRESHOLD_MAX,
  VAD_THRESHOLD_MIN,
  VAD_THRESHOLD_STEP,
  type BargeInState,
} from './audioLab.js';

const MODE_LABELS: Record<AudioLabMode, string> = {
  baseline: 'Baseline',
  processed: 'Processed',
  'processed-vad': 'Processed + VAD',
  'exhibition-mix': 'Exhibition Mix',
};

interface AudioLabPanelProps {
  mode: AudioLabMode;
  onModeChange: (mode: AudioLabMode) => void;
  onVoiceToggle: () => void;
  vadThreshold: number;
  noiseFloor: number | null;
  effectiveThreshold: number | null;
  bargeInState: BargeInState;
  onVadThresholdChange: (threshold: number) => void;
  isMicActive: boolean;
  isVoiceInputSupported: boolean;
  isVadSpeech: boolean;
  isSttProcessing: boolean;
  ttsPlaying: boolean;
  audioLevel: number | null;
  vadScore: number | null;
  mediaSettings: AudioLabMediaSettings | null;
  snapshot: VoiceLabSnapshot;
  onExport: () => void;
}

function formatScore(value: number | null): string {
  return value === null ? 'Unavailable' : value.toFixed(3);
}

function formatLatency(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`;
}

function latestUtterance(snapshot: VoiceLabSnapshot) {
  for (let index = snapshot.records.length - 1; index >= 0; index -= 1) {
    const record = snapshot.records[index];
    if (record?.kind === 'utterance') return record;
  }
  return null;
}

export function AudioLabPanel({
  mode,
  onModeChange,
  onVoiceToggle,
  vadThreshold,
  noiseFloor,
  effectiveThreshold,
  bargeInState,
  onVadThresholdChange,
  isMicActive,
  isVoiceInputSupported,
  isVadSpeech,
  isSttProcessing,
  ttsPlaying,
  audioLevel,
  vadScore,
  mediaSettings,
  snapshot,
  onExport,
}: AudioLabPanelProps) {
  const utterance = latestUtterance(snapshot);
  const summary = snapshot.summary;

  return (
    <aside className="audio-lab-panel" aria-label="Audio Lab">
      <details open>
        <summary>Audio Lab</summary>
        <div className="audio-lab-panel__body">
          <button
            className="audio-lab-panel__voice-toggle"
            disabled={!isVoiceInputSupported}
            onClick={onVoiceToggle}
            type="button"
          >
            {isMicActive ? 'Stop mic input' : 'Start mic input'}
          </button>
          <label className="audio-lab-panel__field" htmlFor="audio-lab-mode">
            <span>Audio mode</span>
            <select
              disabled={isMicActive}
              id="audio-lab-mode"
              onChange={(event) => onModeChange(event.target.value as AudioLabMode)}
              value={mode}
            >
              {(Object.keys(MODE_LABELS) as AudioLabMode[]).map((value) => (
                <option key={value} value={value}>
                  {MODE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <p className="audio-lab-panel__hint">
            {isMicActive
              ? '音声入力を停止するとModeを変更できます。'
              : mode === 'exhibition-mix'
                ? 'Audio Labの初期ModeはExhibition Mixです。'
                : 'Mode Aは既存経路です。'}
          </p>

          <label className="audio-lab-panel__field" htmlFor="audio-lab-vad-threshold">
            <span>VAD threshold</span>
            <output htmlFor="audio-lab-vad-threshold">
              {vadThreshold.toFixed(3)}
            </output>
            <input
              id="audio-lab-vad-threshold"
              max={VAD_THRESHOLD_MAX}
              min={VAD_THRESHOLD_MIN}
              onChange={(event) => onVadThresholdChange(Number(event.target.value))}
              step={VAD_THRESHOLD_STEP}
              type="range"
              value={vadThreshold}
            />
          </label>

          <div className="audio-lab-panel__meter-block">
            <div className="audio-lab-panel__meter-heading">
              <span>Microphone level</span>
              <span>{formatScore(audioLevel)}</span>
            </div>
            <meter
              aria-label="Microphone audio level"
              max="1"
              min="0"
              value={audioLevel ?? 0}
            />
            <div className="audio-lab-panel__meter-heading">
              <span>VAD score (RMS)</span>
              <span>{formatScore(vadScore)}</span>
            </div>
            {mode === 'exhibition-mix' && (
              <>
                <div className="audio-lab-panel__meter-heading">
                  <span>Adaptive noise floor</span>
                  <span>{formatScore(noiseFloor)}</span>
                </div>
                <div className="audio-lab-panel__meter-heading">
                  <span>Effective threshold</span>
                  <span>{formatScore(effectiveThreshold)}</span>
                </div>
              </>
            )}
          </div>

          <dl className="audio-lab-panel__status-grid">
            <div>
              <dt>Mic</dt>
              <dd data-active={isMicActive}>{isMicActive ? 'active' : 'idle'}</dd>
            </div>
            <div>
              <dt>VAD speech</dt>
              <dd data-active={isVadSpeech}>{isVadSpeech ? 'yes' : 'no'}</dd>
            </div>
            <div>
              <dt>STT</dt>
              <dd data-active={isSttProcessing}>{isSttProcessing ? 'processing' : 'idle'}</dd>
            </div>
            <div>
              <dt>TTS</dt>
              <dd data-active={ttsPlaying}>{ttsPlaying ? 'playing' : 'idle'}</dd>
            </div>
            <div>
              <dt>Barge-in</dt>
              <dd data-active={bargeInState === 'ducked'}>{bargeInState}</dd>
            </div>
            <div>
              <dt>TTS ducked</dt>
              <dd data-active={bargeInState === 'ducked'}>
                {bargeInState === 'ducked' ? 'yes' : 'no'}
              </dd>
            </div>
          </dl>

          <div className="audio-lab-panel__section">
            <h2>Applied MediaTrack settings</h2>
            <pre>
              {mediaSettings
                ? JSON.stringify(mediaSettings, null, 2)
                : 'Unavailable'}
            </pre>
            <p className="audio-lab-panel__hint">
              Input channels:{' '}
              {mediaSettings?.applied.channelCount ?? 'Unavailable'}
            </p>
          </div>

          <div className="audio-lab-panel__section" aria-live="polite">
            <h2>Latest utterance</h2>
            <p>{utterance?.recognizedText || snapshot.latestTranscript || '—'}</p>
            {utterance && (
              <p className="audio-lab-panel__hint">
                {MODE_LABELS[utterance.mode]} / latency {formatLatency(utterance.sttLatencyMs)} /{' '}
                {utterance.vadAccepted === null
                  ? 'VAD n/a'
                  : utterance.vadAccepted
                    ? 'VAD accepted'
                    : 'VAD rejected'}
              </p>
            )}
          </div>

          <div className="audio-lab-panel__section" aria-live="polite">
            <h2>Latest error</h2>
            <p>{snapshot.latestError ?? '—'}</p>
          </div>

          <div className="audio-lab-panel__section">
            <h2>Session summary</h2>
            <p className="audio-lab-panel__hint">
              {snapshot.sessionId ?? 'No session'} / average STT latency {formatLatency(summary.averageSttLatencyMs)}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Mode</th>
                  <th>Candidates</th>
                  <th>Utterances</th>
                  <th>STT ok</th>
                  <th>VAD reject</th>
                  <th>Noise-like</th>
                  <th>Known</th>
                  <th>TTS overlap</th>
                  <th>Avg latency</th>
                  <th>Barge-in</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(MODE_LABELS) as AudioLabMode[]).map((value) => {
                  const modeSummary = summary.byMode[value];
                  return (
                    <tr key={value}>
                      <th scope="row">{MODE_LABELS[value]}</th>
                      <td>{modeSummary.candidateCount}</td>
                      <td>{modeSummary.utteranceCount}</td>
                      <td>{modeSummary.sttSuccessCount}</td>
                      <td>{modeSummary.vadRejectCount}</td>
                      <td>{modeSummary.noiseLikeSttCount}</td>
                      <td>{modeSummary.knownHallucinationCount}</td>
                      <td>{modeSummary.ttsOverlapCount}</td>
                      <td>{formatLatency(modeSummary.averageSttLatencyMs)}</td>
                      <td>
                        {modeSummary.bargeInConfirmedCount}/
                        {modeSummary.bargeInTriggeredCount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button className="audio-lab-panel__export" onClick={onExport} type="button">
            Export JSONL
          </button>
        </div>
      </details>
    </aside>
  );
}
