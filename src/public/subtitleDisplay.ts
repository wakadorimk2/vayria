import type { LiveCaption } from '../live/liveConversation';

// Display-only state. Silence here must never complete audio playback.
export class SubtitleDisplay {
  text = '';
  private seen = new Set<string>();
  private lastActivity = -Infinity;
  private end = -Infinity;
  private expired = true;

  reset(captions: readonly LiveCaption[] = []) {
    this.text = '';
    this.seen = new Set(captions.map(c => c.id));
    this.lastActivity = -Infinity;
    this.end = -Infinity;
    this.expired = true;
  }

  update(captions: readonly LiveCaption[], speaking: boolean, now: number, fits: (text: string) => boolean) {
    for (const caption of captions) {
      if (this.seen.has(caption.id)) continue;
      this.seen.add(caption.id);
      if (caption.speaker !== 'assistant' || caption.end_ms < this.end) continue;
      if (this.expired || caption.start_ms - this.end >= 2000) this.text = '';
      this.expired = false;
      for (const character of Array.from(caption.delta)) {
        if (!fits(this.text + character)) {
          const boundary = Math.max(this.text.lastIndexOf('。'), this.text.lastIndexOf('！'), this.text.lastIndexOf('？'), this.text.lastIndexOf('、'), this.text.lastIndexOf('. '));
          const tail = boundary >= 0 ? this.text.slice(boundary + 1).trimStart() : '';
          this.text = fits(tail + character) ? tail : '';
        }
        this.text += character;
      }
      this.end = caption.end_ms;
      this.lastActivity = now;
    }
    // Bound deduplication memory to the source window, including input captions.
    this.seen = new Set(captions.filter(c => this.seen.has(c.id)).map(c => c.id));
    if (speaking) this.lastActivity = now;
    if (now - this.lastActivity >= 2000) { this.text = ''; this.expired = true; }
    while (this.text && !fits(this.text)) this.text = Array.from(this.text).slice(1).join('');
    return this.text;
  }
}

export function fitsSubtitle(text: string, width: number, measure: (text: string) => number) {
  let lines = 1, line = '';
  for (const character of Array.from(text)) {
    if (character === '\n' || measure(line + character) > width) {
      lines++;
      line = character === '\n' ? '' : character;
    } else line += character;
    if (lines > 2) return false;
  }
  return true;
}
