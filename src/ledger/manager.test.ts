import { Asset, Keypair, Operation, StrKey, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { fromHex } from '../lib/bytes';
import { FRIENDBOT_AMOUNT } from '../lib/constants';
import { sha256 } from '../lib/hash';
import { seededRng, randInt } from '../lib/random';
import { computeStateHash } from './entries';
import { decodeLedgerHeader, encodeLedgerHeader, hashLedgerHeader } from './header';
import { genesisEntries } from './genesis';
import { createGenesisLedger, loadLedgerFromSnapshot } from './manager';
import { TEST_PASSPHRASE, TestLedger, XLM, customLedger, newAccountEntry, stroopsToString } from './testkit';
import type { LedgerEntry, LedgerSnapshot, OfferEntry } from './types';
import { makeSignedStellarValue } from './value';

const native = Asset.native();

function payments(t: TestLedger, n: number, rng: () => number, accounts: Keypair[]): string[] {
  const envs: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < n; i++) {
    const from = accounts[randInt(rng, 0, accounts.length - 1)];
    if (used.has(from.publicKey())) continue;
    used.add(from.publicKey());
    const to = accounts[randInt(rng, 0, accounts.length - 1)];
    const amount = BigInt(randInt(rng, 1, 100_000_000));
    envs.push(t.tx(from, [Operation.payment({ destination: to.publicKey(), asset: native, amount: stroopsToString(amount) })]));
  }
  return envs;
}

describe('snapshots', () => {
  it('round trips and verifies the state hash and header hash', () => {
    const t = new TestLedger();
    const a = Keypair.random();
    t.fund([a]);
    t.apply(t.tx(a, [Operation.manageData({ name: 'k', value: 'v' })]));
    const snap = t.lm.snapshot();
    expect(snap.seq).toBe(t.ledgerSeq);
    expect(snap.hash).toBe(t.lm.lastClosed().hash);
    expect(snap.networkPassphrase).toBe(TEST_PASSPHRASE);
    const json = JSON.parse(JSON.stringify(snap)) as LedgerSnapshot;
    const loaded = loadLedgerFromSnapshot(json, TEST_PASSPHRASE);
    expect(loaded.lastClosed()).toEqual(t.lm.lastClosed());
    expect(loaded.stateHash()).toBe(t.lm.stateHash());
    expect(loaded.allEntries()).toEqual(t.lm.allEntries());

    // Both continue identically.
    const t2 = new TestLedger(loaded);
    t2.closeTime = t.closeTime;
    t2.node = t.node;
    const env = t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })]);
    const r1 = t.close([env]);
    const r2 = t2.close([env]);
    expect(r2.hash).toBe(r1.hash);
  });

  it('rejects tampered snapshots', () => {
    const t = new TestLedger();
    t.fund([Keypair.random()]);
    const snap = JSON.parse(JSON.stringify(t.lm.snapshot())) as LedgerSnapshot;
    const tamperedEntry = structuredClone(snap);
    (tamperedEntry.entries[0] as Record<string, unknown>).balance = '1';
    expect(() => loadLedgerFromSnapshot(tamperedEntry)).toThrow(/state hash/);
    const missing = structuredClone(snap);
    missing.entries.pop();
    expect(() => loadLedgerFromSnapshot(missing)).toThrow(/state hash/);
    const badHash = { ...snap, hash: 'ab'.repeat(32) };
    expect(() => loadLedgerFromSnapshot(badHash)).toThrow(/header hash/);
    const header = decodeLedgerHeader(snap.headerXdr);
    header.feePool += 1n;
    const otherHeader = { ...snap, headerXdr: encodeLedgerHeader(header) };
    expect(() => loadLedgerFromSnapshot(otherHeader)).toThrow(/header hash/);
    const badSeq = { ...snap, seq: snap.seq + 1 };
    expect(() => loadLedgerFromSnapshot(badSeq)).toThrow(/sequence/);
    const dup = structuredClone(snap);
    dup.entries.push(dup.entries[0]);
    expect(() => loadLedgerFromSnapshot(dup)).toThrow();
    expect(() => loadLedgerFromSnapshot(snap, 'another network')).toThrow(/another network/);
    expect(() => loadLedgerFromSnapshot({ ...snap, version: 2 as 1 })).toThrow();
  });

  it('genesis snapshot loads back to genesis', () => {
    const g = createGenesisLedger(TEST_PASSPHRASE);
    const loaded = loadLedgerFromSnapshot(g.snapshot());
    expect(loaded.lastClosed().hash).toBe(g.lastClosed().hash);
    expect(hashLedgerHeader(loaded.lastClosed().header)).toBe(g.lastClosed().hash);
  });
});

