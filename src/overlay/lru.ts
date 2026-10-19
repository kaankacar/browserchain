// Bounded least-recently-used map. A Map keeps insertion order, so the first
// key is always the oldest one.

export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) throw new Error('LruMap capacity must be >= 1');
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Read without changing recency. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  /** Read and mark as most recently used. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Oldest first. */
  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}

/** Bounded LRU set (used to dedupe flooded messages). */
export class LruSet<K> {
  private readonly inner: LruMap<K, true>;

  constructor(capacity: number) {
    this.inner = new LruMap(capacity);
  }

  get size(): number {
    return this.inner.size;
  }

  /** True if present. Marks the key as recently used. */
  touch(key: K): boolean {
    return this.inner.get(key) !== undefined;
  }

  has(key: K): boolean {
    return this.inner.has(key);
  }

  add(key: K): void {
    this.inner.set(key, true);
  }

  clear(): void {
    this.inner.clear();
  }
}
