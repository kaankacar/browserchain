import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { LogSink } from '../lib/log';
import { MemoryNetwork } from '../overlay/memoryNetwork';
import { MemoryStorage } from '../storage/memoryStorage';
import type { StoredLedger, StoredTx } from '../storage/types';
import { FallbackStorage, isStorageFailure } from './fallbackStorage';
import { Node } from './node';
import { NodeService } from './service';

/** A MemoryStorage that runs out of quota after `writesLeft` writes, like a full IndexedDB. */
class QuotaStorage extends MemoryStorage {
  writesLeft = Infinity;
  failTruncate = false;
  failReads = false;

  private spend(): void {
    if (this.writesLeft <= 0) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.writesLeft--;
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    this.spend();
    return super.setMeta(key, value);
  }

  async putLedger(ledger: StoredLedger, txs: StoredTx[]): Promise<void> {
    this.spend();
    return super.putLedger(ledger, txs);
  }

  async putSnapshot(seq: number, data: string): Promise<void> {
    this.spend();
    return super.putSnapshot(seq, data);
  }

  async truncateAfter(seq: number): Promise<void> {
    if (this.failTruncate) throw new Error('truncate failed');
    return super.truncateAfter(seq);
  }

  async getLedger(seq: number): Promise<StoredLedger | undefined> {
    if (this.failReads) throw new Error('read failed');
    return super.getLedger(seq);
  }
}

function ledger(seq: number, tag = 'a'): StoredLedger {
  return {
    seq,
    hash: `${tag}${seq}`.padEnd(64, '0'),
    headerXdr: '',
    txSetXdr: '',
    resultSetXdr: '',
    closeTime: seq,
    txCount: 1,
    opCount: 1,
    failedTxCount: 0,
    closedAt: seq,
    externalizedBy: 1,
  };
}

function tx(seq: number, tag = 'a', account = 'GACC'): StoredTx {
  return {
    hash: `${tag}tx${seq}`,
    ledgerSeq: seq,
    applyIndex: 0,
    envelopeXdr: '',
    resultXdr: '',
    sourceAccount: account,
    feeCharged: '100',
    maxFee: '100',
    successful: true,
    resultCode: 'txSUCCESS',
    closeTime: seq,
    accounts: [account],
    summaryJson: '{}',
  };
}

describe('isStorageFailure', () => {
  it('knows quota and lost-connection errors', () => {
    expect(isStorageFailure(new DOMException('full', 'QuotaExceededError'))).toBe(true);
    expect(isStorageFailure({ name: 'NS_ERROR_DOM_QUOTA_REACHED', message: '' })).toBe(true);
    expect(isStorageFailure({ name: 'AbortError', message: 'x', inner: new DOMException('full', 'QuotaExceededError') })).toBe(true);
    expect(isStorageFailure(new Error('IdbStorage browserchain:main:slot:0 is not open'))).toBe(true);
    expect(isStorageFailure(new DOMException('closing', 'InvalidStateError'))).toBe(true);
    expect(isStorageFailure(new TypeError('tx abc has ledgerSeq 3, expected 4'))).toBe(false);
    expect(isStorageFailure(null)).toBe(false);
  });

  it('knows internal IndexedDB write errors (Chromium: UnknownError when the backing store fails)', async () => {
    expect(isStorageFailure(new DOMException('Internal error committing transaction.', 'UnknownError'))).toBe(true);
    const primary = new QuotaStorage();
    primary.putLedger = () => Promise.reject(new DOMException('Internal error committing transaction.', 'UnknownError'));
    const reasons: string[] = [];
    const s = new FallbackStorage(primary, (reason) => reasons.push(reason));
    await s.open();
    await s.putLedger(ledger(1), [tx(1)]);
    expect(s.inMemory).toBe(true);
    expect(reasons).toEqual(['IndexedDB refused ledger 1']);
    expect((await s.getLedger(1))?.seq).toBe(1);
  });
});

