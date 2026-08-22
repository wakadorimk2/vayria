import type {
  VoiceInputDiagnostic,
  AudioLabMode,
  SttRuntimeInfo,
  VoiceLabRecord,
  VoiceLabSessionSummary,
  VoiceLabSnapshot,
  VoiceLabUtteranceRecord,
} from './audioLab.js';
import {
  createEmptySummary,
  calculatePerMinuteRate,
  DEFAULT_AUDIO_ENDPOINT_MS,
  DEFAULT_EXHIBITION_AUDIO_PRESET,
  findKnownHallucinationPhrase,
  millisecondsBetween,
  timestampFromMilliseconds,
  type AudioLabMediaSettings,
  type AudioEndpointMs,
  type ExhibitionAudioPreset,
  type VoiceLabModeSummary,
} from './audioLab.js';
import type { VoiceInputEvent } from './voiceInput.js';

interface ActiveUtterance {
  mode: AudioLabMode;
  segmentId: string;
  speechStartAt: string;
  speechEndAt: string | null;
  sttStartedAt: string | null;
  sttQueuedAt: string | null;
  sttObservedAt: string | null;
  rawText: string;
  acceptedText: string;
  maxVadScore: number | null;
  vadThreshold: number | null;
  effectiveThreshold: number | null;
  noiseFloor: number | null;
  ttsPlayingDuringUtterance: boolean;
  ttsCandidateStartedDuringTts: boolean;
  mediaTrackSettings: AudioLabMediaSettings | null;
}

interface PendingSttObservation {
  rawText: string;
  acceptedText: string;
  at: string;
}

