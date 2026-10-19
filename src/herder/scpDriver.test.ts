import { Asset, Keypair, Operation } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, toHex, ZERO_HASH } from '../lib/bytes';
import { VirtualClock } from '../lib/clock';
import { sha256 } from '../lib/hash';
import { LogSink, Logger } from '../lib/log';
import { TestLedger, XLM } from '../ledger/testkit';
import type { TxSetInfo } from '../ledger/types';
import { encodeStellarValue, makeSignedStellarValue } from '../ledger/value';
import { TIMER_BALLOT, TIMER_NOMINATION, ValidationLevel } from '../scp/types';
import type { CachedTxSet } from './pendingEnvelopes';
import { HerderSCPDriver, computeScpTimeout } from './scpDriver';
import { txSetStats } from './values';

function setup() {
  const tl = new TestLedger();
  const alice = Keypair.random();
  const bob = Keypair.random();
  tl.fund([alice, bob], 1000n * XLM);
  const lcl = tl.lm.lastClosed();
  const clock = new VirtualClock((lcl.header.scpValue.closeTime + 10) * 1000);
  const sink = new LogSink(clock, 'error');
  const txSets = new Map<string, CachedTxSet>();
  const node = Keypair.random();
  const externalized: [number, string][] = [];
  const progress: string[] = [];
  const driver = new HerderSCPDriver({
    keypair: node,
    networkId: tl.lm.networkId,
    clock,
    logger: new Logger(sink, 'test'),
    ledger: () => tl.lm,
    getQSet: () => null,
    getTxSet: (h) => txSets.get(h),
    emitEnvelope: () => undefined,
    valueExternalized: (s, v) => externalized.push([s, v]),
    progress: (s, w) => progress.push(`${s}:${w}`),
    nodeName: () => 'n',
  });
  const cache = (info: TxSetInfo) => txSets.set(info.hash, { info, slot: 0, stats: txSetStats(info, tl.lm.networkId) });
  const txSet = (envs: string[], prev = tl.lm.lastClosed().hash) => {
    const t = tl.lm.makeTxSet(prev, envs);
    cache(t);
    return t;
  };
  const value = (txSetHash: string, closeTime: number, signer: Keypair = node) =>
    encodeStellarValue(makeSignedStellarValue(tl.lm.networkId, signer, txSetHash, closeTime));
  const pay = (from: Keypair, o: { seqOffset?: bigint; baseFee?: number; amount?: string } = {}) =>
    tl.tx(from, [Operation.payment({ destination: bob.publicKey(), asset: Asset.native(), amount: o.amount ?? '1' })], o);
  const slot = lcl.header.ledgerSeq + 1;
  const lclClose = lcl.header.scpValue.closeTime;
  return { tl, clock, driver, txSet, value, pay, slot, lclClose, alice, bob, node, externalized, progress };
}