describe('determinism', () => {
  it('two managers fed the same tx sets reach identical header hashes over 20 ledgers', () => {
    const rng = seededRng(12345);
    const a = new TestLedger();
    const b = new TestLedger();
    const accounts = Array.from({ length: 12 }, () => Keypair.random());
    const fundEnv = a.tx(
      a.root,
      accounts.map((k) => Operation.createAccount({ destination: k.publicKey(), startingBalance: '1000' })),
    );
    const node = Keypair.random();
    let closeTime = 1_790_000_000;
    const step = (envs: string[]) => {
      closeTime += randInt(rng, 1, 10);
      const setA = a.lm.makeTxSet(a.lm.lastClosed().hash, envs);
      const setB = b.lm.decodeTxSet(setA.xdr);
      expect(setB).toEqual(setA);
      expect(a.lm.checkTxSetValid(setA, closeTime)).toEqual({ valid: true });
      const value = makeSignedStellarValue(a.lm.networkId, node, setA.hash, closeTime);
      const ra = a.lm.closeLedger(setA, value);
      const rb = b.lm.closeLedger(setB, value);
      expect(rb.hash).toBe(ra.hash);
      expect(rb.resultSetXdr).toBe(ra.resultSetXdr);
      expect(rb.header).toEqual(ra.header);
      return ra;
    };
    step([fundEnv]);
    let applied = 0;
    for (let i = 0; i < 20; i++) {
      const envs = payments(a, randInt(rng, 1, 10), rng, accounts);
      const r = step(envs);
      applied += r.results.length;
      expect(r.results.every((x) => x.successful)).toBe(true);
    }
    expect(applied).toBeGreaterThan(20);
    expect(a.lm.stateHash()).toBe(b.lm.stateHash());
    // The cached entry hashes agree with a fresh computation.
    expect(computeStateHash(a.lm.allEntries())).toBe(a.lm.stateHash());
    // A third node loading a snapshot of A agrees too.
    const c = loadLedgerFromSnapshot(a.lm.snapshot());
    expect(c.lastClosed().hash).toBe(a.lm.lastClosed().hash);
  });

  it('the apply order does not depend on the order envelopes were given', () => {
    const t1 = new TestLedger();
    const t2 = new TestLedger();
    t2.node = t1.node;
    // Channel payments of FRIENDBOT_AMOUNT (the only payment the channel policy allows).
    const amount = stroopsToString(FRIENDBOT_AMOUNT);
    const envs = t1.channels.slice(0, 8).map((kp, i) =>
      t1.tx(kp, [Operation.payment({ destination: t1.channels[(i + 1) % 8].publicKey(), asset: native, amount })]),
    );
    const r1 = t1.close(envs);
    const r2 = t2.close([...envs].reverse());
    expect(r1.results.map((r) => r.resultCode)).toEqual(Array(8).fill('txSUCCESS'));
    expect(r2.hash).toBe(r1.hash);
    expect(r2.results.map((r) => r.hash)).toEqual(r1.results.map((r) => r.hash));
  });
});

