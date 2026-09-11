import { useEffect, useState, useSyncExternalStore } from 'react';
import { LiveConversation } from './liveConversation';
import { readLiveResponse } from './liveErrors';
import { getIosAudioSession } from '../audio/iosAudioSession';
import { publicUrl } from '../public/paths';
import { publicActive, subscribePublic } from '../public/session';

export function useLiveConversation(volume: number) {
  const [conversation] = useState(() => new LiveConversation({
    holdRecording: () => getIosAudioSession()?.holdRecording() ?? (() => {}),
    getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
    peer: () => new RTCPeerConnection(), audio: () => new AudioContext(),
    frame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
    async request(operation, input, sessionId) {
      const response = await fetch(publicUrl(`/api/live/${operation}`), { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Vayria-Session': sessionId }, body: JSON.stringify(input),
        signal: AbortSignal.timeout(operation === 'start' ? 35_000 : 12_000), keepalive: operation === 'stop' });
      return readLiveResponse(response);
    },
  }));
  const snapshot = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot, conversation.getSnapshot);
  useEffect(() => { conversation.setVolume(volume); }, [conversation, volume]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) void conversation.stop(); };
    const stop = () => { void conversation.stop(); };
    const unsubscribe = subscribePublic(() => { if (!publicActive()) stop(); });
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', stop);
    return () => { unsubscribe(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', stop); stop(); };
  }, [conversation]);
  return { ...snapshot, controller: conversation };
}
