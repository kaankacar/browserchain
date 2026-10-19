import { Asset, Keypair, Operation } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { TestLedger, XLM } from '../ledger/testkit';
import { MAX_PEER_TXS_PER_CHANNEL, MAX_TXS_PER_ACCOUNT, TxQueue } from './txQueue';

function setup(opts: { maxPerAccount?: number; maxTotal?: number; maxAgeLedgers?: number } = {}) {
  const tl = new TestLedger();
  const alice = Keypair.random();
  const bob = Keypair.random();
  tl.fund([alice, bob], 1000n * XLM);
  let now = 1_000;
  const q = new TxQueue({ ledger: () => tl.lm, now: () => now, ...opts });
  const pay = (from: Keypair, o: { seq?: bigint; seqOffset?: bigint; baseFee?: number; amount?: string } = {}) =>
    tl.tx(from, [Operation.payment({ destination: bob.publicKey(), asset: Asset.native(), amount: o.amount ?? '1' })], o);
  return { tl, q, alice, bob, pay, tick: (ms: number) => (now += ms) };
}

describe('TxQueue admission', () => {
  it('admits a valid transaction and reports duplicates', () => {
    const { tl, q, alice, pay } = setup();
    const env = pay(alice);
    const r = q.tryAdd(env, { fromSelf: true });
    expect(r.status).toBe('PENDING');
    expect(r.hash).toBe(tl.lm.checkValid(env).hash);
    expect(q.size()).toBe(1);
    const queued = q.get(r.hash)!;
    expect(queued.sourceAccount).toBe(alice.publicKey());
    expect(queued.seqNum).toBe(tl.seqOf(alice.publicKey()) + 1n);
    expect(queued.fee).toBe(100n);
    expect(queued.fromSelf).toBe(true);
    expect(q.tryAdd(env).status).toBe('DUPLICATE');
  });

  it('rejects undecodable envelopes and invalid transactions with the result code', () => {
    const { q, alice, pay } = setup();
    expect(q.tryAdd('not-xdr', { fromSelf: true })).toMatchObject({ status: 'ERROR', hash: '', code: 'txMALFORMED' });
    const r = q.tryAdd(pay(alice, { seqOffset: 1n }), { fromSelf: true });
    expect(r).toMatchObject({ status: 'ERROR', code: 'txBAD_SEQ' });
    expect(q.size()).toBe(0);
  });

  it('chains transactions of one account and rejects gaps', () => {
    const { tl, q, alice, pay } = setup();
    const seq = tl.seqOf(alice.publicKey());
    for (let i = 1n; i <= 3n; i++) expect(q.tryAdd(pay(alice, { seq: seq + i })).status).toBe('PENDING');
    expect(q.pendingFor(alice.publicKey()).map((t) => t.seqNum)).toEqual([seq + 1n, seq + 2n, seq + 3n]);
    expect(q.nextSeqNum(alice.publicKey(), seq)).toBe(seq + 4n);
    expect(q.tryAdd(pay(alice, { seq: seq + 5n }))).toMatchObject({ status: 'ERROR', code: 'txBAD_SEQ' });
  });

  it('limits queued transactions per account and in total', () => {
    const { tl, q, alice, bob, pay } = setup({ maxPerAccount: 2, maxTotal: 3 });
    const seq = tl.seqOf(alice.publicKey());
    expect(q.tryAdd(pay(alice, { seq: seq + 1n })).status).toBe('PENDING');
    expect(q.tryAdd(pay(alice, { seq: seq + 2n })).status).toBe('PENDING');
    expect(q.tryAdd(pay(alice, { seq: seq + 3n })).status).toBe('TRY_AGAIN_LATER');
    expect(q.tryAdd(pay(bob)).status).toBe('PENDING');
    expect(q.tryAdd(pay(bob, { seqOffset: 1n })).status).toBe('TRY_AGAIN_LATER');
    expect(q.size()).toBe(3);
  });

  it('replaces a queued transaction only for 10x the fee rate', () => {
    const { tl, q, alice, pay } = setup();
    const seq = tl.seqOf(alice.publicKey());
    const first = q.tryAdd(pay(alice, { seq: seq + 1n }));
    expect(first.status).toBe('PENDING');
    expect(q.tryAdd(pay(alice, { seq: seq + 1n, baseFee: 900, amount: '2' })).status).toBe('TRY_AGAIN_LATER');
    const better = q.tryAdd(pay(alice, { seq: seq + 1n, baseFee: 1000, amount: '3' }));
    expect(better.status).toBe('PENDING');
    expect(better.replaced?.hash).toBe(first.hash);
    expect(q.has(first.hash)).toBe(false);
    expect(q.size()).toBe(1);
  });

  it('counts the fees of queued transactions against the balance', () => {
    const tl = new TestLedger();
    const poor = Keypair.random();
    // min balance is 1 XLM; 0.5 XLM is spendable
    tl.fund([poor], 15_000_000n);
    const q = new TxQueue({ ledger: () => tl.lm, now: () => 0 });
    const seq = tl.seqOf(poor.publicKey());
    const tx = (s: bigint) =>
      tl.tx(poor, [Operation.bumpSequence({ bumpTo: '0' })], { seq: s, baseFee: 3_000_000 });
    expect(q.tryAdd(tx(seq + 1n)).status).toBe('PENDING');
    expect(q.tryAdd(tx(seq + 2n))).toMatchObject({ status: 'ERROR', code: 'txINSUFFICIENT_BALANCE' });
  });

  it('bans failed peer transactions for a few ledgers, but re-checks local submissions', () => {
    const { q, alice, pay } = setup();
    const bad = pay(alice, { seqOffset: 3n });
    expect(q.tryAdd(bad).status).toBe('ERROR');
    const again = q.tryAdd(bad);
    expect(again.status).toBe('TRY_AGAIN_LATER');
    expect(again.detail).toMatch(/recently rejected/);
    expect(q.tryAdd(bad, { fromSelf: true })).toMatchObject({ status: 'ERROR', code: 'txBAD_SEQ' });
  });

  it(`keeps room for local friendbot transactions: peer-relayed ones hold at most ${MAX_PEER_TXS_PER_CHANNEL} of a channel's slots`, () => {
    const { tl, q, alice, bob, pay } = setup();
    const channel = tl.channels[3];
    const seq = tl.seqOf(channel.publicKey());
    // the channel keys are public: anyone can sign valid channel payments
    const fromChannel = (i: bigint) =>
      tl.tx(channel, [Operation.payment({ destination: bob.publicKey(), asset: Asset.native(), amount: '10000' })], { seq: seq + i });
    for (let i = 1n; i <= BigInt(MAX_PEER_TXS_PER_CHANNEL); i++) expect(q.tryAdd(fromChannel(i)).status).toBe('PENDING');
    const next = BigInt(MAX_PEER_TXS_PER_CHANNEL) + 1n;
    const refused = q.tryAdd(fromChannel(next));
    expect(refused.status).toBe('TRY_AGAIN_LATER');
    expect(refused.detail).toMatch(/friendbot channel/);
    // not banned: it may come again once the channel's queue drains
    expect(q.isBanned(refused.hash)).toBe(false);
    // this node's own friendbot txs use the rest of the channel's 16 slots
    for (let i = next; i <= BigInt(MAX_TXS_PER_ACCOUNT); i++) expect(q.tryAdd(fromChannel(i), { fromSelf: true }).status, `seq +${i}`).toBe('PENDING');
    expect(q.tryAdd(fromChannel(BigInt(MAX_TXS_PER_ACCOUNT) + 1n), { fromSelf: true }).status).toBe('TRY_AGAIN_LATER');
    expect(q.countFor(channel.publicKey())).toBe(MAX_TXS_PER_ACCOUNT);
    // other accounts keep all 16 slots for peer-relayed txs
    const aseq = tl.seqOf(alice.publicKey());
    for (let i = 1n; i <= BigInt(MAX_TXS_PER_ACCOUNT); i++) expect(q.tryAdd(pay(alice, { seq: aseq + i })).status).toBe('PENDING');
    // after the peer txs are applied, peers may queue up to the cap again
    const other = tl.channels[4];
    const oseq = tl.seqOf(other.publicKey());
    const otherTx = (i: bigint) =>
      tl.tx(other, [Operation.payment({ destination: bob.publicKey(), asset: Asset.native(), amount: '10000' })], { seq: oseq + i });
    const firstFour = [1n, 2n, 3n, 4n].map(otherTx);
    for (const env of firstFour) expect(q.tryAdd(env).status).toBe('PENDING');
    expect(q.tryAdd(otherTx(5n)).status).toBe('TRY_AGAIN_LATER');
    q.onLedgerClosed(tl.close(firstFour.slice(0, 2)));
    expect(q.tryAdd(otherTx(5n)).status).toBe('PENDING');
  });

  it('keeps that room only on the channels this node makes its own requests on', () => {
    // Review case: the cap on every channel made every other node refuse the
    // 5th and later request a node queued on one of its own channels.
    const tl = new TestLedger();
    const bob = Keypair.random();
    tl.fund([bob], 1000n * XLM);
    const [mine, theirs] = [tl.channels[3], tl.channels[4]];
    const q = new TxQueue({ ledger: () => tl.lm, now: () => 0, ownChannels: () => new Set([mine.publicKey()]) });
    const txs = (ch: Keypair) => {
      const seq = tl.seqOf(ch.publicKey());
      return (i: bigint) =>
        tl.tx(ch, [Operation.payment({ destination: bob.publicKey(), asset: Asset.native(), amount: '10000' })], { seq: seq + i });
    };
    const onTheirs = txs(theirs);
    for (let i = 1n; i <= BigInt(MAX_TXS_PER_ACCOUNT); i++) expect(q.tryAdd(onTheirs(i)).status, `theirs +${i}`).toBe('PENDING');
    const onMine = txs(mine);
    for (let i = 1n; i <= BigInt(MAX_PEER_TXS_PER_CHANNEL); i++) expect(q.tryAdd(onMine(i)).status).toBe('PENDING');
    expect(q.tryAdd(onMine(BigInt(MAX_PEER_TXS_PER_CHANNEL) + 1n)).status).toBe('TRY_AGAIN_LATER');
    expect(q.tryAdd(onMine(BigInt(MAX_PEER_TXS_PER_CHANNEL) + 1n), { fromSelf: true }).status).toBe('PENDING');
  });
});