describe('HerderSCPDriver.validateValue', () => {
  it('fully validates a signed value for LCL+1 with a cached, valid tx set', () => {
    const { driver, txSet, value, slot, lclClose, pay, alice } = setup();
    const v = value(txSet([pay(alice)]).hash, lclClose + 5);
    expect(driver.validateValue(slot, v, true)).toBe(ValidationLevel.FullyValidated);
    expect(driver.validateValue(slot, v, false)).toBe(ValidationLevel.FullyValidated);
    expect(driver.extractValidValue(slot, v)).toBe(v);
  });

  it('rejects malformed, unsigned, badly signed values and upgrades', () => {
    const { driver, txSet, value, slot, lclClose, tl, node } = setup();
    const ts = txSet([]);
    expect(driver.validateValue(slot, 'zz', true)).toBe(ValidationLevel.Invalid);
    expect(driver.validateValue(slot, 'deadbeef', true)).toBe(ValidationLevel.Invalid);
    const unsigned = encodeStellarValue({ txSetHash: ts.hash, closeTime: lclClose + 1, upgrades: [], signature: null });
    expect(driver.validateValue(slot, unsigned, true)).toBe(ValidationLevel.Invalid);
    const sig = makeSignedStellarValue(tl.lm.networkId, node, ts.hash, lclClose + 1).signature;
    const forged = encodeStellarValue({ txSetHash: ts.hash, closeTime: lclClose + 2, upgrades: [], signature: sig });
    expect(driver.validateValue(slot, forged, true)).toBe(ValidationLevel.Invalid);
    const withUpgrade = encodeStellarValue({ txSetHash: ts.hash, closeTime: lclClose + 1, upgrades: ['00000001'], signature: sig });
    expect(driver.validateValue(slot, withUpgrade, true)).toBe(ValidationLevel.Invalid);
    expect(driver.validateValue(slot, value(ts.hash, lclClose + 1), true)).toBe(ValidationLevel.FullyValidated);
    expect(driver.extractValidValue(slot, unsigned)).toBeNull();
  });

  it('checks the close time: after the LCL, and not too far ahead when nominating', () => {
    const { driver, txSet, value, slot, lclClose, clock } = setup();
    const ts = txSet([]);
    expect(driver.validateValue(slot, value(ts.hash, lclClose), true)).toBe(ValidationLevel.Invalid);
    const ahead = Math.floor(clock.now() / 1000) + 61;
    expect(driver.validateValue(slot, value(ts.hash, ahead), true)).toBe(ValidationLevel.Invalid);
    expect(driver.validateValue(slot, value(ts.hash, ahead), false)).toBe(ValidationLevel.FullyValidated);
    expect(driver.validateValue(slot, value(ts.hash, ahead - 1), true)).toBe(ValidationLevel.FullyValidated);
  });

  it('gives MaybeValid for other slots (Invalid for a future value closing before the LCL)', () => {
    const { driver, txSet, value, slot, lclClose } = setup();
    const ts = txSet([]);
    expect(driver.validateValue(slot + 3, value(ts.hash, lclClose + 30), false)).toBe(ValidationLevel.MaybeValid);
    expect(driver.validateValue(slot + 3, value(ts.hash, lclClose), false)).toBe(ValidationLevel.Invalid);
    expect(driver.validateValue(slot - 1, value(ts.hash, lclClose - 100), false)).toBe(ValidationLevel.MaybeValid);
  });

  it('needs the tx set, built on our LCL, with valid transactions', () => {
    const { driver, txSet, value, slot, lclClose, tl, pay, alice } = setup();
    const unknown = tl.lm.makeTxSet(tl.lm.lastClosed().hash, [pay(alice)]);
    expect(driver.validateValue(slot, value(unknown.hash, lclClose + 1), true)).toBe(ValidationLevel.Invalid);
    const otherPrev = txSet([], ZERO_HASH);
    expect(driver.validateValue(slot, value(otherPrev.hash, lclClose + 1), true)).toBe(ValidationLevel.Invalid);
    const badSeq = txSet([pay(alice, { seqOffset: 4n })]);
    expect(driver.validateValue(slot, value(badSeq.hash, lclClose + 1), true)).toBe(ValidationLevel.Invalid);
  });
});

