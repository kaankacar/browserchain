// React access to the live node state: one NodeStore per NodeApi.

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { RealClock, type Clock, type TimerHandle } from '../../lib/clock';
import type { NodeApi } from '../../node/api';
import { NodeStore, type NodeState } from './store';

const StoreContext = createContext<NodeStore | null>(null);
const ClockContext = createContext<Clock>(new RealClock());
const TickerContext = createContext<Ticker | null>(null);

/** One shared 1-second ticker, so "3s ago" labels do not each own a timer. */
class Ticker {
  private now: number;
  private listeners = new Set<() => void>();
  private timer: TimerHandle | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly intervalMs = 1000,
  ) {
    this.now = clock.now();
  }

  get = (): number => this.now;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.schedule();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.timer !== null) {
        this.clock.clearTimeout(this.timer);
        this.timer = null;
      }
    };
  };

  private schedule(): void {
    this.now = this.clock.now();
    const wait = this.intervalMs - (this.now % this.intervalMs);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.now = this.clock.now();
      for (const fn of [...this.listeners]) fn();
      if (this.listeners.size > 0) this.schedule();
    }, wait);
  }
}

export function NodeProvider({ api, clock, children }: { api: NodeApi; clock: Clock; children: ReactNode }) {
  const store = useMemo(() => new NodeStore(api, clock), [api, clock]);
  const ticker = useMemo(() => new Ticker(clock), [clock]);
  useEffect(() => store.start(), [store]);
  return (
    <ClockContext.Provider value={clock}>
      <TickerContext.Provider value={ticker}>
        <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
      </TickerContext.Provider>
    </ClockContext.Provider>
  );
}

export function useStore(): NodeStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore outside NodeProvider');
  return s;
}

export function useApi(): NodeApi {
  return useStore().api;
}

export function useClock(): Clock {
  return useContext(ClockContext);
}

/** Subscribe to a slice of the node state. The selector must return a stable reference. */
export function useNodeState<T>(selector: (s: NodeState) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

/** Current time from the injected clock, refreshed every second. */
export function useNow(): number {
  const ticker = useContext(TickerContext);
  const clock = useClock();
  const fallback = useMemo(() => ({ subscribe: () => () => {}, get: () => clock.now() }), [clock]);
  const t = ticker ?? fallback;
  return useSyncExternalStore(t.subscribe, t.get, t.get);
}