describe('checkTxSetValid', () => {
  it('accepts valid chains and rejects bad ones', () => {
    const t = new TestLedger();
    const a = Keypair.random();
    const b = Keypair.random();
    t.fund([a, b]);
    const lcl = t.lm.lastClosed();
    const seq = t.seqOf(a.publicKey());
    const pay = (s: bigint, opts = {}) =>
      t.tx(a, [Operation.payment({ destination: b.publicKey(), asset: native, amount: '1' })], { seq: s, ...opts });
    const ct = t.closeTime + 5;
    const ok = t.lm.makeTxSet(lcl.hash, [pay(seq + 1n), pay(seq + 2n), pay(seq + 3n)]);
    expect(t.lm.checkTxSetValid(ok, ct)).toEqual({ valid: true });

    const gap = t.lm.makeTxSet(lcl.hash, [pay(seq + 1n), pay(seq + 3n)]);
    expect(t.lm.checkTxSetValid(gap, ct)).toMatchObject({ valid: false });
    expect(t.lm.checkTxSetValid(gap, ct).reason).toContain('txBAD_SEQ');

    const dupSeq = t.lm.makeTxSet(lcl.hash, [pay(seq + 1n), pay(seq + 1n, { baseFee: 200 })]);
    expect(t.lm.checkTxSetValid(dupSeq, ct).valid).toBe(false);

    const wrongPrev = t.lm.makeTxSet('00'.repeat(32), [pay(seq + 1n)]);
    expect(t.lm.checkTxSetValid(wrongPrev, ct).reason).toBe('previous ledger hash mismatch');

    const forged = { ...ok, hash: 'ab'.repeat(32) };
    expect(t.lm.checkTxSetValid(forged, ct).reason).toBe('tx set hash mismatch');

    const sorted = t.lm.makeTxSet(lcl.hash, [pay(seq + 1n), pay(seq + 2n)]);
    const reversedXdr = new xdr.TransactionSet({
      previousLedgerHash: fromHex(lcl.hash),
      txs: [...sorted.txs].reverse().map((e) => xdr.TransactionEnvelope.fromXdr(e, 'base64')),
    }).toXdr('base64');
    const reversed = t.lm.decodeTxSet(reversedXdr);
    expect(t.lm.checkTxSetValid(reversed, ct).reason).toContain('canonical order');

    const late = t.lm.makeTxSet(lcl.hash, [pay(seq + 1n, { timebounds: { minTime: 0, maxTime: ct - 1 } })]);
    expect(t.lm.checkTxSetValid(late, ct).reason).toContain('txTOO_LATE');
    expect(t.lm.checkTxSetValid(late, ct - 1).valid).toBe(true);

    const unsigned = t.lm.makeTxSet(lcl.hash, [pay(seq + 1n, { signers: [] })]);
    expect(t.lm.checkTxSetValid(unsigned, ct).reason).toContain('txBAD_AUTH');
  });

  it('checks that an account can pay all of its fees', () => {
    const t = new TestLedger();
    const x = Keypair.random();
    t.close([t.tx(t.root, [Operation.createAccount({ destination: x.publicKey(), startingBalance: '1.0000250' })])]);
    const seq = t.seqOf(x.publicKey());
    const bump = (s: bigint) => t.tx(x, [Operation.bumpSequence({ bumpTo: '0' })], { seq: s });
    const lcl = t.lm.lastClosed().hash;
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, [bump(seq + 1n), bump(seq + 2n)]), t.closeTime).valid).toBe(true);
    const three = t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, [bump(seq + 1n), bump(seq + 2n), bump(seq + 3n)]), t.closeTime);
    expect(three.valid).toBe(false);
    expect(three.reason).toContain('txINSUFFICIENT_BALANCE');
  });

  it('limits the number of operations to maxTxSetSize', () => {
    const a = Keypair.random();
    const c = new TestLedger(
      customLedger([newAccountEntry(a.publicKey(), 100n * XLM, 1n, 1)], TEST_PASSPHRASE, (h) => (h.maxTxSetSize = 3)),
    );
    const env = c.tx(a, Array.from({ length: 4 }, () => Operation.bumpSequence({ bumpTo: '0' })));
    const set = c.lm.makeTxSet(c.lm.lastClosed().hash, [env]);
    expect(c.lm.checkTxSetValid(set, c.closeTime).reason).toContain('too many operations');
  });
});