export interface VoiceLabRecorderOptions {
  enabled: boolean;
  mode: AudioLabMode;
  preset?: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
  sessionId?: string;
  onRecord?: (record: VoiceLabRecord) => void;
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `vl-${crypto.randomUUID()}`;
  }
  return `vl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cloneSummary(summary: VoiceLabSessionSummary): VoiceLabSessionSummary {
  return {
    ...summary,
    byMode: {
      baseline: { ...summary.byMode.baseline },
      processed: { ...summary.byMode.processed },
      'processed-vad': { ...summary.byMode['processed-vad'] },
      'exhibition-mix': { ...summary.byMode['exhibition-mix'] },
    },
  };
}

function emptySnapshot(): VoiceLabSnapshot {
  return {
    sessionId: null,
    records: [],
    summary: createEmptySummary(),
    latestRecord: null,
    latestTranscript: '',
    latestError: null,
    sttRuntime: null,
  };
}

export class VoiceLabRecorder {
  private readonly enabled: boolean;
  private readonly onRecord?: (record: VoiceLabRecord) => void;
  private readonly sessionId: string | null;
  private currentMode: AudioLabMode;
  private readonly currentPreset: ExhibitionAudioPreset;
  private currentAudioEndpointMs: AudioEndpointMs;
  private currentSttRuntime: SttRuntimeInfo | null = null;
  private currentTtsPlaying = false;
  private currentTtsStartedAtMs: number | null = null;
  private currentTtsMode: AudioLabMode | null = null;
  private currentMediaSettings: AudioLabMediaSettings | null = null;
  private started = false;
  private records: VoiceLabRecord[] = [];
  private summary = createEmptySummary();
  private latestRecord: VoiceLabRecord | null = null;
  private latestTranscript = '';
  private latestError: string | null = null;
  private readonly activeUtterances = new Map<string, ActiveUtterance>();
  private readonly pendingSttObservations = new Map<
    string,
    PendingSttObservation
  >();
  private readonly pendingFinalizedEvents = new Map<
    string,
    Extract<VoiceInputEvent, { type: 'utterance_finalized' }>
  >();
  private pendingMaxVadScore: number | null = null;
  private pendingVadThreshold: number | null = null;
  private pendingEffectiveThreshold: number | null = null;
  private pendingNoiseFloor: number | null = null;
  private readonly latencyTotals = new Map<
    AudioLabMode,
    { count: number; totalMs: number }
  >();

  constructor(options: VoiceLabRecorderOptions) {
    this.enabled = options.enabled;
    this.currentMode = options.mode;
    this.currentPreset = options.preset ?? DEFAULT_EXHIBITION_AUDIO_PRESET;
    this.currentAudioEndpointMs =
      options.audioEndpointMs ?? DEFAULT_AUDIO_ENDPOINT_MS;
    this.sessionId = options.enabled
      ? options.sessionId ?? createSessionId()
      : null;
    this.onRecord = options.onRecord;
  }

  start(): void {
    if (!this.enabled || this.started || !this.sessionId) return;
    this.started = true;
    this.appendRecord({
      kind: 'session_started',
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      mode: this.currentMode,
      preset: this.currentPreset,
      audioEndpointMs: this.currentAudioEndpointMs,
    });
  }

  finish(): void {
    if (!this.enabled || !this.started || !this.sessionId) return;
    const finishedAtMs = Date.now();
    const finishedAt = timestampFromMilliseconds(finishedAtMs);
    this.closeTtsWindow(finishedAtMs);
    for (const [segmentId, finalizedEvent] of this.pendingFinalizedEvents) {
      const active = this.activeUtterances.get(segmentId);
      if (active) active.speechEndAt = finishedAt;
      this.pendingFinalizedEvents.delete(segmentId);
      this.recordFinalizedUtterance(finalizedEvent);
    }
    this.appendRecord({
      kind: 'session_summary',
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      preset: this.currentPreset,
      audioEndpointMs: this.currentAudioEndpointMs,
      summary: cloneSummary(this.summary),
    });
    this.started = false;
  }

  setMode(mode: AudioLabMode): void {
    if (this.currentMode === mode) return;
    this.currentMode = mode;
    this.currentMediaSettings = null;
    this.resetPendingVadMetrics();
    if (!this.enabled || !this.started || !this.sessionId) return;
    this.appendRecord({
      kind: 'mode_changed',
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      mode,
      preset: this.currentPreset,
      audioEndpointMs: this.currentAudioEndpointMs,
    });
  }

  setAudioEndpoint(audioEndpointMs: AudioEndpointMs): void {
    this.currentAudioEndpointMs = audioEndpointMs;
  }

  setTtsPlaying(isPlaying: boolean, at = Date.now()): void {
    if (this.currentTtsPlaying === isPlaying) {
      if (isPlaying) {
        for (const active of this.activeUtterances.values()) {
          active.ttsPlayingDuringUtterance = true;
        }
      }
      return;
    }

    if (isPlaying) {
      this.currentTtsPlaying = true;
      this.currentTtsStartedAtMs = Math.round(at);
      this.currentTtsMode = this.currentMode;
      for (const active of this.activeUtterances.values()) {
        active.ttsPlayingDuringUtterance = true;
      }
      return;
    }

    this.closeTtsWindow(at);
    this.currentTtsPlaying = false;
  }

  handleDiagnostic(diagnostic: VoiceInputDiagnostic): void {
    if (!this.enabled) return;
    switch (diagnostic.type) {
      case 'media_settings':
        this.currentMediaSettings = diagnostic.settings;
        return;
      case 'stt_runtime': {
        this.currentSttRuntime = diagnostic.runtime;
        if (!this.started || !this.sessionId) return;
        this.appendRecord({
          kind: 'stt_runtime',
          timestamp: timestampFromMilliseconds(diagnostic.at),
          sessionId: this.sessionId,
          mode: this.currentMode,
          preset: this.currentPreset,
          audioEndpointMs: this.currentAudioEndpointMs,
          runtime: diagnostic.runtime,
        });
        return;
      }
      case 'stt_queued': {
        const active = this.activeUtterances.get(diagnostic.segmentId);
        if (active) {
          active.sttQueuedAt = timestampFromMilliseconds(diagnostic.at);
        }
        return;
      }
      case 'stt_started': {
        const active = this.activeUtterances.get(diagnostic.segmentId);
        if (active) active.sttStartedAt = timestampFromMilliseconds(diagnostic.at);
        return;
      }
      case 'stt_observed': {
        this.pendingSttObservations.set(diagnostic.segmentId, {
          rawText: diagnostic.rawText,
          acceptedText: diagnostic.acceptedText,
          at: timestampFromMilliseconds(diagnostic.at),
        });
        const active = this.activeUtterances.get(diagnostic.segmentId);
        if (active) {
          active.rawText = diagnostic.rawText;
          active.acceptedText = diagnostic.acceptedText;
          active.sttObservedAt = timestampFromMilliseconds(diagnostic.at);
        }
        this.latestTranscript = diagnostic.acceptedText;
        return;
      }
      case 'barge_in': {
        const record = {
          kind: 'barge_in' as const,
          timestamp: timestampFromMilliseconds(diagnostic.at),
          sessionId: this.sessionId!,
          mode: this.currentMode,
          preset: this.currentPreset,
          audioEndpointMs: this.currentAudioEndpointMs,
          action: diagnostic.action,
          state: diagnostic.state,
          ttsPlaying: diagnostic.ttsPlaying,
          ...(diagnostic.reason ? { reason: diagnostic.reason } : {}),
        };
        this.appendRecord(record);
        this.updateBargeInSummary(record);
        return;
      }
      case 'audio_level': {
        if (diagnostic.vadScore === null) return;
        const active = this.activeUtterances.values().next().value as
          | ActiveUtterance
          | undefined;
        if (active) {
          active.maxVadScore = Math.max(
            active.maxVadScore ?? 0,
            diagnostic.vadScore,
          );
          active.vadThreshold = diagnostic.vadThreshold;
          active.effectiveThreshold = diagnostic.effectiveThreshold;
          active.noiseFloor = diagnostic.noiseFloor;
          return;
        }
        this.pendingMaxVadScore = Math.max(
          this.pendingMaxVadScore ?? 0,
          diagnostic.vadScore,
        );
        this.pendingVadThreshold = diagnostic.vadThreshold;
        this.pendingEffectiveThreshold = diagnostic.effectiveThreshold;
        this.pendingNoiseFloor = diagnostic.noiseFloor;
        return;
      }
      case 'vad_rejected':
        this.recordVadRejection(diagnostic);
        return;
    }
  }

  handleVoiceEvent(event: VoiceInputEvent): void {
    if (!this.enabled) return;
    switch (event.type) {
      case 'speech_started':
        this.activeUtterances.set(event.segmentId, {
          mode: this.currentMode,
          segmentId: event.segmentId,
          speechStartAt: timestampFromMilliseconds(event.at),
          speechEndAt: null,
          sttStartedAt: null,
          sttQueuedAt: null,
          sttObservedAt: null,
          rawText: this.pendingSttObservations.get(event.segmentId)?.rawText ?? '',
          acceptedText:
            this.pendingSttObservations.get(event.segmentId)?.acceptedText ?? '',
          maxVadScore: this.pendingMaxVadScore,
          vadThreshold: this.pendingVadThreshold,
          effectiveThreshold: this.pendingEffectiveThreshold,
          noiseFloor: this.pendingNoiseFloor,
          ttsPlayingDuringUtterance: this.currentTtsPlaying,
          ttsCandidateStartedDuringTts: this.currentTtsPlaying,
          mediaTrackSettings: this.currentMediaSettings,
        });
        this.resetPendingVadMetrics();
        return;
      case 'speech_ended': {
        const active = this.activeUtterances.get(event.segmentId);
        if (!active) return;
        active.speechEndAt = timestampFromMilliseconds(event.at);
        if (!active.sttStartedAt) active.sttStartedAt = active.speechEndAt;
        const pendingFinalizedEvent = this.pendingFinalizedEvents.get(
          event.segmentId,
        );
        if (pendingFinalizedEvent) {
          this.pendingFinalizedEvents.delete(event.segmentId);
          this.recordFinalizedUtterance(pendingFinalizedEvent);
        }
        return;
      }
      case 'interim_transcript_updated':
        this.latestTranscript = event.text;
        return;
      case 'utterance_finalized':
        if (
          this.activeUtterances.has(event.segmentId) &&
          !this.activeUtterances.get(event.segmentId)?.speechEndAt
        ) {
          this.pendingFinalizedEvents.set(event.segmentId, event);
          return;
        }
        this.recordFinalizedUtterance(event);
        return;
      case 'recognition_failed':
        this.latestError = event.code;
        this.appendRecord({
          kind: 'error',
          timestamp: timestampFromMilliseconds(event.at),
          sessionId: this.sessionId!,
          mode: this.currentMode,
          preset: this.currentPreset,
          audioEndpointMs: this.currentAudioEndpointMs,
          error: event.code,
          segmentId: null,
        });
        return;
      case 'recognition_stopped':
        for (const [segmentId, finalizedEvent] of this.pendingFinalizedEvents) {
          const active = this.activeUtterances.get(segmentId);
          if (active) active.speechEndAt = timestampFromMilliseconds(event.at);
          this.pendingFinalizedEvents.delete(segmentId);
          this.recordFinalizedUtterance(finalizedEvent);
        }
        for (const active of this.activeUtterances.values()) {
          this.latestError = 'recognition-stopped-before-result';
          this.appendRecord({
            kind: 'error',
            timestamp: timestampFromMilliseconds(event.at),
            sessionId: this.sessionId!,
            mode: active.mode,
            preset: this.currentPreset,
            audioEndpointMs: this.currentAudioEndpointMs,
            error: 'recognition-stopped-before-result',
            segmentId: active.segmentId,
          });
        }
        this.activeUtterances.clear();
        this.resetPendingVadMetrics();
        return;
      case 'listening_started':
        return;
    }
  }

  getSnapshot(): VoiceLabSnapshot {
    if (!this.enabled || !this.sessionId) return emptySnapshot();
    const summary = cloneSummary(this.summary);
    this.applyOpenTtsWindow(summary, Date.now());
    return {
      sessionId: this.sessionId,
      records: [...this.records],
      summary,
      latestRecord: this.latestRecord,
      latestTranscript: this.latestTranscript,
      latestError: this.latestError,
      sttRuntime: this.currentSttRuntime,
    };
  }

  private recordFinalizedUtterance(
    event: Extract<VoiceInputEvent, { type: 'utterance_finalized' }>,
  ): void {
    const active = this.activeUtterances.get(event.segmentId) ?? {
      mode: this.currentMode,
      segmentId: event.segmentId,
      speechStartAt: '',
      speechEndAt: null,
      sttStartedAt: null,
      sttQueuedAt: null,
      sttObservedAt: null,
      rawText: '',
      acceptedText: '',
      maxVadScore: null,
      vadThreshold: null,
      effectiveThreshold: null,
      noiseFloor: null,
      ttsPlayingDuringUtterance: this.currentTtsPlaying,
      ttsCandidateStartedDuringTts: this.currentTtsPlaying,
      mediaTrackSettings: this.currentMediaSettings,
    };
    const timestamp = timestampFromMilliseconds(event.at);
    const observation = this.pendingSttObservations.get(event.segmentId);
    const recognizedText = event.text.trim();
    const rawRecognizedText = (
      observation?.rawText || active.rawText || recognizedText
    ).trim();
    const knownHallucinationPhrase = findKnownHallucinationPhrase(
      rawRecognizedText || recognizedText,
    );
    const speechStartAt = active.speechStartAt || null;
    const speechEndAt = active.speechEndAt;
    const sttStartedAt =
      active.sttStartedAt ?? speechEndAt ?? speechStartAt;
    const sttObservedAt = active.sttObservedAt ?? observation?.at ?? null;
    const sttLatencyMs = millisecondsBetween(sttStartedAt, timestamp);
    const sttQueueWaitMs = millisecondsBetween(
      active.sttQueuedAt,
      active.sttStartedAt,
    );
    const sttProcessingMs = millisecondsBetween(
      active.sttStartedAt,
      sttObservedAt,
    );
    const endpointToResultLatencyMs = millisecondsBetween(
      speechEndAt,
      timestamp,
    );
    const speechToResultLatencyMs = millisecondsBetween(
      speechStartAt,
      timestamp,
    );
    const rejectReason = !recognizedText
      ? knownHallucinationPhrase
        ? 'known-hallucination-filtered'
        : 'empty-transcript'
      : null;
    const record: VoiceLabUtteranceRecord = {
      kind: 'utterance',
      timestamp,
      sessionId: this.sessionId!,
      mode: active.mode,
      preset: this.currentPreset,
      audioEndpointMs: this.currentAudioEndpointMs,
      segmentId: event.segmentId,
      speechStartAt,
      speechEndAt,
      sttStartedAt,
      sttResultAt: timestamp,
      sttLatencyMs,
      recognizedText,
      rawRecognizedText,
      audioDurationMs: millisecondsBetween(speechStartAt, speechEndAt),
      maxVadScore: active.maxVadScore,
      vadThreshold: active.vadThreshold,
      effectiveThreshold: active.effectiveThreshold,
      noiseFloor: active.noiseFloor,
      vadAccepted:
        active.mode === 'processed-vad' || active.mode === 'exhibition-mix'
          ? true
          : null,
      rejectReason,
      ttsPlayingDuringUtterance:
        active.ttsPlayingDuringUtterance || this.currentTtsPlaying,
      mediaTrackSettings: active.mediaTrackSettings,
      knownHallucinationPhrase,
      error: null,
      sttQueuedAt: active.sttQueuedAt,
      sttObservedAt,
      sttQueueWaitMs,
      sttProcessingMs,
      endpointToResultLatencyMs,
      speechToResultLatencyMs,
    };

    this.appendRecord(record);
    this.updateSummary(record, active.ttsCandidateStartedDuringTts);
    this.activeUtterances.delete(event.segmentId);
    this.pendingSttObservations.delete(event.segmentId);
    this.latestTranscript = recognizedText;
  }

  private recordVadRejection(diagnostic: Extract<VoiceInputDiagnostic, { type: 'vad_rejected' }>): void {
    if (!this.sessionId) return;
    const record = {
      kind: 'vad_rejected' as const,
      timestamp: timestampFromMilliseconds(diagnostic.at),
      sessionId: this.sessionId,
      mode: this.currentMode,
      preset: this.currentPreset,
      audioEndpointMs: this.currentAudioEndpointMs,
      speechStartAt: null,
      speechEndAt: timestampFromMilliseconds(diagnostic.at),
      audioDurationMs: Math.max(0, Math.round(diagnostic.candidateDurationMs)),
      vadAccepted: false as const,
      rejectReason: diagnostic.reason,
      maxVadScore: diagnostic.maxScore,
      vadThreshold: diagnostic.vadThreshold,
      effectiveThreshold: diagnostic.effectiveThreshold,
      noiseFloor: diagnostic.noiseFloor,
      ttsPlayingDuringUtterance: this.currentTtsPlaying,
      mediaTrackSettings: this.currentMediaSettings,
    };
    this.appendRecord(record);
    this.summary.vadRejectCount += 1;
    this.summary.candidateCount += 1;
    this.summary.byMode[this.currentMode].vadRejectCount += 1;
    this.summary.byMode[this.currentMode].candidateCount += 1;
    if (record.ttsPlayingDuringUtterance) {
      const targets = [
        this.summary,
        this.summary.byMode[this.currentMode],
      ];
      for (const target of targets) {
        target.ttsCandidateCount += 1;
        target.ttsVadRejectCount += 1;
      }
    }
    this.updateTtsRates(this.summary);
    this.resetPendingVadMetrics();
  }

  private updateSummary(
    record: VoiceLabUtteranceRecord,
    ttsCandidateStartedDuringTts = record.ttsPlayingDuringUtterance,
  ): void {
    const known = record.knownHallucinationPhrase !== null;
    const successful = record.recognizedText.length > 0;
    const noiseLike = !successful && !known;
    const targets = [this.summary, this.summary.byMode[record.mode]];
    for (const target of targets) {
      target.utteranceCount += 1;
      target.candidateCount += 1;
      if (successful) target.sttSuccessCount += 1;
      if (noiseLike) target.noiseLikeSttCount += 1;
      if (known) target.knownHallucinationCount += 1;
      if (record.ttsPlayingDuringUtterance) target.ttsOverlapCount += 1;
      if (ttsCandidateStartedDuringTts) {
        target.ttsCandidateCount += 1;
        target.ttsAcceptedCount += 1;
        if (noiseLike) target.ttsNoiseLikeSttCount += 1;
      }
    }

    if (record.sttLatencyMs !== null) {
      const total = this.latencyTotals.get(record.mode) ?? {
        count: 0,
        totalMs: 0,
      };
      total.count += 1;
      total.totalMs += record.sttLatencyMs;
      this.latencyTotals.set(record.mode, total);
      const modeSummary = this.summary.byMode[record.mode];
      modeSummary.averageSttLatencyMs = total.totalMs / total.count;
      const overall = [...this.latencyTotals.values()].reduce(
        (current, value) => ({
          count: current.count + value.count,
          totalMs: current.totalMs + value.totalMs,
        }),
        { count: 0, totalMs: 0 },
      );
      this.summary.averageSttLatencyMs =
        overall.count > 0 ? overall.totalMs / overall.count : null;
    }
    this.updateTtsRates(this.summary);
    this.updatePhaseLatencySummaries();
  }

  private closeTtsWindow(at: number): void {
    if (
      this.currentTtsStartedAtMs === null ||
      this.currentTtsMode === null
    ) {
      this.currentTtsStartedAtMs = null;
      this.currentTtsMode = null;
      return;
    }

    const durationMs = Math.max(
      0,
      Math.round(at - this.currentTtsStartedAtMs),
    );
    this.summary.ttsActiveDurationMs += durationMs;
    this.summary.byMode[this.currentTtsMode].ttsActiveDurationMs += durationMs;
    this.currentTtsStartedAtMs = null;
    this.currentTtsMode = null;
    this.updateTtsRates(this.summary);
  }

  private applyOpenTtsWindow(
    summary: VoiceLabSessionSummary,
    at: number,
  ): void {
    if (
      this.currentTtsStartedAtMs === null ||
      this.currentTtsMode === null
    ) {
      this.updateTtsRates(summary);
      return;
    }

    const durationMs = Math.max(
      0,
      Math.round(at - this.currentTtsStartedAtMs),
    );
    summary.ttsActiveDurationMs += durationMs;
    summary.byMode[this.currentTtsMode].ttsActiveDurationMs += durationMs;
    this.updateTtsRates(summary);
  }

  private updateTtsRates(summary: VoiceLabSessionSummary): void {
    const targets: VoiceLabModeSummary[] = [
      summary,
      summary.byMode.baseline,
      summary.byMode.processed,
      summary.byMode['processed-vad'],
      summary.byMode['exhibition-mix'],
    ];
    for (const target of targets) {
      target.ttsCandidatesPerMinute = calculatePerMinuteRate(
        target.ttsCandidateCount,
        target.ttsActiveDurationMs,
      );
    }
  }

  private updatePhaseLatencySummaries(): void {
    const utterances = this.records.filter(
      (record): record is VoiceLabUtteranceRecord =>
        record.kind === 'utterance',
    );
    const update = (
      target: VoiceLabSessionSummary['byMode']['baseline'] | VoiceLabSessionSummary,
      records: VoiceLabUtteranceRecord[],
    ) => {
      const average = (
        selector: (record: VoiceLabUtteranceRecord) => number | null | undefined,
      ): number | null => {
        const values = records
          .map(selector)
          .filter((value): value is number => typeof value === 'number');
        return values.length
          ? values.reduce((total, value) => total + value, 0) / values.length
          : null;
      };
      target.averageSttQueueWaitMs = average(
        (record) => record.sttQueueWaitMs,
      );
      target.averageSttProcessingMs = average(
        (record) => record.sttProcessingMs,
      );
      target.averageEndpointToResultLatencyMs = average(
        (record) => record.endpointToResultLatencyMs,
      );
      target.averageSpeechToResultLatencyMs = average(
        (record) => record.speechToResultLatencyMs,
      );
    };

    update(this.summary, utterances);
    for (const mode of [
      'baseline',
      'processed',
      'processed-vad',
      'exhibition-mix',
    ] as const) {
      update(
        this.summary.byMode[mode],
        utterances.filter((record) => record.mode === mode),
      );
    }
  }

  private updateBargeInSummary(
    record: Extract<VoiceLabRecord, { kind: 'barge_in' }>,
  ): void {
    const targets = [this.summary, this.summary.byMode[record.mode]];
    for (const target of targets) {
      if (record.action === 'duck') target.bargeInTriggeredCount += 1;
      if (record.action === 'interrupt') target.bargeInConfirmedCount += 1;
      if (record.action === 'restore') {
        target.bargeInRestoredCount += 1;
        if (record.reason === 'timeout') target.bargeInTimeoutCount += 1;
      }
    }
  }

  private resetPendingVadMetrics(): void {
    this.pendingMaxVadScore = null;
    this.pendingVadThreshold = null;
    this.pendingEffectiveThreshold = null;
    this.pendingNoiseFloor = null;
  }

  private appendRecord(record: VoiceLabRecord): void {
    this.records.push(record);
    this.latestRecord = record;
    this.onRecord?.(record);
  }
}