describe('FallbackStorage', () => {
  it('passes through until IndexedDB is full, then keeps new data in memory and merges reads', async () => {
    const primary = new QuotaStorage();
    const reasons: string[] = [];
    const s = new FallbackStorage(primary, (reason) => reasons.push(reason));
    await s.open();
    await s.setMeta('identity', 'S1');
    for (let i = 1; i <= 5; i++) await s.putLedger(ledger(i), [tx(i)]);
    await s.putSnapshot(4, 'snap4');
    expect(s.inMemory).toBe(false);
    expect(await primary.getMaxLedgerSeq()).toBe(5);

    // a bad write that is not a quota problem still fails, and changes nothing
    await expect(s.putLedger(ledger(6), [{ ...tx(6), ledgerSeq: 9 }])).rejects.toThrow(/expected 6/);
    expect(s.inMemory).toBe(false);
    primary.writesLeft = 0;
    await s.putLedger(ledger(6), [tx(6)]);
    expect(s.inMemory).toBe(true);
    expect(reasons).toEqual(['IndexedDB refused ledger 6']);
    for (let i = 7; i <= 9; i++) await s.putLedger(ledger(i), [tx(i)]);
    await s.putSnapshot(8, 'snap8');
    await s.setMeta('name', 'tab');
    expect(reasons).toHaveLength(1);
    expect(await primary.getMaxLedgerSeq()).toBe(5);

    // reads see both
    expect(await s.getMeta('identity')).toBe('S1');
    expect(await s.getMeta('name')).toBe('tab');
    expect(await s.getMaxLedgerSeq()).toBe(9);
    expect((await s.getLedger(3))?.hash).toBe(ledger(3).hash);
    expect((await s.getLedger(8))?.hash).toBe(ledger(8).hash);
    expect((await s.getLedgers(4, 7)).map((l) => l.seq)).toEqual([4, 5, 6, 7]);
    expect((await s.getLatestLedgers(4)).map((l) => l.seq)).toEqual([9, 8, 7, 6]);
    expect((await s.getLatestLedgers(3, 7)).map((l) => l.seq)).toEqual([6, 5, 4]);
    expect((await s.getTx('atx2'))?.ledgerSeq).toBe(2);
    expect((await s.getTx('atx7'))?.ledgerSeq).toBe(7);
    expect((await s.getTxsByLedger(2)).map((t) => t.hash)).toEqual(['atx2']);
    expect((await s.getTxsByAccount('GACC', 4)).map((t) => t.ledgerSeq)).toEqual([9, 8, 7, 6]);
    expect((await s.getLatestTxs(3, 7)).map((t) => t.ledgerSeq)).toEqual([6, 5, 4]);
    expect(await s.listSnapshotSeqs()).toEqual([4, 8]);
    expect(await s.getSnapshot(4)).toBe('snap4');
    expect((await s.getLatestSnapshotAtOrBefore(7))?.seq).toBe(4);
    expect((await s.getLatestSnapshotAtOrBefore(9))?.seq).toBe(8);

    // a ledger rewritten in memory hides its old copy and txs
    await s.putLedger({ ...ledger(5, 'b') }, [tx(5, 'b')]);
    expect((await s.getLedger(5))?.hash).toBe(ledger(5, 'b').hash);
    expect((await s.getTxsByLedger(5)).map((t) => t.hash)).toEqual(['btx5']);
    expect(await s.getTx('atx5')).toBeUndefined();
    expect((await s.getLatestTxs(10)).map((t) => t.hash)).not.toContain('atx5');
  });

  it('hides IndexedDB data above a rollback point even if IndexedDB cannot delete it', async () => {
    const primary = new QuotaStorage();
    const s = new FallbackStorage(primary);
    await s.open();
    for (let i = 1; i <= 6; i++) await s.putLedger(ledger(i), [tx(i)]);
    await s.putSnapshot(4, 'snap4');
    primary.writesLeft = 0;
    await s.putLedger(ledger(7), [tx(7)]);
    primary.failTruncate = true;
    await s.truncateAfter(3);
    expect(await s.getMaxLedgerSeq()).toBe(3);
    expect(await s.getLedger(5)).toBeUndefined();
    expect((await s.getLedgers(1, 10)).map((l) => l.seq)).toEqual([1, 2, 3]);
    expect((await s.getLatestLedgers(10)).map((l) => l.seq)).toEqual([3, 2, 1]);
    expect(await s.getTx('atx5')).toBeUndefined();
    expect(await s.getTxsByLedger(5)).toEqual([]);
    expect((await s.getLatestTxs(10)).map((t) => t.ledgerSeq)).toEqual([3, 2, 1]);
    expect(await s.listSnapshotSeqs()).toEqual([]);
    expect(await s.getLatestSnapshotAtOrBefore(10)).toBeUndefined();
    // the other branch is written again, in memory
    await s.putLedger(ledger(4, 'c'), [tx(4, 'c')]);
    expect((await s.getLedgers(1, 10)).map((l) => l.hash)).toEqual([ledger(1).hash, ledger(2).hash, ledger(3).hash, ledger(4, 'c').hash]);
    await s.clearChain();
    expect(await s.getMaxLedgerSeq()).toBe(0);
    expect(await s.getLedger(1)).toBeUndefined();
    // a failing IndexedDB read in memory mode reads as empty
    await s.putLedger(ledger(1, 'd'), []);
    primary.failReads = true;
    expect((await s.getLedger(1))?.hash).toBe(ledger(1, 'd').hash);
    expect(await s.getLedger(2)).toBeUndefined();
  });

  it('runs in memory when IndexedDB does not open', async () => {
    const primary = new QuotaStorage();
    primary.open = async () => {
      throw new DOMException('private mode', 'InvalidStateError');
    };
    const reasons: string[] = [];
    const s = new FallbackStorage(primary, (r) => reasons.push(r));
    await s.open();
    expect(s.inMemory).toBe(true);
    expect(reasons).toEqual(['IndexedDB could not be opened']);
    await s.setMeta('identity', 'S2');
    expect(await s.getMeta('identity')).toBe('S2');
    await s.putLedger(ledger(1), []);
    expect(await s.getMaxLedgerSeq()).toBe(1);
    await s.close();
    await s.open();
    expect(await s.getMeta('identity')).toBe('S2');
  });
});

