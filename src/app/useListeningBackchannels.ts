import {
  useCallback,
  useEffect,
  useRef
} from 'react';
import { fetchListeningBackchannels } from '../voice/backchannel';
import type { ListeningBackchannelAudio } from '../voice/backchannelPolicy';
import {
  type VoiceBackchannelCue
} from '../voice/voiceInteraction';

export function useListeningBackchannels(enabled = true) {
  const backchannelAudioRef = useRef<ListeningBackchannelAudio[]>([]);
  const backchannelVariantIndexRef = useRef<
    Record<Exclude<VoiceBackchannelCue, 'none'>, number | null>
  >({ un: null, uun: null });
  const backchannelLoadingRef = useRef<Promise<void> | null>(null);
  const preloadBackchannel = useCallback(() => {
    if (!enabled) return;
    if (backchannelAudioRef.current.length > 0 || backchannelLoadingRef.current) {
      return;
    }

    const loading = fetchListeningBackchannels()
      .then((audioData) => {
        backchannelAudioRef.current = audioData;
      })
      .catch(() => {
        // Voice input and visual reactions remain usable without the cue audio.
      })
      .finally(() => {
        backchannelLoadingRef.current = null;
      });
    backchannelLoadingRef.current = loading;
  }, [enabled]);

  useEffect(() => {
    preloadBackchannel();
  }, [preloadBackchannel]);


  return { backchannelAudioRef, backchannelVariantIndexRef, backchannelLoadingRef, preloadBackchannel };
}
