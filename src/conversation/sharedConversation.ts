export const SHARED_CONVERSATION_QUIET_MS = 900;

/** A bounded, single-use batch of room speech. New speech invalidates its timer. */
export class SharedConversationQueue {
  private texts: string[] = [];
  private speaking = false;
  private quietSince = 0;
  private pendingTranscripts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private send: (text: string) => void,
    private overflow: () => void,
    private readonly now: () => number = Date.now) {}
  setCallbacks(send: (text: string) => void, overflow: () => void) { this.send = send; this.overflow = overflow; }
  reportOverflow() { this.overflow(); }
  speechStarted() { this.speaking = true; this.cancelTimer(); }
  speechEnded(at = this.now()) { this.speaking = false; this.quietSince = at; this.pendingTranscripts++; this.schedule(); }
  discard() { this.pendingTranscripts = Math.max(0, this.pendingTranscripts - 1); this.schedule(); }
  append(text: string) {
    this.pendingTranscripts = Math.max(0, this.pendingTranscripts - 1);
    if (this.texts.join('\n').length + text.length > 1000 || this.texts.length >= 4) {
      this.reset(); this.overflow(); return;
    }
    this.texts.push(text); this.schedule();
  }
  reset() { this.cancelTimer(); this.texts = []; this.speaking = false; this.quietSince = 0; this.pendingTranscripts = 0; }
  private cancelTimer() { clearTimeout(this.timer); this.timer = undefined; }
  private schedule() {
    this.cancelTimer();
    if (this.speaking || this.pendingTranscripts > 0 || !this.texts.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const text = this.texts.join('\n'); this.texts = [];
      this.send(text);
    }, Math.max(0, this.quietSince + SHARED_CONVERSATION_QUIET_MS - this.now()));
  }
}

/** Conservative acoustic-echo hint; never establishes a speaker identity. */
export function resemblesPlayback(text: string, playback: string): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
  const heard = normalize(text); const spoken = normalize(playback);
  return heard.length >= 4 && spoken.length >= 4 && spoken.includes(heard);
}