describe('trimInvalid', () => {
  it('keeps valid chains and drops invalid transactions with their successors', () => {
    const t = new TestLedger();
    const a = Keypair.random();
    const b = Keypair.random();
    t.fund([a, b]);
    const sa = t.seqOf(a.publicKey());
    const sb = t.seqOf(b.publicKey());
    const pay = (src: Keypair, s: bigint, opts = {}) =>
      t.tx(src, [Operation.payment({ destination: t.root.publicKey(), asset: native, amount: '1' })], { seq: s, ...opts });
    const a1 = pay(a, sa + 1n);
    const a2 = pay(a, sa + 2n);
    const b1 = pay(b, sb + 1n, { signers: [] });
    const b2 = pay(b, sb + 2n);
    const garbage = 'AAAA';
    const r = t.lm.trimInvalid([a2, garbage, b2, a1, b1, a1], t.closeTime);
    expect(r.valid).toEqual([a2, a1]);
    expect(r.invalid).toEqual([garbage, b2, b1]);
    const set = t.lm.makeTxSet(t.lm.lastClosed().hash, r.valid);
    expect(t.lm.checkTxSetValid(set, t.closeTime + 5).valid).toBe(true);
  });

  it('keeps the affordable prefix of a chain when fees add up', () => {
    const t = new TestLedger();
    const x = Keypair.random();
    t.close([t.tx(t.root, [Operation.createAccount({ destination: x.publicKey(), startingBalance: '1.0000250' })])]);
    const seq = t.seqOf(x.publicKey());
    const envs = [1n, 2n, 3n].map((k) => t.tx(x, [Operation.bumpSequence({ bumpTo: '0' })], { seq: seq + k }));
    const r = t.lm.trimInvalid(envs, t.closeTime);
    expect(r.valid).toEqual(envs.slice(0, 2));
    expect(r.invalid).toEqual(envs.slice(2));
    expect(t.lm.checkValid(envs[2], { seqNumOverride: seq + 2n, pendingFees: 200n }).code).toBe('txINSUFFICIENT_BALANCE');
  });

  it('keeps the higher fee transaction among duplicates of one sequence number', () => {
    const t = new TestLedger();
    const a = Keypair.random();
    t.fund([a]);
    const s = t.seqOf(a.publicKey());
    const low = t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })], { seq: s + 1n, baseFee: 100 });
    const high = t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })], { seq: s + 1n, baseFee: 500 });
    const next = t.tx(a, [Operation.bumpSequence({ bumpTo: '0' })], { seq: s + 2n });
    const r = t.lm.trimInvalid([low, high, next], t.closeTime);
    expect(r.valid).toEqual([high, next]);
    expect(r.invalid).toEqual([low]);
  });

  it('caps the set at maxTxSetSize operations by fee rate', () => {
    const accounts = Array.from({ length: 4 }, () => Keypair.random());
    const lm = customLedger(
      accounts.map((k) => newAccountEntry(k.publicKey(), 100n * XLM, 1n, 1)),
      TEST_PASSPHRASE,
      (h) => (h.maxTxSetSize = 5),
    );
    const t = new TestLedger(lm);
    const bumps = (n: number) => Array.from({ length: n }, () => Operation.bumpSequence({ bumpTo: '0' }));
    const e0 = t.tx(accounts[0], bumps(2), { baseFee: 300 }); // rate 300
    const e1 = t.tx(accounts[1], bumps(3), { baseFee: 200 }); // rate 200
    const e2 = t.tx(accounts[2], bumps(1), { baseFee: 250 }); // rate 250
    const e3 = t.tx(accounts[3], bumps(2), { baseFee: 100 }); // rate 100
    const r = t.lm.trimInvalid([e0, e1, e2, e3], t.closeTime);
    // 2 (e0) + 1 (e2) = 3 ops; e1 (3 ops) does not fit; e3 (2 ops) fits.
    expect(r.valid).toEqual([e0, e2, e3]);
    expect(r.invalid).toEqual([]);
  });
});