describe('HerderSCPDriver.combineCandidates', () => {
  it('prefers the tx set with the most operations, then the highest fees', () => {
    const { driver, txSet, value, slot, lclClose, pay, alice, bob } = setup();
    const one = value(txSet([pay(alice)]).hash, lclClose + 1);
    const two = value(txSet([pay(alice), pay(bob)]).hash, lclClose + 2);
    const none = value(txSet([]).hash, lclClose + 3);
    const sorted = [one, two, none].sort();
    expect(driver.combineCandidates(slot, sorted)).toBe(two);
    const cheap = value(txSet([pay(alice, { amount: '2' })]).hash, lclClose + 4);
    const rich = value(txSet([pay(alice, { baseFee: 500 })]).hash, lclClose + 5);
    expect(driver.combineCandidates(slot, [cheap, rich].sort())).toBe(rich);
    expect(driver.combineCandidates(slot, [])).toBeNull();
  });

  it('breaks ties by sha256(txSetHash || sha256(all candidates)) and returns the value unchanged', () => {
    const { driver, txSet, value, slot, lclClose, pay, alice, bob } = setup();
    const t1 = txSet([pay(alice, { amount: '3' })]);
    const t2 = txSet([pay(bob, { amount: '4' })]);
    const v1 = value(t1.hash, lclClose + 1, Keypair.random());
    const v2 = value(t2.hash, lclClose + 1, Keypair.random());
    const sorted = [v1, v2].sort();
    const all = sha256(concatBytes(...sorted.map((v) => fromHex(v))));
    const key = (h: string) => toHex(sha256(concatBytes(fromHex(h), all)));
    const expected = key(t1.hash) < key(t2.hash) ? v1 : v2;
    expect(driver.combineCandidates(slot, sorted)).toBe(expected);
    // the same tx set with two close times: the smaller value wins
    const a = value(t1.hash, lclClose + 7);
    const b = value(t1.hash, lclClose + 8);
    expect(driver.combineCandidates(slot, [a, b].sort())).toBe([a, b].sort()[0]);
  });
});

describe('HerderSCPDriver timers and timeouts', () => {
  it('computes 1 s per round, capped at 30 s', () => {
    const { driver } = setup();
    expect(driver.computeTimeout(1, true)).toBe(1000);
    expect(driver.computeTimeout(7, false)).toBe(7000);
    expect(driver.computeTimeout(100, true)).toBe(30_000);
    expect(computeScpTimeout(0)).toBe(1000);
  });

  it('runs, replaces and cancels timers through the clock', async () => {
    const { driver, clock, slot } = setup();
    const fired: string[] = [];
    driver.setupTimer(slot, TIMER_NOMINATION, 1000, () => fired.push('n1'));
    driver.setupTimer(slot, TIMER_NOMINATION, 500, () => fired.push('n2'));
    driver.setupTimer(slot, TIMER_BALLOT, 200, () => fired.push('b'));
    expect(driver.timerCount()).toBe(2);
    driver.stopTimer(slot, TIMER_BALLOT);
    await clock.advance(2000);
    expect(fired).toEqual(['n2']);
    driver.setupTimer(slot, TIMER_BALLOT, 100, () => fired.push('b2'));
    driver.setupTimer(slot, TIMER_BALLOT, 0, null);
    driver.setupTimer(slot + 1, TIMER_BALLOT, 100, () => {
      throw new Error('boom');
    });
    await clock.advance(500);
    expect(fired).toEqual(['n2']);
  });

  it('ignores timers for closed slots and cancels by slot', async () => {
    const { driver, clock, slot } = setup();
    const fired: number[] = [];
    driver.setupTimer(slot - 1, TIMER_BALLOT, 10, () => fired.push(slot - 1));
    driver.setupTimer(slot, TIMER_BALLOT, 10, () => fired.push(slot));
    driver.setupTimer(slot + 1, TIMER_BALLOT, 10, () => fired.push(slot + 1));
    driver.cancelTimersUpTo(slot);
    await clock.advance(100);
    expect(fired).toEqual([slot + 1]);
    driver.setupTimer(slot, TIMER_NOMINATION, 10, () => fired.push(0));
    driver.cancelAllTimers();
    await clock.advance(100);
    expect(fired).toEqual([slot + 1]);
  });

  it('reports progress and externalization to the herder', () => {
    const { driver, externalized, progress, slot } = setup();
    driver.startedBallotProtocol(slot, { counter: 1, value: 'aa' });
    driver.acceptedCommit(slot, { counter: 1, value: 'aa' });
    driver.valueExternalized(slot, 'aa');
    expect(progress).toEqual([`${slot}:ballot`, `${slot}:accepted-commit`]);
    expect(externalized).toEqual([[slot, 'aa']]);
  });
});
