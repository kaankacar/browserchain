import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdbStorage } from './idbStorage';
import { MemoryStorage } from './memoryStorage';
import type { Storage, StoredLedger, StoredTx } from './types';

let dbCounter = 0;

interface Harness {
  storage: Storage;
  /** A handle on the same persisted data (new instance for IndexedDB). */
  reopen: () => Storage;
}

const factories: [string, () => Harness][] = [
  [
    'MemoryStorage',
    () => {
      const s = new MemoryStorage();
      return { storage: s, reopen: () => s };
    },
  ],
  [
    'IdbStorage',
    () => {
      const name = `browserchain-test-${++dbCounter}`;
      return { storage: new IdbStorage(name), reopen: () => new IdbStorage(name) };
    },
  ],
];

const A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function hashOf(n: number, prefix = 'aa'): string {
  return prefix + n.toString(16).padStart(62, '0');
}

function ledger(seq: number, extra: Partial<StoredLedger> = {}): StoredLedger {
  return {
    seq,
    hash: hashOf(seq),
    headerXdr: `header-${seq}`,
    txSetXdr: `txset-${seq}`,
    resultSetXdr: `results-${seq}`,
    closeTime: 1_790_000_000 + seq * 5,
    txCount: 0,
    opCount: 0,
    failedTxCount: 0,
    closedAt: 1_790_000_000_000 + seq * 5000,
    externalizedBy: 3,
    ...extra,
  };
}

function tx(hash: string, ledgerSeq: number, applyIndex: number, accounts: string[], extra: Partial<StoredTx> = {}): StoredTx {
  return {
    hash,
    ledgerSeq,
    applyIndex,
    envelopeXdr: `env-${hash}`,
    resultXdr: `res-${hash}`,
    sourceAccount: accounts[0] ?? A,
    feeCharged: '100',
    maxFee: '200',
    successful: true,
    resultCode: 'txSUCCESS',
    closeTime: 1_790_000_000 + ledgerSeq * 5,
    accounts,
    summaryJson: '{"operations":[]}',
    ...extra,
  };
}

/** Ledgers 1..n; ledger s has `perLedger` txs; tx i touches A, and B or C alternately. */
async function fill(s: Storage, n: number, perLedger = 2): Promise<StoredTx[]> {
  const all: StoredTx[] = [];
  for (let seq = 1; seq <= n; seq++) {
    const txs: StoredTx[] = [];
    for (let i = 0; i < perLedger; i++) {
      txs.push(tx(hashOf(seq * 100 + i, 'bb'), seq, i, [A, i % 2 === 0 ? B : C]));
    }
    await s.putLedger(ledger(seq, { txCount: txs.length }), txs);
    all.push(...txs);
  }
  return all;
}

function hashes(txs: StoredTx[]): string[] {
  return txs.map((t) => t.hash);
}

