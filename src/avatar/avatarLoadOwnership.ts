/** Owns one asynchronous avatar load, including results arriving after disposal. */
export class AvatarLoadOwnership<T extends object> {
  private disposed = false;
  private current: T | null = null;
  private readonly released = new WeakSet<T>();

  constructor(private readonly release: (value: T) => void) { }

  get active(): boolean { return !this.disposed; }

  accept(value: T): boolean {
    if (this.disposed) {
      this.discard(value);
      return false;
    }
    this.current = value;
    return true;
  }

  discard(value: T): void {
    if (this.released.has(value)) return;
    this.released.add(value);
    this.release(value);
    if (this.current === value) this.current = null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.current) this.discard(this.current);
  }
}
