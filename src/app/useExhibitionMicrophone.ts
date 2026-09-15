import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { publicActive, runPublicAction } from '../public/session';
import { runtimeConfig } from '../runtimeConfig';
import {
  VAD_THRESHOLD_MAX,
  VAD_THRESHOLD_MIN,
  type AudioLabMode,
} from '../voice/audioLab.js';
export const EXHIBITION_MICROPHONE_PANEL_ID = 'exhibition-microphone-adjuster';
const MICROPHONE_INPUT_ACTIVITY_FLOOR = 0.001;
const MICROPHONE_METER_MAX = VAD_THRESHOLD_MAX;

export type MicrophoneInputTransition = 'starting' | 'stopping';
export type MicrophoneInputVisualState =
  | MicrophoneInputTransition
  | 'error'
  | 'on'
  | 'off';

export interface ExhibitionMicrophoneView {
  disclosureLabel: string;
  displayedAudioLevel: number | null;
  displayThreshold: number | null;
  expanded: boolean;
  feedbackStyle: CSSProperties;
  gateAvailable: boolean;
  inputActive: boolean;
  levelPercent: number;
  meterMax: number;
  meterValue: number;
  pending: boolean;
  statusLabel: string;
  thresholdCrossed: boolean;
  thresholdPercent: number | null;
  thresholdSettingValue: number;
  toggleLabel: string;
  visuallyEnabled: boolean;
  visualState: MicrophoneInputVisualState;
}

interface UseExhibitionMicrophoneOptions {
  audioControl: {
    isMuted: boolean;
    lastAudibleVolume: number;
    volume: number;
  };
  audioLabMode: AudioLabMode;
  audioLevel: number | null;
  effectiveThreshold: number | null;
  isSttProcessing: boolean;
  isVadSpeech: boolean;
  isVoiceInputEnabled: boolean;
  preloadBackchannel: () => void;
  prepare: () => Promise<boolean>;
  startVoiceInput: () => Promise<boolean>;
  stopVoiceInput: () => Promise<void>;
  unmute: (restoredVolume: number) => void;
  vadThreshold: number;
  voiceError: string;
}

function microphoneActionLabel(
  transition: MicrophoneInputTransition | null,
  voiceError: string,
  fallback: string,
): string {
  if (transition === 'starting') return '音声入力を開始中';
  if (transition === 'stopping') return '音声入力を停止中';
  if (voiceError) return '音声入力を再試行';
  return fallback;
}

