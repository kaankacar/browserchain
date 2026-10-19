// Branch weight requests are bounded (review: one {kind:'branchWeight',
// afterSeq: 0} request read every stored ledger, 196 storage reads and 50,000
// rows for 50,000 ledgers). Every node weighs the same window after the fork
// point, so fork verdicts stay consistent.

import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { LogSink, Logger } from '../lib/log';
import type { ILedgerManager } from '../ledger/types';
import { MemoryStorage } from '../storage/memoryStorage';
import type { StoredLedger } from '../storage/types';
import { ChainStore, MAX_BRANCH_WEIGHT_LEDGERS, branchWeightEnd } from './chainStore';
import { decideFork } from './fork';
import { HistoryServer } from './server';

class CountingStorage extends MemoryStorage {
  reads = 0;
  rows = 0;
  override async getLedgers(from: number, to: number): Promise<StoredLedger[]> {
    const out = await super.getLedgers(from, to);
    this.reads++;
    this.rows += out.length;
    return out;
  }
}

function row(seq: number, externalizedBy: number, tag = 'a'): StoredLedger {
  return {
    seq,
    hash: `${tag}${seq.toString(16)}`.padEnd(64, '0'),
    headerXdr: '',
    txSetXdr: '',
    resultSetXdr: '',
    closeTime: seq,
    txCount: 0,
    opCount: 0,
    failedTxCount: 0,
    closedAt: 0,
    externalizedBy,
  };
}

/** A chain store over `n` synthetic ledgers (weight w(seq)), and a server at LCL n. */
async function chainOf(n: number, w: (seq: number) => number, tag = 'a') {
  const storage = new CountingStorage();
  await storage.open();
  for (let s = 1; s <= n; s++) await storage.putLedger(row(s, w(s), tag), []);
  const clock = new VirtualClock();
  const chain = new ChainStore({ storage, passphrase: 'branch weight test', clock, logger: new Logger(new LogSink(clock, 'error'), 'c') });
  const lcl = { header: { ledgerSeq: n }, hash: row(n, 0, tag).hash, headerXdr: '' };
  const ledger = { lastClosed: () => lcl } as unknown as ILedgerManager;
  const server = new HistoryServer({ chain, passphrase: 'branch weight test', ledger: () => ledger, scpState: () => null });
  storage.reads = 0;
  storage.rows = 0;
  return { storage, chain, server, lcl };
}

describe('branch weight requests', () => {
  it('one request reads a bounded window, not the whole chain', async () => {
    const { storage, server } = await chainOf(50_000, () => 3);
    const res = await server.handle({ kind: 'branchWeight', afterSeq: 0 });
    expect(storage.rows, `${storage.reads} reads, ${storage.rows} rows`).toBeLessThanOrEqual(1024);
    expect(storage.reads).toBeLessThanOrEqual(4);
    expect(res).toMatchObject({ kind: 'branchWeight', afterSeq: 0, weight: 3 * MAX_BRANCH_WEIGHT_LEDGERS, lcl: { seq: 50_000 } });
  });

  it('weighs (afterSeq, min(lcl, afterSeq + MAX)] on the server and locally', async () => {
    expect(MAX_BRANCH_WEIGHT_LEDGERS).toBe(1024);
    expect(branchWeightEnd(10, 50)).toBe(50);
    expect(branchWeightEnd(10, 5_000)).toBe(10 + MAX_BRANCH_WEIGHT_LEDGERS);
    const { chain, server } = await chainOf(3_000, (s) => s % 5);
    let expected = 0;
    for (let s = 101; s <= 100 + MAX_BRANCH_WEIGHT_LEDGERS; s++) expected += s % 5;
    expect(await chain.branchWeight(100, 3_000)).toBe(expected);
    const res = await server.handle({ kind: 'branchWeight', afterSeq: 100 });
    expect(res?.kind === 'branchWeight' && res.weight).toBe(expected);
    // a short branch is weighed whole
    let short = 0;
    for (let s = 2_901; s <= 3_000; s++) short += s % 5;
    expect(await chain.branchWeight(2_900, 3_000)).toBe(short);
  });

  it('two long branches get the same verdict on both sides', async () => {
    // fork after ledger 1000: branch A has 3 validators for 1200 ledgers, then
    // grows long alone; branch B has 2 validators for 3000 ledgers
    const a = await chainOf(9_000, (s) => (s <= 2_200 ? 3 : 1), 'a');
    const b = await chainOf(4_000, () => 2, 'b');
    const fp = 1_000;
    const wa = await a.chain.branchWeight(fp, a.lcl.header.ledgerSeq);
    const wb = await b.chain.branchWeight(fp, b.lcl.header.ledgerSeq);
    const ra = await a.server.handle({ kind: 'branchWeight', afterSeq: fp });
    const rb = await b.server.handle({ kind: 'branchWeight', afterSeq: fp });
    expect(ra?.kind === 'branchWeight' && ra.weight).toBe(wa);
    expect(rb?.kind === 'branchWeight' && rb.weight).toBe(wb);
    expect(wa).toBe(3 * MAX_BRANCH_WEIGHT_LEDGERS);
    expect(wb).toBe(2 * MAX_BRANCH_WEIGHT_LEDGERS);
    const A = { weight: wa, lcl: { seq: 9_000, hash: a.lcl.hash }, first: 'a' };
    const B = { weight: wb, lcl: { seq: 4_000, hash: b.lcl.hash }, first: 'b' };
    expect(decideFork(A, B)).toBe('ours');
    expect(decideFork(B, A)).toBe('theirs');
  });
});
