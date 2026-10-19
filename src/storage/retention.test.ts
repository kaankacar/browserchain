// Snapshot retention: a checkpoint snapshot is stored every 64 ledgers
// (about 5 minutes) and holds the whole state (about 400 bytes per entry).
// Without pruning, a long-running browser node fills its IndexedDB quota.

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FallbackStorage } from '../node/fallbackStorage';
import { IdbStorage, KEEP_SNAPSHOTS } from './idbStorage';
import { MemoryStorage } from './memoryStorage';

const seqs = (n: number) => Array.from({ length: n }, (_, i) => (i + 1) * 64);

describe('snapshot retention', () => {
  it('IdbStorage keeps only the newest snapshots', async () => {
    const s = new IdbStorage('browserchain-retention-1');
    await s.open();
    for (const seq of seqs(20)) await s.putSnapshot(seq, `snap-${seq}`);
    expect(KEEP_SNAPSHOTS).toBe(8);
    expect(await s.listSnapshotSeqs()).toEqual(seqs(20).slice(-8));
    expect(await s.getLatestSnapshotAtOrBefore(20 * 64)).toEqual({ seq: 20 * 64, data: `snap-${20 * 64}` });
    expect(await s.getSnapshot(64)).toBeUndefined();
    // after a rollback the newest kept snapshot below the cut is still there
    await s.truncateAfter(15 * 64 + 3);
    expect(await s.getLatestSnapshotAtOrBefore(Infinity)).toEqual({ seq: 15 * 64, data: `snap-${15 * 64}` });
    await s.close();
  });

  it('MemoryStorage keeps everything by default (simulation) and prunes when asked', async () => {
    const all = new MemoryStorage();
    await all.open();
    for (const seq of seqs(20)) await all.putSnapshot(seq, 'x');
    expect(await all.listSnapshotSeqs()).toHaveLength(20);
    const few = new MemoryStorage({ keepSnapshots: 3 });
    await few.open();
    for (const seq of seqs(20)) await few.putSnapshot(seq, 'x');
    expect(await few.listSnapshotSeqs()).toEqual(seqs(20).slice(-3));
  });

  it('FallbackStorage in memory mode keeps only the newest snapshots', async () => {
    const broken = new IdbStorage('browserchain-retention-2');
    broken.open = () => Promise.reject(new DOMException('no IndexedDB here', 'UnknownError'));
    const s = new FallbackStorage(broken);
    await s.open();
    expect(s.inMemory).toBe(true);
    for (const seq of seqs(20)) await s.putSnapshot(seq, 'x');
    expect(await s.listSnapshotSeqs()).toEqual(seqs(20).slice(-KEEP_SNAPSHOTS));
  });
});