describe.each(factories)('%s', (_name, make) => {
  let h: Harness;
  let s: Storage;

  beforeEach(async () => {
    h = make();
    s = h.storage;
    await s.open();
  });

  afterEach(async () => {
    await s.close();
  });

  it('rejects calls before open and after close', async () => {
    const other = make().storage;
    await expect(other.getMaxLedgerSeq()).rejects.toThrow(/not open/);
    await other.open();
    expect(await other.getMaxLedgerSeq()).toBe(0);
    await other.close();
    await expect(other.getLedger(1)).rejects.toThrow(/not open/);
  });

  describe('meta', () => {
    it('stores, overwrites and copies values', async () => {
      expect(await s.getMeta('missing')).toBeUndefined();
      const value = { name: 'node-1', nested: { list: [1, 2, 3], flag: true, none: null } };
      await s.setMeta('identity', value);
      value.nested.list.push(4);
      const got = await s.getMeta<typeof value>('identity');
      expect(got).toEqual({ name: 'node-1', nested: { list: [1, 2, 3], flag: true, none: null } });
      got!.nested.list.push(9);
      expect((await s.getMeta<typeof value>('identity'))!.nested.list).toEqual([1, 2, 3]);
      await s.setMeta('identity', 'secret');
      expect(await s.getMeta<string>('identity')).toBe('secret');
      await s.setMeta('n', 42);
      expect(await s.getMeta<number>('n')).toBe(42);
    });
  });

  describe('ledgers', () => {
    it('round-trips a ledger and tracks the max seq', async () => {
      expect(await s.getMaxLedgerSeq()).toBe(0);
      expect(await s.getLedger(1)).toBeUndefined();
      await s.putLedger(ledger(1), []);
      await s.putLedger(ledger(3), []);
      await s.putLedger(ledger(2), []);
      expect(await s.getLedger(2)).toEqual(ledger(2));
      expect(await s.getMaxLedgerSeq()).toBe(3);
    });

    it('returns copies, not live objects', async () => {
      await s.putLedger(ledger(1), []);
      const l = (await s.getLedger(1))!;
      l.hash = 'changed';
      expect((await s.getLedger(1))!.hash).toBe(hashOf(1));
    });

    it('getLedgers is inclusive, ascending and skips gaps', async () => {
      for (const seq of [1, 2, 3, 5, 6, 9]) await s.putLedger(ledger(seq), []);
      expect((await s.getLedgers(2, 6)).map((l) => l.seq)).toEqual([2, 3, 5, 6]);
      expect((await s.getLedgers(4, 4)).map((l) => l.seq)).toEqual([]);
      expect((await s.getLedgers(9, 100)).map((l) => l.seq)).toEqual([9]);
      expect(await s.getLedgers(6, 2)).toEqual([]);
    });

    it('getLatestLedgers is newest first with beforeSeq paging', async () => {
      for (let seq = 1; seq <= 10; seq++) await s.putLedger(ledger(seq), []);
      expect((await s.getLatestLedgers(3)).map((l) => l.seq)).toEqual([10, 9, 8]);
      expect((await s.getLatestLedgers(3, 8)).map((l) => l.seq)).toEqual([7, 6, 5]);
      expect((await s.getLatestLedgers(100, 3)).map((l) => l.seq)).toEqual([2, 1]);
      expect(await s.getLatestLedgers(0)).toEqual([]);
      expect(await s.getLatestLedgers(5, 1)).toEqual([]);
    });

    it('putLedger replaces the ledger and drops its old txs', async () => {
      await s.putLedger(ledger(4), [tx('old1', 4, 0, [A, B]), tx('old2', 4, 1, [A])]);
      await s.putLedger(ledger(4, { hash: hashOf(44), txCount: 1 }), [tx('new1', 4, 0, [C])]);
      expect((await s.getLedger(4))!.hash).toBe(hashOf(44));
      expect(await s.getTx('old1')).toBeUndefined();
      expect(await s.getTx('old2')).toBeUndefined();
      expect(hashes(await s.getTxsByLedger(4))).toEqual(['new1']);
      expect(await s.getTxsByAccount(A, 10)).toEqual([]);
      expect(hashes(await s.getTxsByAccount(C, 10))).toEqual(['new1']);
    });

    it('rejects txs that do not belong to the ledger and writes nothing', async () => {
      await expect(s.putLedger(ledger(2), [tx('t1', 2, 0, [A]), tx('t2', 3, 0, [A])])).rejects.toThrow(/ledgerSeq/);
      expect(await s.getLedger(2)).toBeUndefined();
      expect(await s.getTx('t1')).toBeUndefined();
    });

    it('putLedger is atomic when a value cannot be stored', async () => {
      await s.putLedger(ledger(5), [tx('keep1', 5, 0, [A]), tx('keep2', 5, 1, [B])]);
      const bad = tx('bad', 5, 1, [A], { summaryJson: (() => 'x') as unknown as string });
      await expect(s.putLedger(ledger(5, { hash: hashOf(55) }), [tx('fresh', 5, 0, [A]), bad])).rejects.toThrow();
      expect((await s.getLedger(5))!.hash).toBe(hashOf(5));
      expect(hashes(await s.getTxsByLedger(5))).toEqual(['keep1', 'keep2']);
      expect(await s.getTx('fresh')).toBeUndefined();
      expect(hashes(await s.getTxsByAccount(A, 10))).toEqual(['keep1']);
    });
  });

  describe('txs', () => {
    it('getTx and getTxsByLedger in apply order', async () => {
      const txs = [tx('t2', 7, 2, [A]), tx('t0', 7, 0, [B]), tx('t1', 7, 1, [C])];
      await s.putLedger(ledger(7, { txCount: 3 }), txs);
      expect(await s.getTx('t1')).toEqual(txs[2]);
      expect(await s.getTx('nope')).toBeUndefined();
      expect(hashes(await s.getTxsByLedger(7))).toEqual(['t0', 't1', 't2']);
      expect(await s.getTxsByLedger(8)).toEqual([]);
    });

    it('getTxsByAccount is newest first, paged by ledger, limited', async () => {
      const all = await fill(s, 6, 2);
      const forA = [...all].reverse();
      expect(hashes(await s.getTxsByAccount(A, 100))).toEqual(hashes(forA));
      expect(hashes(await s.getTxsByAccount(A, 3))).toEqual(hashes(forA.slice(0, 3)));
      // B is touched by applyIndex 0 of every ledger.
      const forB = forA.filter((t) => t.applyIndex === 0);
      expect(hashes(await s.getTxsByAccount(B, 100))).toEqual(hashes(forB));
      expect(hashes(await s.getTxsByAccount(B, 2, 4))).toEqual(hashes(forB.filter((t) => t.ledgerSeq < 4).slice(0, 2)));
      expect(await s.getTxsByAccount(B, 10, 1)).toEqual([]);
      expect(await s.getTxsByAccount('GUNKNOWN', 10)).toEqual([]);
      expect(await s.getTxsByAccount(A, 0)).toEqual([]);
    });

    it('does not confuse accounts that share a prefix', async () => {
      await s.putLedger(ledger(1), [tx('p1', 1, 0, [A]), tx('p2', 1, 1, [A + 'X'])]);
      expect(hashes(await s.getTxsByAccount(A, 10))).toEqual(['p1']);
      expect(hashes(await s.getTxsByAccount(A + 'X', 10))).toEqual(['p2']);
    });

    it('lists a tx once per account even if the account repeats', async () => {
      await s.putLedger(ledger(1), [tx('dup', 1, 0, [A, A, B, A])]);
      expect(hashes(await s.getTxsByAccount(A, 10))).toEqual(['dup']);
      expect(hashes(await s.getTxsByAccount(B, 10))).toEqual(['dup']);
      expect((await s.getTx('dup'))!.accounts).toEqual([A, A, B, A]);
    });

    it('getLatestTxs is newest first with beforeLedgerSeq paging', async () => {
      const all = await fill(s, 5, 3);
      const newest = [...all].reverse();
      expect(hashes(await s.getLatestTxs(4))).toEqual(hashes(newest.slice(0, 4)));
      expect(hashes(await s.getLatestTxs(100, 3))).toEqual(hashes(newest.filter((t) => t.ledgerSeq < 3)));
      expect(await s.getLatestTxs(0)).toEqual([]);
    });

    it('page walk over account history returns every tx once', async () => {
      const all = await fill(s, 30, 3);
      const seen: string[] = [];
      let before: number | undefined;
      for (;;) {
        const page = await s.getTxsByAccount(A, 6, before);
        if (page.length === 0) break;
        seen.push(...hashes(page));
        before = page[page.length - 1].ledgerSeq;
      }
      expect(seen).toEqual(hashes([...all].reverse()));
    });
  });

  describe('snapshots', () => {
    it('stores, overwrites and finds the latest at or before a seq', async () => {
      expect(await s.getLatestSnapshotAtOrBefore(100)).toBeUndefined();
      await s.putSnapshot(64, '{"seq":64}');
      await s.putSnapshot(128, '{"seq":128}');
      await s.putSnapshot(192, '{"seq":192}');
      await s.putSnapshot(128, '{"seq":128,"v":2}');
      expect(await s.getSnapshot(128)).toBe('{"seq":128,"v":2}');
      expect(await s.getSnapshot(1)).toBeUndefined();
      expect(await s.getLatestSnapshotAtOrBefore(128)).toEqual({ seq: 128, data: '{"seq":128,"v":2}' });
      expect(await s.getLatestSnapshotAtOrBefore(191)).toEqual({ seq: 128, data: '{"seq":128,"v":2}' });
      expect(await s.getLatestSnapshotAtOrBefore(1000)).toEqual({ seq: 192, data: '{"seq":192}' });
      expect(await s.getLatestSnapshotAtOrBefore(63)).toBeUndefined();
      expect(await s.listSnapshotSeqs()).toEqual([64, 128, 192]);
    });
  });

  describe('rollback', () => {
    it('truncateAfter removes newer ledgers, txs, snapshots and index entries', async () => {
      const all = await fill(s, 10, 2);
      await s.putSnapshot(4, 'snap4');
      await s.putSnapshot(8, 'snap8');
      await s.truncateAfter(6);
      expect(await s.getMaxLedgerSeq()).toBe(6);
      expect(await s.getLedger(7)).toBeUndefined();
      expect((await s.getLedgers(1, 10)).map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      const kept = all.filter((t) => t.ledgerSeq <= 6);
      expect(hashes(await s.getTxsByAccount(A, 100))).toEqual(hashes([...kept].reverse()));
      expect(hashes(await s.getLatestTxs(100))).toEqual(hashes([...kept].reverse()));
      expect(await s.getTx(all[all.length - 1].hash)).toBeUndefined();
      expect(await s.getTxsByLedger(7)).toEqual([]);
      expect(await s.listSnapshotSeqs()).toEqual([4]);
      // Writing after a truncate works as usual.
      await s.putLedger(ledger(7), [tx('again', 7, 0, [A])]);
      expect(hashes(await s.getTxsByAccount(A, 1))).toEqual(['again']);
    });

    it('truncateAfter(0) empties the chain', async () => {
      await fill(s, 3, 1);
      await s.putSnapshot(2, 'x');
      await s.truncateAfter(0);
      expect(await s.getMaxLedgerSeq()).toBe(0);
      expect(await s.getLatestTxs(10)).toEqual([]);
      expect(await s.listSnapshotSeqs()).toEqual([]);
    });

    it('clearChain keeps meta', async () => {
      await fill(s, 4, 2);
      await s.putSnapshot(4, 'snap');
      await s.setMeta('identity', 'S...');
      await s.clearChain();
      expect(await s.getMaxLedgerSeq()).toBe(0);
      expect(await s.getLatestLedgers(10)).toEqual([]);
      expect(await s.getLatestTxs(10)).toEqual([]);
      expect(await s.getTxsByAccount(A, 10)).toEqual([]);
      expect(await s.listSnapshotSeqs()).toEqual([]);
      expect(await s.getMeta<string>('identity')).toBe('S...');
    });
  });

  it('keeps data across close and reopen', async () => {
    await fill(s, 3, 2);
    await s.putSnapshot(2, 'snap2');
    await s.setMeta('name', 'alice');
    await s.close();
    const again = h.reopen();
    await again.open();
    expect(await again.getMaxLedgerSeq()).toBe(3);
    expect((await again.getTxsByAccount(B, 10)).length).toBe(3);
    expect(await again.getSnapshot(2)).toBe('snap2');
    expect(await again.getMeta<string>('name')).toBe('alice');
    s = again;
  });
});

describe('IdbStorage specifics', () => {
  it('separate database names are isolated', async () => {
    const a = new IdbStorage(`iso-a-${++dbCounter}`);
    const b = new IdbStorage(`iso-b-${++dbCounter}`);
    await a.open();
    await b.open();
    await a.putLedger(ledger(1), [tx('only-a', 1, 0, [A])]);
    expect(await b.getMaxLedgerSeq()).toBe(0);
    expect(await b.getTx('only-a')).toBeUndefined();
    await a.close();
    await b.close();
  });

  it('destroy deletes the database', async () => {
    const name = `destroy-${++dbCounter}`;
    const a = new IdbStorage(name);
    await a.open();
    await a.putLedger(ledger(1), []);
    await a.close();
    await IdbStorage.destroy(name);
    const b = new IdbStorage(name);
    await b.open();
    expect(await b.getMaxLedgerSeq()).toBe(0);
    await b.close();
  });

  it('closes itself when another connection deletes the database', async () => {
    const name = `blocking-${++dbCounter}`;
    const a = new IdbStorage(name);
    await a.open();
    await IdbStorage.destroy(name);
    await expect(a.getMaxLedgerSeq()).rejects.toThrow(/not open/);
  });

  it('concurrent open calls share one connection', async () => {
    const a = new IdbStorage(`concurrent-${++dbCounter}`);
    await Promise.all([a.open(), a.open(), a.open()]);
    await a.putLedger(ledger(1), []);
    expect(await a.getMaxLedgerSeq()).toBe(1);
    await a.close();
  });
});
