// All time-dependent code must use an injected Clock, never Date.now() or the
// global setTimeout directly. The simulation harness uses VirtualClock to run
// many nodes deterministically and much faster than real time.

export type TimerHandle = number;

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(cb: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
  setTimeout(cb: () => void, ms: number): TimerHandle {
    return globalThis.setTimeout(cb, Math.max(0, ms)) as unknown as TimerHandle;
  }
  clearTimeout(handle: TimerHandle): void {
    globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }
}

interface Task {
  id: number;
  at: number;
  seq: number;
  cb: () => void;
}

/** Yield to the host event loop so pending promise continuations run. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else globalThis.setTimeout(resolve, 0);
  });
}

/**
 * Discrete-event clock. Timers run in (time, insertion order). Time only moves
 * when advance()/runUntil() is called. After each timer callback the clock
 * yields to the host event loop, so async code (promises) settles at the same
 * virtual time.
 */
export class VirtualClock implements Clock {
  private current: number;
  private tasks: Task[] = [];
  private nextId = 1;
  private nextSeq = 0;

  constructor(startMs = 1_790_000_000_000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(cb: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.current + Math.max(0, ms), seq: this.nextSeq++, cb });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    const i = this.tasks.findIndex((t) => t.id === handle);
    if (i >= 0) this.tasks.splice(i, 1);
  }

  pending(): number {
    return this.tasks.length;
  }

  private popDue(limit: number): Task | undefined {
    let best = -1;
    for (let i = 0; i < this.tasks.length; i++) {
      const t = this.tasks[i];
      if (t.at > limit) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      const b = this.tasks[best];
      if (t.at < b.at || (t.at === b.at && t.seq < b.seq)) best = i;
    }
    if (best < 0) return undefined;
    return this.tasks.splice(best, 1)[0];
  }

  /** Run all timers due within the next `ms` milliseconds, then set time to now+ms. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await flushMicrotasks();
    for (;;) {
      const t = this.popDue(target);
      if (!t) break;
      this.current = Math.max(this.current, t.at);
      t.cb();
      await flushMicrotasks();
    }
    this.current = target;
  }

  /**
   * Advance in steps of `stepMs` until `pred()` is true or `maxMs` of virtual
   * time has passed. Returns whether the predicate became true.
   */
  async runUntil(pred: () => boolean, maxMs: number, stepMs = 50): Promise<boolean> {
    const end = this.current + maxMs;
    await flushMicrotasks();
    if (pred()) return true;
    while (this.current < end) {
      await this.advance(Math.min(stepMs, end - this.current));
      if (pred()) return true;
    }
    return pred();
  }
}
