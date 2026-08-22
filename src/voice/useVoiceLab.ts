import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../runtimeConfig';
import {
  createEmptySummary,
  type AudioLabMode,
  type ExhibitionAudioPreset,
  type VoiceInputDiagnostic,
  type VoiceLabRecord,
  type VoiceLabSnapshot,
} from './audioLab.js';
import { VoiceLabRecorder } from './voiceLabRecorder.js';
import type { VoiceInputEvent } from './voiceInput.js';

export interface UseVoiceLabOptions {
  enabled: boolean;
  mode: AudioLabMode;
  preset: ExhibitionAudioPreset;
  ttsPlaying: boolean;
}

function createDisabledSnapshot(): VoiceLabSnapshot {
  return {
    sessionId: null,
    records: [],
    summary: createEmptySummary(),
    latestRecord: null,
    latestTranscript: '',
    latestError: null,
  };
}

function postVoiceLabRecord(record: VoiceLabRecord): void {
  void fetch(apiUrl('/api/voice-lab/events'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record }),
    keepalive: true,
  }).catch(() => {
    // Diagnostic persistence must not change the conversation result.
  });
}

export function useVoiceLab(options: UseVoiceLabOptions): {
  snapshot: VoiceLabSnapshot;
  handleDiagnostic: (diagnostic: VoiceInputDiagnostic) => void;
  handleVoiceEvent: (event: VoiceInputEvent) => void;
  downloadJsonl: () => void;
} {
  const recorderRef = useRef<VoiceLabRecorder | null>(null);
  const optionsRef = useRef(options);
  const [snapshot, setSnapshot] = useState<VoiceLabSnapshot>(
    createDisabledSnapshot,
  );

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    if (!options.enabled) return;

    let recorder = recorderRef.current;
    if (!recorder) {
      const nextRecorder = new VoiceLabRecorder({
        enabled: true,
        mode: optionsRef.current.mode,
        preset: optionsRef.current.preset,
        onRecord: (record) => {
          setSnapshot(nextRecorder.getSnapshot());
          postVoiceLabRecord(record);
        },
      });
      recorder = nextRecorder;
      recorderRef.current = recorder;
      recorder.start();
    }

    const finish = () => {
      recorder.finish();
    };
    window.addEventListener('pagehide', finish);
    return () => {
      window.removeEventListener('pagehide', finish);
    };
  }, [options.enabled]);

  useEffect(() => {
    const recorder = recorderRef.current;
    if (!recorder || !options.enabled) return;
    recorder.setMode(options.mode);
    setSnapshot(recorder.getSnapshot());
  }, [options.enabled, options.mode]);

  useEffect(() => {
    const recorder = recorderRef.current;
    if (!recorder || !options.enabled) return;
    recorder.setTtsPlaying(options.ttsPlaying);
  }, [options.enabled, options.ttsPlaying]);

  const handleDiagnostic = useCallback((diagnostic: VoiceInputDiagnostic) => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorder.handleDiagnostic(diagnostic);
    setSnapshot(recorder.getSnapshot());
  }, []);

  const handleVoiceEvent = useCallback((event: VoiceInputEvent) => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorder.handleVoiceEvent(event);
    setSnapshot(recorder.getSnapshot());
  }, []);

  const downloadJsonl = useCallback(() => {
    const current = recorderRef.current?.getSnapshot() ?? snapshot;
    if (!current.sessionId) return;

    const exportRecords = [...current.records];
    if (!exportRecords.some((record) => record.kind === 'session_summary')) {
      exportRecords.push({
        kind: 'session_summary',
        timestamp: new Date().toISOString(),
        sessionId: current.sessionId,
        preset: optionsRef.current.preset,
        summary: current.summary,
      });
    }
    const contents = exportRecords.map((record) => JSON.stringify(record));
    const blob = new Blob([`${contents.join('\n')}\n`], {
      type: 'application/x-ndjson;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${current.sessionId}-events.jsonl`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [snapshot]);

  return { snapshot, handleDiagnostic, handleVoiceEvent, downloadJsonl };
}
