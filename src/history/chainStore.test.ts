import { Asset, Keypair, Operation } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { networkPassphrase } from '../lib/constants';
import { LogSink, Logger } from '../lib/log';
import { createGenesisLedger, type LedgerManager } from '../ledger/manager';
import { TestLedger, XLM } from '../ledger/testkit';
import type { LedgerCloseResult } from '../ledger/types';
import { MemoryStorage } from '../storage/memoryStorage';
import { ChainStore, genesisStoredLedger, toStoredLedger, toStoredTxs } from './chainStore';
import { HistoryServer, MAX_LEDGERS_PER_REQUEST } from './server';

const PASS = networkPassphrase('chainstore-test');

async function setup(storage = new MemoryStorage()) {
  await storage.open();
  const clock = new VirtualClock();
  const chain = new ChainStore({ storage, passphrase: PASS, clock, logger: new Logger(new LogSink(clock, 'error'), 'c') });
  return { storage, chain, clock };
}

/** Close `n` ledgers on lm (some with payments) and record them in the chain store. */
function closeLedgers(chain: ChainStore, lm: LedgerManager, n: number): LedgerCloseResult[] {
  const tl = new TestLedger(lm, PASS);
  const users = [Keypair.random(), Keypair.random()];
  const out: LedgerCloseResult[] = [];
  for (let i = 0; i < n; i++) {
    let r: LedgerCloseResult;
    if (i === 0 && !lm.getAccount(users[0].publicKey())) r = tl.fund(users, 50n * XLM);
    else r = tl.close(i % 2 ? [tl.tx(users[0], [Operation.payment({ destination: users[1].publicKey(), asset: Asset.native(), amount: '1' })])] : []);
    const seq = r.header.ledgerSeq;
    chain.record(r, 3, seq % 64 === 0 ? JSON.stringify(lm.snapshot()) : null);
    out.push(r);
  }
  return out;
}