describe('TxQueue after a ledger close', () => {
  it('removes applied transactions and keeps the rest of the chain', () => {
    const { tl, q, alice, pay } = setup();
    const seq = tl.seqOf(alice.publicKey());
    const a = pay(alice, { seq: seq + 1n });
    const b = pay(alice, { seq: seq + 2n });
    const ra = q.tryAdd(a);
    const rb = q.tryAdd(b);
    const res = q.onLedgerClosed(tl.close([a]));
    expect(res.applied.map((t) => t.hash)).toEqual([ra.hash]);
    expect(res.dropped).toEqual([]);
    expect(q.has(rb.hash)).toBe(true);
    expect(q.wasApplied(ra.hash)).toBe(true);
    // resubmitting an applied tx is a duplicate
    expect(q.tryAdd(a, { fromSelf: true }).status).toBe('DUPLICATE');
  });

  it('drops transactions made invalid by another transaction, keeps valid followers', () => {
    const { tl, q, alice, pay } = setup();
    const seq = tl.seqOf(alice.publicKey());
    const mine = q.tryAdd(pay(alice, { seq: seq + 1n }));
    const next = q.tryAdd(pay(alice, { seq: seq + 2n }));
    // a competing tx with the same sequence number gets applied elsewhere
    const res = q.onLedgerClosed(tl.close([pay(alice, { seq: seq + 1n, amount: '7' })]));
    expect(res.applied).toEqual([]);
    expect(res.dropped.map((d) => [d.tx.hash, d.code])).toEqual([[mine.hash, 'txBAD_SEQ']]);
    expect(q.has(next.hash)).toBe(true);
  });

  it('ages out transactions after maxAgeLedgers', () => {
    const { tl, q, alice, pay } = setup({ maxAgeLedgers: 2 });
    const seq = tl.seqOf(alice.publicKey());
    const r = q.tryAdd(pay(alice, { seq: seq + 1n }));
    expect(q.onLedgerClosed(tl.close([])).dropped).toEqual([]);
    const res = q.onLedgerClosed(tl.close([]));
    expect(res.dropped.map((d) => [d.tx.hash, d.code])).toEqual([[r.hash, 'txTOO_LATE']]);
    expect(q.size()).toBe(0);
  });

  it('dropEnvelopes removes and bans listed envelopes', () => {
    const { q, alice, bob, pay } = setup();
    const a = pay(alice);
    const b = pay(bob);
    q.tryAdd(a);
    const rb = q.tryAdd(b);
    const dropped = q.dropEnvelopes([b], 'txINVALID');
    expect(dropped.map((d) => d.tx.hash)).toEqual([rb.hash]);
    expect(q.isBanned(rb.hash)).toBe(true);
    expect(q.envelopes()).toEqual([a]);
  });

  it('revalidate and clear', () => {
    const { tl, q, alice, pay } = setup();
    const r = q.tryAdd(pay(alice));
    // the account's sequence moves without the queue noticing (e.g. ledger reset)
    tl.close([pay(alice, { amount: '5' })]);
    expect(q.revalidate().map((d) => d.tx.hash)).toEqual([r.hash]);
    q.tryAdd(pay(alice));
    q.clear();
    expect(q.size()).toBe(0);
    expect(q.all()).toEqual([]);
  });
});
