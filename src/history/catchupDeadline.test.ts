// A catch-up attempt from one source has an overall time budget: a source
// that answers every request just before the request timeout must not hold
// the node in catching-up for minutes (review item 7).

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { networkPassphrase } from '../lib/constants';
import { LogSink, Logger } from '../lib/log';
import { createGenesisLedger } from '../ledger/manager';
import { makeSignedStellarValue } from '../ledger/value';
import type { RequestBody, ResponseBody } from '../overlay/types';
import { CatchupError, catchUpFrom, catchupAttemptBudgetMs, type CatchupHost } from './catchup';

const PASS = networkPassphrase('catchup-deadline-test');

/** A source chain of empty ledgers 1..n. */
function chain(n: number) {
  const lm = createGenesisLedger(PASS);
  const kp = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(5));
  const ledgers = new Map<number, { headerXdr: string; txSetXdr: string }>();
  const g = lm.lastClosed();
  ledgers.set(1, { headerXdr: g.headerXdr, txSetXdr: '' });
  while (lm.lastClosed().header.ledgerSeq < n) {
    const prev = lm.lastClosed();
    const txSet = lm.makeTxSet(prev.hash, []);
    const r = lm.closeLedger(txSet, makeSignedStellarValue(lm.networkId, kp, txSet.hash, prev.header.scpValue.closeTime + 1));
    ledgers.set(r.header.ledgerSeq, { headerXdr: r.headerXdr, txSetXdr: txSet.xdr });
  }
  const tip = lm.lastClosed();
  return { ledgers, tip: { seq: tip.header.ledgerSeq, hash: tip.hash } };
}

function answer(c: ReturnType<typeof chain>, body: RequestBody): ResponseBody | null {
  if (body.kind !== 'headers' && body.kind !== 'ledgers') return null;
  const items = [];
  for (let s = body.from; s <= Math.min(body.to, body.from + 63); s++) {
    const l = c.ledgers.get(s);
    if (l) items.push({ seq: s, ...l });
  }
  return body.kind === 'headers' ? { kind: 'headers', items: items.map((i) => ({ seq: i.seq, headerXdr: i.headerXdr })) } : { kind: 'ledgers', items };
}

describe('catch-up attempt budget', () => {
  it('grows with the ledgers to fetch', () => {
    expect(catchupAttemptBudgetMs(0)).toBe(30_000);
    expect(catchupAttemptBudgetMs(1)).toBe(35_000);
    expect(catchupAttemptBudgetMs(64)).toBe(35_000);
    expect(catchupAttemptBudgetMs(200)).toBe(50_000);
  });

  it('a source that answers each request after 9 s is dropped when the budget is spent; the progress stays', async () => {
    const c = chain(200);
    const clock = new VirtualClock(0);
    const state = { lm: createGenesisLedger(PASS), requests: 0 };
    const deadline = clock.now() + catchupAttemptBudgetMs(c.tip.seq - 1);
    const host: CatchupHost = {
      request: async (_id, body) => {
        state.requests++;
        await clock.advance(9_000);
        const res = answer(c, body);
        if (!res) throw Object.assign(new Error('no data'), { code: 'no-data' });
        return res;
      },
      passphrase: PASS,
      logger: new Logger(new LogSink(clock, 'error'), 'catchup'),
      ledger: () => state.lm,
      installSnapshot: async (lm) => {
        state.lm = lm;
      },
      replayed: () => undefined,
      expired: () => clock.now() > deadline,
    };
    let err: unknown = null;
    try {
      await catchUpFrom(host, 'slow', c.tip, { allowSnapshot: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CatchupError);
    expect((err as CatchupError).code).toBe('network');
    expect((err as CatchupError).message).toMatch(/took too long/);
    // the attempt ended soon after its budget, not after all 9 requests (81 s)
    expect(clock.now()).toBeLessThanOrEqual(deadline + 9_000);
    expect(state.requests).toBeLessThan(9);
    // what was replayed before the budget ran out is kept: the next attempt goes on from there
    const reached = state.lm.lastClosed().header.ledgerSeq;
    expect(reached).toBeGreaterThan(1);
    const fast: CatchupHost = { ...host, request: async (_id, body) => answer(c, body)!, expired: () => false };
    const res = await catchUpFrom(fast, 'fast', c.tip, { allowSnapshot: false });
    expect(res.from).toBe(reached);
    expect(state.lm.lastClosed().hash).toBe(c.tip.hash);
  });
});