describe('ChainStore', () => {
  it('creates and stores genesis on an empty storage', async () => {
    const { chain, storage } = await setup();
    const load = await chain.loadLedger();
    expect(load).toMatchObject({ fromSnapshot: 1, replayed: 0, truncatedAfter: null });
    expect(load.ledger.lastClosed().hash).toBe(createGenesisLedger(PASS).lastClosed().hash);
    expect((await storage.getLedger(1))?.hash).toBe(load.ledger.lastClosed().hash);
    expect(chain.hashAt(1)).toBe(load.ledger.lastClosed().hash);
  });

  it('records ledgers (memory first, storage after flush) and reloads them by replay', async () => {
    const { chain, storage } = await setup();
    const { ledger } = await chain.loadLedger();
    const results = closeLedgers(chain, ledger, 10);
    const last = results[results.length - 1];
    expect(chain.recentLedger(11)?.hash).toBe(last.hash);
    await chain.flush();
    expect((await storage.getLedger(11))?.hash).toBe(last.hash);
    expect((await storage.getTxsByLedger(3)).length).toBe(1);
    const again = await setup(storage);
    const load = await again.chain.loadLedger();
    expect(load.replayed).toBe(10);
    expect(load.ledger.lastClosed().hash).toBe(last.hash);
    expect(again.chain.hashAt(7)).toBe(results[5].hash);
  });

  it('loads from the latest snapshot and replays only the ledgers after it', async () => {
    const { chain, storage } = await setup();
    const { ledger } = await chain.loadLedger();
    const results = closeLedgers(chain, ledger, 69);
    await chain.flush();
    expect(await storage.listSnapshotSeqs()).toEqual([64]);
    const again = await setup(storage);
    const load = await again.chain.loadLedger();
    expect(load).toMatchObject({ fromSnapshot: 64, replayed: 6 });
    expect(load.ledger.lastClosed().hash).toBe(results[results.length - 1].hash);
  });

  it('cuts storage at the first ledger that does not replay', async () => {
    const { chain, storage } = await setup();
    const { ledger } = await chain.loadLedger();
    closeLedgers(chain, ledger, 8);
    await chain.flush();
    const bad = (await storage.getLedger(6))!;
    await storage.putLedger({ ...bad, hash: 'f'.repeat(64) }, await storage.getTxsByLedger(6));
    const again = await setup(storage);
    const load = await again.chain.loadLedger();
    expect(load.truncatedAfter).toBe(5);
    expect(load.ledger.lastClosed().header.ledgerSeq).toBe(5);
    expect(await storage.getMaxLedgerSeq()).toBe(5);
  });

  it('clears a chain from another network', async () => {
    const storage = new MemoryStorage();
    await storage.open();
    const other = createGenesisLedger(networkPassphrase('elsewhere'));
    await storage.putLedger(genesisStoredLedger(other, 0), []);
    const { chain } = await setup(storage);
    const load = await chain.loadLedger();
    expect(load.ledger.networkPassphrase).toBe(PASS);
    expect((await storage.getLedger(1))?.hash).toBe(load.ledger.lastClosed().hash);
  });

  it('branch weight, raised counts, truncation and discarded txs', async () => {
    const { chain, storage } = await setup();
    const { ledger } = await chain.loadLedger();
    closeLedgers(chain, ledger, 6);
    expect(await chain.branchWeight(1, 7)).toBe(18);
    chain.raiseExternalizedBy(5, 5);
    chain.raiseExternalizedBy(5, 2);
    expect(chain.recentLedger(5)?.externalizedBy).toBe(5);
    expect(await chain.branchWeight(4, 7)).toBe(5 + 3 + 3);
    await chain.flush();
    expect((await storage.getLedger(5))?.externalizedBy).toBe(5);
    expect((await storage.getTxsByLedger(5)).length).toBe(1);
    const envs = await chain.txEnvelopesAfter(3, 7);
    expect(envs.length).toBe(2);
    await chain.truncateAfter(4);
    expect(chain.recentLedger(5)).toBeUndefined();
    expect(await storage.getMaxLedgerSeq()).toBe(4);
    expect((await chain.getLedgers(1, 10)).map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    await chain.clear();
    expect(await storage.getMaxLedgerSeq()).toBe(0);
  });

  it('builds stored records from a close result', () => {
    const tl = new TestLedger(undefined, PASS);
    const a = Keypair.random();
    const r = tl.fund([a]);
    const stored = toStoredLedger(r, 4, 123);
    expect(stored).toMatchObject({ seq: 2, hash: r.hash, txCount: 1, opCount: 1, failedTxCount: 0, closedAt: 123, externalizedBy: 4 });
    const txs = toStoredTxs(r);
    expect(txs[0]).toMatchObject({ hash: r.results[0].hash, ledgerSeq: 2, applyIndex: 0, successful: true, resultCode: 'txSUCCESS' });
    expect(JSON.parse(txs[0].summaryJson).operations[0].type).toBe('createAccount');
  });
});

describe('HistoryServer', () => {
  it('serves headers and ledgers (at most 64), snapshots and branch weights', async () => {
    const { chain } = await setup();
    const { ledger } = await chain.loadLedger();
    closeLedgers(chain, ledger, 69);
    const server = new HistoryServer({ chain, passphrase: PASS, ledger: () => ledger, scpState: () => ['AAAA'] });
    const h = await server.handle({ kind: 'headers', from: 0, to: 500 });
    expect(h?.kind === 'headers' && h.items.map((i) => i.seq)).toEqual(Array.from({ length: MAX_LEDGERS_PER_REQUEST }, (_, i) => i + 1));
    const l = await server.handle({ kind: 'ledgers', from: 65, to: 90 });
    expect(l?.kind === 'ledgers' && l.items.map((i) => i.seq)).toEqual([65, 66, 67, 68, 69, 70]);
    const s = await server.handle({ kind: 'snapshot', atOrBefore: 100 });
    expect(s?.kind === 'snapshot' && s.seq).toBe(64);
    const g = await server.handle({ kind: 'snapshot', atOrBefore: 10 });
    expect(g?.kind === 'snapshot' && g.seq).toBe(1);
    expect(g?.kind === 'snapshot' && JSON.parse(g.data).hash).toBe(createGenesisLedger(PASS).lastClosed().hash);
    expect(await server.handle({ kind: 'snapshot', atOrBefore: 0 })).toBeNull();
    const w = await server.handle({ kind: 'branchWeight', afterSeq: 60 });
    expect(w).toEqual({ kind: 'branchWeight', afterSeq: 60, weight: 30, lcl: { seq: 70, hash: ledger.lastClosed().hash } });
    expect(await server.handle({ kind: 'scpState', fromSlot: 3 })).toEqual({ kind: 'scpState', envelopes: ['AAAA'] });
    const none = new HistoryServer({ chain, passphrase: PASS, ledger: () => ledger, scpState: () => null });
    expect(await none.handle({ kind: 'scpState', fromSlot: 3 })).toBeNull();
  });
});
