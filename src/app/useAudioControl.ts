import { useCallback, useEffect, useState } from 'react';
import { environmentStorageKey } from '../storageKey';

const AUDIO_SETTINGS_STORAGE_KEY = 'vayria.audio-settings.v1';
const LEGACY_AUDIO_SETTINGS_STORAGE_KEY = 'wildcard.audio-settings.v1';

export interface AudioControlState {
  isMuted: boolean;
  lastAudibleVolume: number;
  volume: number;
}

function createDefaultAudioControlState(): AudioControlState {
  return { isMuted: false, lastAudibleVolume: 1, volume: 1 };
}

function readStoredVolume(value: unknown, allowZero: boolean): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < (allowZero ? 0 : Number.EPSILON) || value > 1) return null;
  return value;
}

function parseAudioControlState(rawValue: string | null): AudioControlState | null {
  if (rawValue === null) return null;

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const volume = readStoredVolume(record.volume, true);
    const lastAudibleVolume = readStoredVolume(
      record.lastAudibleVolume,
      false,
    );
    if (volume === null || lastAudibleVolume === null) {
      return null;
    }
    return {
      isMuted: volume === 0,
      lastAudibleVolume,
      volume,
    };
  } catch {
    return null;
  }
}

function readAudioControlState(): AudioControlState {
  try {
    for (const storageKey of [
      AUDIO_SETTINGS_STORAGE_KEY,
      LEGACY_AUDIO_SETTINGS_STORAGE_KEY,
    ]) {
      const state = parseAudioControlState(localStorage.getItem(environmentStorageKey(storageKey)));
      if (state !== null) return state;
    }
  } catch {
    // Playback remains usable when storage is unavailable.
  }

  return createDefaultAudioControlState();
}

export function useAudioControl() {
  const [audioControl, setAudioControl] = useState(readAudioControlState);
  const { isMuted, lastAudibleVolume, volume } = audioControl;

  useEffect(() => {
    const serialized = JSON.stringify({ volume, lastAudibleVolume });
    for (const storageKey of [
      AUDIO_SETTINGS_STORAGE_KEY,
      LEGACY_AUDIO_SETTINGS_STORAGE_KEY,
    ]) {
      try {
        localStorage.setItem(environmentStorageKey(storageKey), serialized);
      } catch {
        // Playback remains usable when storage is unavailable.
      }
    }
  }, [lastAudibleVolume, volume]);

  const mute = useCallback(() => {
    setAudioControl((current) => ({ ...current, isMuted: true }));
  }, []);

  const unmute = useCallback((restoredVolume: number) => {
    setAudioControl({
      isMuted: false,
      lastAudibleVolume: restoredVolume,
      volume: restoredVolume,
    });
  }, []);

  const setVolume = useCallback((nextVolume: number) => {
    if (nextVolume === 0) {
      setAudioControl((current) => ({
        ...current,
        isMuted: true,
        volume: 0,
      }));
      return;
    }
    setAudioControl({
      isMuted: false,
      lastAudibleVolume: nextVolume,
      volume: nextVolume,
    });
  }, []);

  return {
    isMuted,
    lastAudibleVolume,
    volume,
    mute,
    unmute,
    setVolume,
  };
}
