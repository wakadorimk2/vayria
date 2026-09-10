import { useEffect, useState } from 'react';
import type { VoiceInputNotice } from '../voice/voiceInput';
import { voiceInputNoticeMessage } from './errors';

export function VoiceInputNotification({ notice, suppressed = false }: { notice?: VoiceInputNotice; suppressed?: boolean }) {
  const [dismissed, setDismissed] = useState<VoiceInputNotice>();
  useEffect(() => {
    if (!notice || notice.state === 'recovering') return;
    const timer = window.setTimeout(() => setDismissed(notice), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const message = notice && dismissed !== notice && !suppressed ? voiceInputNoticeMessage(notice) : '';
  return <div className="public-voice-notice" role="status" aria-live="polite" aria-atomic="true" data-visible={Boolean(message)}>
    {message}
  </div>;
}
