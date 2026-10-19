// A Clock that remembers its timers, so a node can cancel all of them at
// once when it stops or crashes (the simulation shares one VirtualClock
// between many nodes).

import type { Clock, TimerHandle } from '../lib/clock';

export class ScopedClock implements Clock {
  private readonly handles = new Set<TimerHandle>();
  private disposed = false;

  constructor(private readonly inner: Clock) {}

  now(): number {
    return this.inner.now();
  }

  setTimeout(cb: () => void, ms: number): TimerHandle {
    if (this.disposed) return -1;
    const handle = this.inner.setTimeout(() => {
      this.handles.delete(handle);
      if (!this.disposed) cb();
    }, ms);
    this.handles.add(handle);
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    if (!this.handles.delete(handle)) return;
    this.inner.clearTimeout(handle);
  }

  /** Cancel every pending timer; later setTimeout calls do nothing. */
  dispose(): void {
    this.disposed = true;
    for (const h of this.handles) this.inner.clearTimeout(h);
    this.handles.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  pending(): number {
    return this.handles.size;
  }
}
