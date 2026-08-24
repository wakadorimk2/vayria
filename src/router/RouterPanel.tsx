import { useCallback, useEffect, useState } from 'react';
import type {
  RouterCaseId,
  RouterCommand,
  RouterLane,
  RouterSignal,
  RouterSnapshot,
} from './routerTypes.js';
import { ROUTER_CASE_IDS } from './routerTypes.js';

interface AudioInputDevice {
  deviceId: string;
  label: string;
}

interface RouterPanelProps {
  snapshot: RouterSnapshot;
  isVoiceInputEnabled: boolean;
  selectedInputDeviceId: string;
  onCommand: (command: RouterCommand) => void;
  onObserve: (signal: RouterSignal) => void;
  onInputDeviceChange: (deviceId: string) => void;
}

const CASE_LABELS: Record<RouterCaseId, string> = {
  voice_listener_reaction: 'voice_listener_reaction',
  interruption: 'interruption',
  continuity_variation: 'continuity_variation（6往復）',
};

function laneLabel(lane: RouterLane): string {
  switch (lane) {
    case 'idle':
      return 'idle';
    case 'listening':
      return 'listening';
    case 'speaking':
      return 'speaking';
  }
}

export function RouterPanel({
  snapshot,
  isVoiceInputEnabled,
  selectedInputDeviceId,
  onCommand,
  onObserve,
  onInputDeviceChange,
}: RouterPanelProps) {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<RouterCaseId>(
    snapshot.caseId ?? 'voice_listener_reaction',
  );

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const nextDevices = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `入力デバイス ${index + 1}`,
        }));
      setDevices(nextDevices);
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    const refreshTimer = window.setTimeout(() => {
      void refreshDevices();
    }, 0);
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) {
      return () => window.clearTimeout(refreshTimer);
    }
    mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => {
      window.clearTimeout(refreshTimer);
      mediaDevices.removeEventListener('devicechange', refreshDevices);
    };
  }, [refreshDevices]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      const commandByKey: Record<string, RouterCommand> = {
        V: { type: 'stop_vayria' },
        G: { type: 'stop_gpt_lane' },
        F: { type: 'take_floor' },
        C: { type: 'let_continue' },
        R: { type: 'reset' },
      };
      const command = commandByKey[event.key.toUpperCase()];
      if (!command) return;
      event.preventDefault();
      onCommand(command);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCommand]);

  return (
    <aside className="conversation-router-panel" aria-label="Conversation Router">
      <details open>
        <summary>Conversation Router · dev</summary>
        <div className="conversation-router-panel__body">
          <div className="conversation-router-panel__status-grid">
            <div>
              <dt>control</dt>
              <dd>{snapshot.controlState}</dd>
            </div>
            <div>
              <dt>Vayria</dt>
              <dd>{laneLabel(snapshot.vayriaLane)}</dd>
            </div>
            <div>
              <dt>GPT</dt>
              <dd>{laneLabel(snapshot.gptLane)}</dd>
            </div>
            <div>
              <dt>GPT→Vayria</dt>
              <dd>{snapshot.gptInputGate}</dd>
            </div>
            <div>
              <dt>Vayria output</dt>
              <dd>{snapshot.vayriaOutputGate}</dd>
            </div>
          </div>

          <p className="conversation-router-panel__hint">
            Human操作はUIまたは Ctrl+Shift+V/G/F/C/R で確定します。
          </p>

          <div className="conversation-router-panel__actions">
            <button type="button" onClick={() => onCommand({ type: 'stop_vayria' })}>
              Stop Vayria
            </button>
            <button type="button" onClick={() => onCommand({ type: 'stop_gpt_lane' })}>
              Stop GPT lane
            </button>
            <button type="button" onClick={() => onCommand({ type: 'take_floor' })}>
              Take Floor
            </button>
            <button type="button" onClick={() => onCommand({ type: 'let_continue' })}>
              Let Continue
            </button>
            <button type="button" onClick={() => onCommand({ type: 'reset' })}>
              Reset
            </button>
          </div>

          <label className="conversation-router-panel__field">
            <span>評価ケース</span>
            <select
              value={selectedCaseId}
              onChange={(event) =>
                setSelectedCaseId(event.target.value as RouterCaseId)
              }
            >
              {ROUTER_CASE_IDS.map((caseId) => (
                <option key={caseId} value={caseId}>
                  {CASE_LABELS[caseId]}
                </option>
              ))}
            </select>
          </label>
          <div className="conversation-router-panel__actions">
            <button
              type="button"
              disabled={snapshot.caseActive}
              onClick={() => onCommand({ type: 'case_start', caseId: selectedCaseId })}
            >
              Case Start
            </button>
            <button
              type="button"
              disabled={!snapshot.caseActive}
              onClick={() => onCommand({ type: 'case_finish' })}
            >
              Case Finish
            </button>
          </div>

          <label className="conversation-router-panel__field">
            <span>Remote PCM入力</span>
            <select
              value={selectedInputDeviceId}
              disabled={isVoiceInputEnabled}
              onChange={(event) => onInputDeviceChange(event.target.value)}
            >
              <option value="">既定の入力デバイス</option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </label>
          <p className="conversation-router-panel__hint">
            デバイスIDはローカル設定だけに保持します。JSONLには保存しません。
          </p>

          <label className="conversation-router-panel__field">
            <span>GPT lane監視値</span>
            <select
              value={snapshot.gptLane}
              onChange={(event) =>
                onObserve({
                  type: 'gpt_status',
                  lane: event.target.value as RouterLane,
                })
              }
            >
              {(['idle', 'listening', 'speaking'] as const).map((lane) => (
                <option key={lane} value={lane}>
                  {lane}
                </option>
              ))}
            </select>
          </label>

          <dl className="conversation-router-panel__metrics">
            <div><dt>case</dt><dd>{snapshot.caseId ?? '—'}</dd></div>
            <div><dt>turns</dt><dd>{snapshot.metrics.turnCount}</dd></div>
            <div><dt>transition errors</dt><dd>{snapshot.metrics.stateTransitionErrors}</dd></div>
            <div><dt>false / confirmed</dt><dd>{snapshot.metrics.falseInterruptions} / {snapshot.metrics.confirmedInterruptions}</dd></div>
            <div><dt>interrupt latency</dt><dd>{snapshot.metrics.interruptionLatencyMs === null ? '—' : `${snapshot.metrics.interruptionLatencyMs} ms`}</dd></div>
            <div><dt>backchannel repeat</dt><dd>{snapshot.metrics.backchannelRepetitions}</dd></div>
            <div><dt>gate blocked</dt><dd>{snapshot.metrics.gateBlockedCount}</dd></div>
            <div><dt>cooldown</dt><dd>{snapshot.metrics.cooldownMs} ms</dd></div>
          </dl>
        </div>
      </details>
    </aside>
  );
}