describe('queries', () => {
  it('order book: best price first, then lowest offer id, with a limit', () => {
    const seller = Keypair.random().publicKey();
    const issuer = Keypair.random().publicKey();
    const USD = { type: 'credit_alphanum4' as const, code: 'USD', issuer };
    const mk = (id: bigint, n: number, d: number): OfferEntry => ({
      kind: 'offer',
      sellerId: seller,
      offerId: id,
      selling: { type: 'native' },
      buying: USD,
      amount: 10n,
      price: { n, d },
      flags: 0,
      lastModifiedLedgerSeq: 1,
    });
    const offers = [mk(5n, 2, 1), mk(3n, 1, 2), mk(4n, 1, 2), mk(9n, 3, 4), { ...mk(7n, 1, 9), selling: USD, buying: { type: 'native' as const } }];
    const lm = customLedger([newAccountEntry(seller, 100n * XLM, 1n, 1), ...offers]);
    const book = lm.getOrderBook({ type: 'native' }, USD);
    expect(book.map((o) => o.offerId)).toEqual([3n, 4n, 9n, 5n]);
    expect(lm.getOrderBook({ type: 'native' }, USD, 2).map((o) => o.offerId)).toEqual([3n, 4n]);
    expect(lm.getOrderBook(USD, { type: 'native' }).map((o) => o.offerId)).toEqual([7n]);
    expect(lm.getOffersByAccount(seller).map((o) => o.offerId)).toEqual([3n, 4n, 5n, 7n, 9n]);
    // Returned entries are copies.
    book[0].amount = 999n;
    expect(lm.getOrderBook({ type: 'native' }, USD)[0].amount).toBe(10n);
  });

  it('getAccount returns copies', () => {
    const lm = createGenesisLedger(TEST_PASSPHRASE);
    const t = new TestLedger(lm);
    const acc = lm.getAccount(t.root.publicKey())!;
    acc.balance = 1n;
    acc.signers.push({ key: 'x', weight: 1 });
    expect(lm.getAccount(t.root.publicKey())!.balance).not.toBe(1n);
    expect(lm.getAccount(t.root.publicKey())!.signers).toEqual([]);
    expect(lm.getEntry('A:nobody')).toBeUndefined();
  });

  it('closeLedger after checkValid errors still works (no leaked transaction)', () => {
    const t = new TestLedger();
    t.lm.checkValid('garbage');
    t.lm.trimInvalid(['garbage'], 0);
    expect(t.close([]).header.ledgerSeq).toBe(2);
  });
});

describe('large states', () => {
  it('loads a 60,000 entry snapshot and keeps closing ledgers', () => {
    // The state hash used to throw RangeError above about 41,000 entries, so
    // every node failed to close the next ledger and to load snapshots.
    const entries = genesisEntries(TEST_PASSPHRASE, { unlockRoot: true }) as LedgerEntry[];
    for (let i = 0; i < 60_000; i++) {
      entries.push(newAccountEntry(StrKey.encodeEd25519PublicKey(sha256(`large-state|${i}`)), 10n * XLM, 0n, 1));
    }
    const t = new TestLedger(customLedger(entries));
    const dest = Keypair.random();
    const r = t.close([t.tx(t.root, [Operation.createAccount({ destination: dest.publicKey(), startingBalance: '5' })])]);
    expect(r.results[0].resultCode).toBe('txSUCCESS');
    expect(t.lm.entryCount()).toBe(60_018);
    const copy = loadLedgerFromSnapshot(t.lm.snapshot());
    expect(copy.lastClosed().hash).toBe(r.hash);
    expect(copy.stateHash()).toBe(r.header.bucketListHash);
  });
});
