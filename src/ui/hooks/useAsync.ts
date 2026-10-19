import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DependencyList } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | null;
  /** True only before the first result; reloads keep the previous data. */
  loading: boolean;
  /** True while any request is in flight. */
  refreshing: boolean;
  reload: () => void;
}

/**
 * Run an async loader when deps change. Keeps the previous data during
 * reloads (no flashing) and ignores stale responses.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [inFlight, setInFlight] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [bump, setBump] = useState(0);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    const id = ++seq.current;
    setInFlight(true);
    fnRef
      .current()
      .then((v) => {
        if (seq.current !== id) return;
        setData(v);
        setError(null);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (seq.current !== id) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoaded(true);
      })
      .finally(() => {
        if (seq.current === id) setInFlight(false);
      });
  }, [...deps, bump]);

  const reload = useCallback(() => setBump((b) => b + 1), []);
  return { data, error, loading: !loaded, refreshing: inFlight, reload };
}