describe('a node on a full IndexedDB', () => {
  it('keeps closing ledgers, reports one error, serves its history, and reloads after a restart', async () => {
    const clock = new VirtualClock();
    const net = new MemoryNetwork({ clock });
    const primary = new QuotaStorage();
    const logSink = new LogSink(clock, 'info');
    const errors: string[] = [];
    const storage = new FallbackStorage(primary, (reason, err) => logSink.write('error', 'storage', `${reason}: ${(err as Error).message}`));
    logSink.subscribe((e) => {
      if (e.level === 'error') errors.push(e.msg);
    });
    const start = async () => {
      const node = new Node({ transports: [net.createTransport(`solo${Math.random()}`)], storage, clock, logSink, networkName: 'quota' });
      await node.start();
      return node;
    };
    const node = await start();
    await clock.advance(20_000);
    expect(node.state).toBe('synced');
    const atFull = node.ledger.lastClosed().header.ledgerSeq;
    primary.writesLeft = 0;
    const svc = new NodeService(node, { clock });
    const user = Keypair.random().publicKey();
    const fb = await svc.friendbot(user);
    expect(fb.status).toBe('PENDING');
    await clock.advance(30_000);
    const lcl = node.ledger.lastClosed().header.ledgerSeq;
    expect(lcl).toBeGreaterThan(atFull + 4);
    expect(node.state).toBe('synced');
    expect(storage.inMemory).toBe(true);
    // one error, through the log the UI shows
    expect(errors.filter((m) => m.includes('IndexedDB refused'))).toHaveLength(1);
    expect((await svc.getLogs(100)).some((e) => e.level === 'error' && e.msg.includes('IndexedDB refused'))).toBe(true);
    // history spans IndexedDB and memory
    const ledgers = await svc.getLedgers({ limit: 200 });
    expect(ledgers.map((l) => l.seq)).toEqual(Array.from({ length: lcl }, (_, i) => lcl - i));
    expect((await svc.getTransaction(fb.hash))?.successful).toBe(true);
    expect((await svc.getAccount(user))?.balances[0].balance).toBe('10000.0000000');
    const hash = node.ledger.lastClosed().hash;
    await node.stop();
    // same storage object (the tab is still open): the chain loads from both parts
    const again = await start();
    expect(again.ledger.lastClosed().hash).toBe(hash);
    expect(again.nodeId).toBe(node.nodeId);
    await clock.advance(10_000);
    expect(again.ledger.lastClosed().header.ledgerSeq).toBeGreaterThan(lcl);
    await again.stop();
  });
});
