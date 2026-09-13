// Per-tab ownership survives React remounts. Different rooms and generations
// never share a reply identity; identical words in another reply remain valid.
export class ReplyPlayback {
  private seen = new Set<string>();
  private active: { key: string; cancel: () => void } | null = null;
  claim(key: string, cancel: () => void) {
    if (this.seen.has(key)) return false;
    this.stop();
    this.seen.add(key);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    this.active = { key, cancel };
    return true;
  }
  release(key: string) {
    if (this.active?.key !== key) return;
    this.stop();
  }
  stop() {
    const active = this.active;
    this.active = null;
    active?.cancel();
  }
}
export const sharedReplyPlayback = new ReplyPlayback();