export function useExhibitionMicrophone({
  audioControl,
  audioLabMode,
  audioLevel,
  effectiveThreshold,
  isSttProcessing,
  isVadSpeech,
  isVoiceInputEnabled,
  preloadBackchannel,
  prepare,
  startVoiceInput,
  stopVoiceInput,
  unmute,
  vadThreshold,
  voiceError,
}: UseExhibitionMicrophoneOptions) {
  const { isMuted, lastAudibleVolume, volume } = audioControl;
  const [isMicrophoneControlExpanded, setIsMicrophoneControlExpanded] =
    useState(false);
  const [microphoneInputTransition, setMicrophoneInputTransition] =
    useState<MicrophoneInputTransition | null>(null);
  const microphoneInputTransitionRef =
    useRef<MicrophoneInputTransition | null>(null);
  const microphoneControlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMicrophoneControlExpanded) return;

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (microphoneControlRef.current?.contains(event.target)) return;
      setIsMicrophoneControlExpanded(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsMicrophoneControlExpanded(false);
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isMicrophoneControlExpanded]);

  const handleVoiceToggle = useCallback(async () => {
    if (microphoneInputTransitionRef.current !== null) return;

    const transition = isVoiceInputEnabled ? 'stopping' : 'starting';
    microphoneInputTransitionRef.current = transition;
    setMicrophoneInputTransition(transition);
    try {
      if (isVoiceInputEnabled) {
        await stopVoiceInput();
        return;
      }

      if (runtimeConfig.mode === 'public') {
        void prepare();
        await runPublicAction(async () => {
          if (!(await startVoiceInput())) return false;
          if (!publicActive() || document.hidden) { await stopVoiceInput(); return false; }
          void prepare(); preloadBackchannel();
          return true;
        });
        return;
      }
      if (!(await startVoiceInput())) return;
      void prepare();
      preloadBackchannel();
    } finally {
      microphoneInputTransitionRef.current = null;
      setMicrophoneInputTransition(null);
    }
  }, [
    isVoiceInputEnabled,
    preloadBackchannel,
    prepare,
    startVoiceInput,
    stopVoiceInput,
  ]);

  const handleExhibitionAudioUnlock = useCallback(async () => {
    if (isMuted) {
      unmute(volume > 0 ? volume : lastAudibleVolume);
    }

    const audioReadyPromise = prepare();
    const voiceStartedPromise = startVoiceInput();
    const [, voiceStarted] = await Promise.all([
      audioReadyPromise,
      voiceStartedPromise,
    ]);
    if (voiceStarted) preloadBackchannel();
    return voiceStarted;
  }, [
    isMuted,
    lastAudibleVolume,
    preloadBackchannel,
    prepare,
    startVoiceInput,
    unmute,
    volume,
  ]);

  const handleMicrophoneControlToggle = useCallback(() => {
    if (microphoneInputTransitionRef.current !== null) return;

    if (isVoiceInputEnabled && !voiceError) {
      setIsMicrophoneControlExpanded(true);
      return;
    }

    microphoneInputTransitionRef.current = 'starting';
    setMicrophoneInputTransition('starting');
    void handleExhibitionAudioUnlock().finally(() => {
      microphoneInputTransitionRef.current = null;
      setMicrophoneInputTransition(null);
    });
  }, [
    handleExhibitionAudioUnlock,
    isVoiceInputEnabled,
    voiceError,
  ]);

  const displayedAudioLevel = isVoiceInputEnabled ? audioLevel : null;
  const browserGateAvailable =
    audioLabMode === 'processed-vad' ||
    ((audioLabMode === 'processed' || audioLabMode === 'exhibition-mix') &&
      runtimeConfig.audioPreset !== 'off');
  const displayThreshold = browserGateAvailable
    ? (effectiveThreshold ?? vadThreshold)
    : null;
  const isMicrophoneInputTransitionPending =
    microphoneInputTransition !== null;
  const isMicrophoneInputVisuallyEnabled =
    microphoneInputTransition === 'starting' ||
    (microphoneInputTransition === null && isVoiceInputEnabled);
  const microphoneInputVisualState: MicrophoneInputVisualState =
    microphoneInputTransition ??
    (voiceError ? 'error' : isVoiceInputEnabled ? 'on' : 'off');
  const microphoneLevel = Math.max(0, displayedAudioLevel ?? 0);
  const microphoneMeterValue = Math.min(
    MICROPHONE_METER_MAX,
    microphoneLevel,
  );
  const microphoneLevelPercent = Math.min(
    100,
    (microphoneLevel / MICROPHONE_METER_MAX) * 100,
  );
  const microphoneThresholdSettingValue = Math.min(
    VAD_THRESHOLD_MAX,
    Math.max(VAD_THRESHOLD_MIN, vadThreshold),
  );
  const effectiveThresholdPercent =
    displayThreshold === null
      ? null
      : Math.min(
        100,
        Math.max(0, (displayThreshold / MICROPHONE_METER_MAX) * 100),
      );
  const microphoneInputStrength = Math.min(
    1,
    microphoneLevel / MICROPHONE_METER_MAX,
  );
  const microphoneFeedbackStyle = {
    '--microphone-glow-size': `${1 + microphoneInputStrength * 5}px`,
    '--microphone-pulse-scale': `${1 + microphoneInputStrength * 0.04}`,
    '--microphone-ring-opacity': `${microphoneInputStrength * 0.22}`,
    '--microphone-ring-scale': `${1 + microphoneInputStrength * 0.06}`,
  } as CSSProperties;
  const isMicrophoneInputActive =
    isVoiceInputEnabled && microphoneLevel > MICROPHONE_INPUT_ACTIVITY_FLOOR;
  const isThresholdCurrentlyCrossed =
    isVoiceInputEnabled &&
    displayThreshold !== null &&
    microphoneLevel >= displayThreshold;
  const microphoneStatusLabel =
    microphoneInputTransition === 'starting'
      ? '開始中'
      : microphoneInputTransition === 'stopping'
        ? '停止中'
        : voiceError
          ? 'マイクを確認'
          : isSttProcessing
            ? '判定中'
            : isVadSpeech
              ? '聞き取り中'
              : !isVoiceInputEnabled
                ? '待機中'
                : displayedAudioLevel === null
                  ? '入力待ち'
                  : displayThreshold !== null &&
                    displayedAudioLevel < displayThreshold
                    ? '反応ライン未満'
                    : '入力あり';
  const microphoneToggleLabel = microphoneActionLabel(
    microphoneInputTransition,
    voiceError,
    isVoiceInputEnabled ? '音声入力を停止' : '音声入力を有効化',
  );
  const microphoneDisclosureLabel = microphoneActionLabel(
    microphoneInputTransition,
    voiceError,
    isVoiceInputEnabled ? 'マイク調整を表示' : '音声入力を有効化',
  );

  const view: ExhibitionMicrophoneView = {
    disclosureLabel: microphoneDisclosureLabel,
    displayedAudioLevel,
    displayThreshold,
    expanded: isMicrophoneControlExpanded,
    feedbackStyle: microphoneFeedbackStyle,
    gateAvailable: browserGateAvailable,
    inputActive: isMicrophoneInputActive,
    levelPercent: microphoneLevelPercent,
    meterMax: MICROPHONE_METER_MAX,
    meterValue: microphoneMeterValue,
    pending: isMicrophoneInputTransitionPending,
    statusLabel: microphoneStatusLabel,
    thresholdCrossed: isThresholdCurrentlyCrossed,
    thresholdPercent: effectiveThresholdPercent,
    thresholdSettingValue: microphoneThresholdSettingValue,
    toggleLabel: microphoneToggleLabel,
    visuallyEnabled: isMicrophoneInputVisuallyEnabled,
    visualState: microphoneInputVisualState,
  };

  return {
    controlRef: microphoneControlRef,
    displayedAudioLevel,
    handleMicrophoneControlToggle,
    handleVoiceToggle,
    inputStrength: microphoneInputStrength,
    transition: microphoneInputTransition,
    view,
  };
}
