// Network rules on top of stellar-core: the locked root account, the friendbot
// channel policy, and the caps on DEX operations and friendbot channel
// transactions per tx set.

import { Account, Asset, Claimant, Keypair, Memo, MuxedAccount, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { fromBase64 } from '../lib/bytes';
import {
  APP_VERSION,
  FRIENDBOT_AMOUNT,
  FRIENDBOT_CHANNEL_BALANCE,
  FRIENDBOT_CHANNELS,
  LEDGER_TARGET_CLOSE_MS,
  MAX_DEX_OPS_IN_TX_SET,
  MAX_FRIENDBOT_TXS_IN_TX_SET,
  networkPassphrase,
} from '../lib/constants';
import { sha256, sha256Hex } from '../lib/hash';
import { CHANNEL_POLICY_DETAIL } from './channelPolicy';
import { isDexOperation } from './dex';
import { createGenesisLedger } from './manager';
import { INT64_MAX } from './math';
import { TestLedger, XLM, stroopsToString } from './testkit';
import { decodeTransaction } from './tx';

const PASS = networkPassphrase('policy-test');
/** FRIENDBOT_AMOUNT as an SDK amount string. */
const FB = stroopsToString(FRIENDBOT_AMOUNT);
const native = Asset.native();

/** A ledger at the production genesis (root locked) of PASS. */
function production(): TestLedger {
  return new TestLedger(createGenesisLedger(PASS), PASS);
}

describe('the root account is locked at genesis', () => {
  it('has master weight 0 and no signers, so nothing signed with its public key is authorized', () => {
    const t = production();
    const rootId = t.root.publicKey();
    const root = t.lm.getAccount(rootId)!;
    expect(root.thresholds).toEqual({ master: 0, low: 0, med: 0, high: 0 });
    expect(root.signers).toEqual([]);
    const thief = Keypair.random();
    const attempts: xdr.Operation[][] = [
      [Operation.accountMerge({ destination: thief.publicKey() })],
      [Operation.createAccount({ destination: thief.publicKey(), startingBalance: '1000000' })],
      [Operation.setOptions({ signer: { ed25519PublicKey: thief.publicKey(), weight: 1 } })],
      [Operation.setOptions({ masterWeight: 0 })],
      [Operation.bumpSequence({ bumpTo: '0' })],
    ];
    for (const ops of attempts) {
      expect(t.lm.checkValid(t.tx(t.root, ops)), ops[0].body.type).toMatchObject({ ok: false, code: 'txBAD_AUTH' });
    }
    // Forced into a ledger anyway, a merge still does nothing: the fee is all it costs.
    const r = t.close([t.tx(t.root, [Operation.accountMerge({ destination: thief.publicKey() })])]);
    expect(r.results[0].resultCode).toBe('txBAD_AUTH');
    expect(t.lm.getAccount(thief.publicKey())).toBeUndefined();
    expect(t.balanceOf(rootId)).toBe(root.balance - 100n);
  });

  it('an operation sourced from the root fails with opBAD_AUTH', () => {
    const t = production();
    const user = Keypair.random();
    t.fund([user]);
    const env = t.tx(user, [Operation.payment({ source: t.root.publicKey(), destination: user.publicKey(), asset: native, amount: '5' })], {
      signers: [user, t.root],
    });
    const v = t.lm.checkValid(env);
    expect(v).toMatchObject({ ok: false, code: 'txFAILED' });
    expect(v.detail).toContain('opBAD_AUTH');
  });

  it('the testkit funds through the channels when the root is locked', () => {
    const t = production();
    expect(t.rootCanSign()).toBe(false);
    const [a, b, c] = [Keypair.random(), Keypair.random(), Keypair.random()];
    const r = t.fund([a, b], 15_000n * XLM);
    // Two channel transactions per account (a create and a payment), one ledger.
    expect(r.results.map((x) => x.operations[0].type).sort()).toEqual(['createAccount', 'createAccount', 'payment', 'payment']);
    expect(t.balanceOf(a.publicKey())).toBe(2n * FRIENDBOT_AMOUNT);
    expect(t.balanceOf(b.publicKey())).toBe(2n * FRIENDBOT_AMOUNT);
    t.fund([c]);
    expect(t.balanceOf(c.publicKey())).toBe(FRIENDBOT_AMOUNT);
    expect(new TestLedger().rootCanSign()).toBe(true);
  });

  it('the unlockRoot test option keeps the master key; the lock is part of the genesis state', () => {
    const locked = createGenesisLedger(PASS);
    const open = createGenesisLedger(PASS, { unlockRoot: true });
    expect(open.lastClosed().hash).not.toBe(locked.lastClosed().hash);
    const t = new TestLedger(open, PASS);
    expect(t.lm.getAccount(t.root.publicKey())!.thresholds.master).toBe(1);
    const dest = Keypair.random();
    t.fund([dest], 123n * XLM);
    expect(t.balanceOf(dest.publicKey())).toBe(123n * XLM);
  });
});

describe('friendbot channel policy', () => {
  it('allows one CreateAccount or native Payment of FRIENDBOT_AMOUNT sourced from the channel', () => {
    const t = production();
    const [c0, c1] = t.channels;
    const a = Keypair.random();
    const b = Keypair.random();
    const create = t.tx(c0, [Operation.createAccount({ destination: a.publicKey(), startingBalance: FB })]);
    expect(t.lm.checkValid(create)).toMatchObject({ ok: true });
    expect(t.apply(create).resultCode).toBe('txSUCCESS');
    // Destinations are not restricted: an account, a muxed account, the root, another channel.
    const muxedA = new MuxedAccount(new Account(a.publicKey(), '0'), '9').accountId();
    for (const destination of [a.publicKey(), muxedA, t.root.publicKey(), c1.publicKey()]) {
      const pay = t.tx(c0, [Operation.payment({ destination, asset: native, amount: FB })]);
      expect(t.lm.checkValid(pay), destination).toMatchObject({ ok: true });
      expect(t.apply(pay).resultCode, destination).toBe('txSUCCESS');
    }
    expect(t.balanceOf(a.publicKey())).toBe(3n * FRIENDBOT_AMOUNT);
    // A user may pay the fee for the channel's operation.
    const op = Operation.createAccount({ source: c1.publicKey(), destination: b.publicKey(), startingBalance: FB });
    const sponsored = t.tx(a, [op], { signers: [a, c1] });
    expect(t.lm.checkValid(sponsored)).toMatchObject({ ok: true });
    expect(t.apply(sponsored).resultCode).toBe('txSUCCESS');
    expect(t.balanceOf(b.publicKey())).toBe(FRIENDBOT_AMOUNT);
  });

  it('rejects anything else that involves a channel with txNOT_SUPPORTED', () => {
    const t = production();
    const [c0, c1] = t.channels;
    const user = Keypair.random();
    const other = Keypair.random();
    t.fund([user]);
    const issuer = Keypair.random();
    const usd = new Asset('USD', issuer.publicKey());
    const dest = other.publicKey();
    const create = (amount: string, source?: string) => Operation.createAccount({ source, destination: dest, startingBalance: amount });
    const cases: [string, string][] = [
      ['create of another amount', t.tx(c0, [create('9999.9999999')])],
      ['payment of another amount', t.tx(c0, [Operation.payment({ destination: user.publicKey(), asset: native, amount: '10000.0000001' })])],
      ['credit payment', t.tx(c0, [Operation.payment({ destination: user.publicKey(), asset: usd, amount: FB })])],
      ['two operations', t.tx(c0, [create(FB), Operation.payment({ destination: user.publicKey(), asset: native, amount: FB })])],
      ['lock the channel', t.tx(c0, [Operation.setOptions({ masterWeight: 0 })])],
      ['add a signer', t.tx(c0, [Operation.setOptions({ signer: { ed25519PublicKey: dest, weight: 1 } })])],
      ['merge', t.tx(c0, [Operation.accountMerge({ destination: user.publicKey() })])],
      ['data', t.tx(c0, [Operation.manageData({ name: 'x', value: 'y' })])],
      ['bump sequence', t.tx(c0, [Operation.bumpSequence({ bumpTo: '0' })])],
      ['trust line', t.tx(c0, [Operation.changeTrust({ asset: usd })])],
      ['offer', t.tx(c0, [Operation.manageSellOffer({ selling: native, buying: usd, amount: FB, price: { n: 1, d: 1 } })])],
      [
        'path payment',
        t.tx(c0, [Operation.pathPaymentStrictSend({ sendAsset: native, sendAmount: FB, destination: dest, destAsset: native, destMin: FB, path: [] })]),
      ],
      [
        'claimable balance',
        t.tx(c0, [Operation.createClaimableBalance({ asset: native, amount: FB, claimants: [new Claimant(dest, Claimant.predicateUnconditional())] })]),
      ],
      ['operation sourced from another channel', t.tx(c0, [create(FB, c1.publicKey())], { signers: [c0, c1] })],
      ['operation sourced from a user', t.tx(c0, [create(FB, user.publicKey())], { signers: [c0, user] })],
      ['user tx, channel operation of another amount', t.tx(user, [create('1', c0.publicKey())], { signers: [user, c0] })],
      [
        'user tx, channel operation plus a user operation',
        t.tx(user, [create(FB, c0.publicKey()), Operation.bumpSequence({ bumpTo: '0' })], { signers: [user, c0] }),
      ],
      ['muxed channel source', t.tx(c0, [Operation.setOptions({ masterWeight: 0 })], { muxedId: '7' })],
    ];
    for (const [name, env] of cases) {
      expect(t.lm.checkValid(env), name).toMatchObject({ ok: false, code: 'txNOT_SUPPORTED', detail: CHANNEL_POLICY_DETAIL });
    }

    // Also when applied (a tx set that bypassed validation): no effect, the
    // sequence number is not used, only the fee is charged.
    const before = t.lm.getAccount(c0.publicKey())!;
    const r = t.close([cases[4][1]]);
    expect(r.results[0].resultCode).toBe('txNOT_SUPPORTED');
    const after = t.lm.getAccount(c0.publicKey())!;
    expect(after.thresholds.master).toBe(1);
    expect(after.seqNum).toBe(before.seqNum);
    expect(after.balance).toBe(before.balance - 100n);
  });

  it('rejects minSeqNum on a channel transaction: it could set the sequence number to INT64_MAX', () => {
    const t = production();
    const [c0] = t.channels;
    const user = Keypair.random();
    t.fund([user]);
    const cur = t.seqOf(c0.publicKey());
    // A compliant operation, from `source` with sequence number `seq` and minSeqNum `minSeq`.
    const relaxed = (source: Keypair, seq: bigint, minSeq: bigint, signers: Keypair[], opSource?: string) => {
      const b = new TransactionBuilder(new Account(source.publicKey(), (seq - 1n).toString()), {
        fee: '100',
        networkPassphrase: PASS,
        timebounds: { minTime: 0, maxTime: 0 },
        minAccountSequence: minSeq.toString(),
      });
      b.addOperation(Operation.createAccount({ source: opSource, destination: Keypair.random().publicKey(), startingBalance: FB }));
      const tx = b.build();
      for (const kp of signers) tx.sign(kp);
      return tx.toEnvelope().toXdr('base64');
    };
    // Before the rule, this passed and left the channel at INT64_MAX: every later tx got txBAD_SEQ.
    const toMax = relaxed(c0, INT64_MAX, cur, [c0]);
    expect(t.lm.checkValid(toMax)).toMatchObject({ ok: false, code: 'txNOT_SUPPORTED', detail: CHANNEL_POLICY_DETAIL });
    // The rule is static, so the harmless form (the next sequence number) is refused too.
    expect(t.lm.checkValid(relaxed(c0, cur + 1n, 0n, [c0]))).toMatchObject({ ok: false, code: 'txNOT_SUPPORTED' });
    const lcl = t.lm.lastClosed().hash;
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, [toMax]), t.closeTime + 5).reason).toContain('txNOT_SUPPORTED');
    // Forced into a ledger: no effect, and the channel keeps funding.
    expect(t.apply(toMax).resultCode).toBe('txNOT_SUPPORTED');
    expect(t.seqOf(c0.publicKey())).toBe(cur);
    const next = t.tx(c0, [Operation.createAccount({ destination: Keypair.random().publicKey(), startingBalance: FB })]);
    expect(t.lm.checkValid(next)).toMatchObject({ ok: true });
    expect(t.apply(next).resultCode).toBe('txSUCCESS');
    // A user's own minSeqNum moves only the user's sequence number: allowed.
    const userSeq = t.seqOf(user.publicKey());
    const userTx = relaxed(user, userSeq + 3n, userSeq, [user, c0], c0.publicKey());
    expect(t.lm.checkValid(userTx)).toMatchObject({ ok: true });
    expect(t.apply(userTx).resultCode).toBe('txSUCCESS');
    expect(t.seqOf(c0.publicKey())).toBe(cur + 1n);
  });

  it('a transaction that uses a channel bids exactly the base fee: no outbidding, no fee burning', () => {
    const t = production();
    const [c0, c1] = t.channels;
    const user = Keypair.random();
    t.fund([user]);
    const create = (source?: string) => Operation.createAccount({ source, destination: Keypair.random().publicKey(), startingBalance: FB });
    // One operation each, so the fee bid is baseFee (the builder's fee is per operation).
    for (const baseFee of [99, 101, 200, 1000, 1_000_000]) {
      const fromChannel = t.tx(c0, [create()], { baseFee });
      expect(t.lm.checkValid(fromChannel), `channel tx, fee ${baseFee}`).toMatchObject({ ok: false, code: 'txNOT_SUPPORTED', detail: CHANNEL_POLICY_DETAIL });
      // A user who pays the fee for a channel operation bids the base fee too.
      const sponsored = t.tx(user, [create(c1.publicKey())], { baseFee, signers: [user, c1] });
      expect(t.lm.checkValid(sponsored), `user tx, fee ${baseFee}`).toMatchObject({ ok: false, code: 'txNOT_SUPPORTED', detail: CHANNEL_POLICY_DETAIL });
    }
    expect(t.lm.checkValid(t.tx(c0, [create()]))).toMatchObject({ ok: true, fee: 100n });
    expect(t.lm.checkValid(t.tx(user, [create(c1.publicKey())], { signers: [user, c1] }))).toMatchObject({ ok: true, fee: 100n });
    // Other transactions may still bid more.
    const pay = Operation.payment({ destination: c0.publicKey(), asset: native, amount: '1' });
    expect(t.lm.checkValid(t.tx(user, [pay], { baseFee: 1000 }))).toMatchObject({ ok: true });

    // A higher bid cannot take a friendbot transaction's place in a tx set:
    // trimInvalid reports it invalid and keeps the base fee transaction.
    const honest = t.tx(c1, [create()]);
    const rich = t.tx(c0, [create()], { baseFee: 200 });
    expect(t.lm.trimInvalid([rich, honest], t.closeTime)).toEqual({ valid: [honest], invalid: [rich] });

    // Forced into a ledger (a tx set that bypassed validation): no effect, no
    // sequence number used; only the fee is charged (at most the base fee).
    const dest = Keypair.random().publicKey();
    const before = t.lm.getAccount(c0.publicKey())!;
    const r = t.apply(t.tx(c0, [Operation.createAccount({ destination: dest, startingBalance: FB })], { baseFee: 1_000_000 }));
    expect(r).toMatchObject({ resultCode: 'txNOT_SUPPORTED', feeCharged: 100n });
    expect(t.lm.getAccount(dest)).toBeUndefined();
    expect(t.lm.getAccount(c0.publicKey())!).toMatchObject({ seqNum: before.seqNum, balance: before.balance - 100n });
  });

  it('tx sets: checkTxSetValid rejects a channel tx outside the policy, trimInvalid drops it', () => {
    const t = production();
    const [c0, c1] = t.channels;
    const good = t.tx(c1, [Operation.createAccount({ destination: Keypair.random().publicKey(), startingBalance: FB })]);
    const bad = t.tx(c0, [Operation.accountMerge({ destination: c1.publicKey() })]);
    const lcl = t.lm.lastClosed().hash;
    const ct = t.closeTime + 5;
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, [good]), ct)).toEqual({ valid: true });
    const v = t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, [good, bad]), ct);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('txNOT_SUPPORTED');
    expect(t.lm.trimInvalid([good, bad], ct)).toEqual({ valid: [good], invalid: [bad] });
  });
});

describe('friendbot channel destinations (checkValid only)', () => {
  const create = (destination: string, source?: string) => Operation.createAccount({ source, destination, startingBalance: FB });
  const pay = (destination: string, source?: string) => Operation.payment({ source, destination, asset: native, amount: FB });
  const muxed = (id: string) => new MuxedAccount(new Account(id, '0'), '5').accountId();
  const envHash = (env: string) => sha256Hex(fromBase64(env));
  const key = (s: string) => Keypair.fromRawEd25519Seed(sha256(`policy-test|${s}`));

  /** A channel transaction refused for its destination: txFAILED with the result it would get when applied. */
  function expectRefused(t: TestLedger, env: string, opCode: string): void {
    const v = t.lm.checkValid(env);
    expect(v, opCode).toMatchObject({ ok: false, code: 'txFAILED' });
    expect(v.detail).toContain(opCode);
    expect(v.detail).toContain('friendbot channel policy');
  }

  it('a channel CreateAccount must create a new account and a channel Payment must pay an existing one', () => {
    const t = production();
    const [c0, c1] = t.channels;
    const user = Keypair.random();
    t.fund([user]);
    const fresh = Keypair.random().publicKey();
    // From the channel, and as a channel operation in a user's transaction.
    expectRefused(t, t.tx(c0, [create(user.publicKey())]), 'CREATE_ACCOUNT_ALREADY_EXIST');
    expectRefused(t, t.tx(c0, [create(c1.publicKey())]), 'CREATE_ACCOUNT_ALREADY_EXIST');
    expectRefused(t, t.tx(c0, [create(t.root.publicKey())]), 'CREATE_ACCOUNT_ALREADY_EXIST');
    expectRefused(t, t.tx(user, [create(user.publicKey(), c1.publicKey())], { signers: [user, c1] }), 'CREATE_ACCOUNT_ALREADY_EXIST');
    expectRefused(t, t.tx(c0, [pay(fresh)]), 'PAYMENT_NO_DESTINATION');
    expectRefused(t, t.tx(c0, [pay(muxed(fresh))]), 'PAYMENT_NO_DESTINATION');
    expectRefused(t, t.tx(user, [pay(fresh, c1.publicKey())], { signers: [user, c1] }), 'PAYMENT_NO_DESTINATION');
    // The forms friendbot uses stay valid.
    expect(t.lm.checkValid(t.tx(c0, [create(fresh)]))).toMatchObject({ ok: true });
    expect(t.lm.checkValid(t.tx(c0, [pay(user.publicKey())]))).toMatchObject({ ok: true });
    expect(t.lm.checkValid(t.tx(c0, [pay(muxed(user.publicKey()))]))).toMatchObject({ ok: true });
    expect(t.lm.checkValid(t.tx(user, [create(fresh, c1.publicKey())], { signers: [user, c1] }))).toMatchObject({ ok: true });

    // Transactions without a channel keep stellar-core's behavior: valid, and they fail when applied.
    const ownCreate = t.tx(user, [Operation.createAccount({ destination: c0.publicKey(), startingBalance: '1' })]);
    expect(t.lm.checkValid(ownCreate)).toMatchObject({ ok: true });
    expect(t.apply(ownCreate)).toMatchObject({ resultCode: 'txFAILED', operations: [{ resultCode: 'CREATE_ACCOUNT_ALREADY_EXIST' }] });
    const ownPay = t.tx(user, [Operation.payment({ destination: fresh, asset: native, amount: '1' })]);
    expect(t.lm.checkValid(ownPay)).toMatchObject({ ok: true });
    expect(t.apply(ownPay)).toMatchObject({ resultCode: 'txFAILED', operations: [{ resultCode: 'PAYMENT_NO_DESTINATION' }] });
  });

  it('apply time keeps the normal results: two creates of one new account fit one ledger, the second fails', () => {
    const t = production();
    const [c0, c1, c2] = t.channels;
    const fresh = Keypair.random().publicKey();
    const first = t.tx(c0, [create(fresh)]);
    const second = t.tx(c1, [create(fresh)]);
    const ct = t.closeTime + 5;
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(t.lm.lastClosed().hash, [first, second]), ct)).toEqual({ valid: true });
    expect(t.lm.trimInvalid([first, second], ct)).toEqual({ valid: [first, second], invalid: [] });
    const r = t.close([first, second]);
    const outcomes = r.results.map((x) => (x.successful ? 'txSUCCESS' : `${x.resultCode} ${x.operations[0].resultCode}`)).sort();
    expect(outcomes).toEqual(['txFAILED CREATE_ACCOUNT_ALREADY_EXIST', 'txSUCCESS']);
    expect(t.balanceOf(fresh)).toBe(FRIENDBOT_AMOUNT);

    // Now the account exists: a channel create of it is refused for a tx set...
    const third = t.tx(c2, [create(fresh)]);
    const set = t.lm.checkTxSetValid(t.lm.makeTxSet(t.lm.lastClosed().hash, [third]), t.closeTime + 5);
    expect(set.valid).toBe(false);
    expect(set.reason).toContain('CREATE_ACCOUNT_ALREADY_EXIST');
    expect(t.lm.trimInvalid([third], t.closeTime + 5)).toEqual({ valid: [], invalid: [third] });
    // ...and forced into a ledger it gets the normal result: the sequence
    // number is used and the fee charged, nothing else moves.
    const before = t.lm.getAccount(c2.publicKey())!;
    expect(t.apply(third)).toMatchObject({ resultCode: 'txFAILED', feeCharged: 100n, operations: [{ resultCode: 'CREATE_ACCOUNT_ALREADY_EXIST' }] });
    expect(t.lm.getAccount(c2.publicKey())).toMatchObject({ seqNum: before.seqNum + 1n, balance: before.balance - 100n });
    expect(t.balanceOf(fresh)).toBe(FRIENDBOT_AMOUNT);
  });

  it('a channel Payment may follow a channel CreateAccount of its destination in the same chain (a friendbot top-up)', () => {
    const t = production();
    const [c0, c1] = t.channels;
    const fresh = Keypair.random().publicKey();
    const other = Keypair.random().publicKey();
    const s = t.seqOf(c0.publicKey());
    const ct = t.closeTime + 5;
    const lcl = t.lm.lastClosed().hash;
    const createFresh = t.tx(c0, [create(fresh)]);
    const topUp = t.tx(c0, [pay(fresh)], { seqOffset: 1n });
    // The queue checks the top-up after the queued create (seqNumOverride):
    // a single check cannot see the create, so the tx set check decides.
    expect(t.lm.checkValid(topUp, { seqNumOverride: s + 1n, pendingFees: 100n })).toMatchObject({ ok: true });
    expect(t.lm.trimInvalid([topUp, createFresh], ct)).toEqual({ valid: [topUp, createFresh], invalid: [] });
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, [createFresh, topUp]), ct)).toEqual({ valid: true });
    // Only a channel CreateAccount of that account earlier in the same chain counts.
    const createOther = t.tx(c0, [create(other)]);
    const misdirected = t.tx(c0, [pay(fresh)], { seqOffset: 1n });
    expect(t.lm.trimInvalid([createOther, misdirected], ct)).toEqual({ valid: [createOther], invalid: [misdirected] });
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, [createOther, misdirected]), ct).reason).toContain('PAYMENT_NO_DESTINATION');
    const elsewhere = t.tx(c1, [create(fresh)]);
    const head = t.tx(c0, [pay(fresh)]);
    expect(t.lm.trimInvalid([elsewhere, head], ct)).toEqual({ valid: [elsewhere], invalid: [head] });
    // A second create of the account in the chain could only fail.
    const again = t.tx(c0, [create(fresh)], { seqOffset: 1n });
    expect(t.lm.trimInvalid([createFresh, again], ct)).toEqual({ valid: [createFresh], invalid: [again] });
    // Applied: the account gets both.
    expect(t.close([createFresh, topUp]).results.every((x) => x.successful)).toBe(true);
    expect(t.balanceOf(fresh)).toBe(2n * FRIENDBOT_AMOUNT);
  });

  it('channel transactions that can only fail no longer keep friendbot transactions out of the lane', () => {
    // The starvation probe: 16 channel transactions whose envelope hashes are
    // ground below every honest friendbot transaction, the fees paid by the
    // attacker. Each creates an account that exists or pays a missing one, so
    // it can only fail when applied and costs the channels nothing.
    const t = production();
    const attackers = t.channels.map((_, k) => key(`attacker-${k}`));
    const existing = key('existing');
    t.fund([...attackers, existing]);
    const honest = t.channels.map((ch, k) => t.tx(ch, [create(key(`honest-${k}`).publicKey())]));
    const lowest = honest.map(envHash).sort()[0];
    const attack = t.channels.map((ch, k) => {
      const op = k % 2 === 0 ? create(existing.publicKey(), ch.publicKey()) : pay(key(`missing-${k}`).publicKey(), ch.publicKey());
      for (let m = 0; m < 10_000; m++) {
        const env = t.tx(attackers[k], [op], { memo: Memo.id(String(m)), signers: [attackers[k], ch] });
        if (envHash(env) < lowest) return env;
      }
      throw new Error('no low hash found');
    });
    const ct = t.closeTime + 5;
    expect(t.lm.trimInvalid([...honest, ...attack], ct)).toEqual({ valid: honest, invalid: attack });
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(t.lm.lastClosed().hash, attack.slice(0, 1)), ct).valid).toBe(false);
    const channelTotal = () => t.channels.reduce((sum, c) => sum + t.balanceOf(c.publicKey()), 0n);
    const before = channelTotal();
    expect(t.close(honest).results.every((x) => x.successful)).toBe(true);
    expect(before - channelTotal()).toBe(16n * (FRIENDBOT_AMOUNT + 100n));
  });
});

describe('friendbot channel transactions per tx set', () => {
  const create = (source?: string) => Operation.createAccount({ source, destination: Keypair.random().publicKey(), startingBalance: FB });
  const envHash = (env: string) => sha256Hex(fromBase64(env));

  it('checkTxSetValid rejects more than MAX_FRIENDBOT_TXS_IN_TX_SET (16) transactions that use a channel', () => {
    const t = production();
    const [user, other] = [Keypair.random(), Keypair.random()];
    t.fund([user, other]);
    const lcl = t.lm.lastClosed().hash;
    const ct = t.closeTime + 5;
    const check = (envs: string[]) => t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, envs), ct);
    const sixteen = t.channels.map((c) => t.tx(c, [create()]));
    expect(check(sixteen)).toEqual({ valid: true });
    // The next transaction of channel 0 (its next sequence number) is the 17th.
    const next = t.tx(t.channels[0], [create()], { seqOffset: 1n });
    expect(check([...sixteen, next])).toEqual({ valid: false, reason: 'too many friendbot channel transactions (17)' });
    // A user transaction with a channel operation counts too, else it would bypass the cap.
    const sponsored = t.tx(user, [create(t.channels[3].publicKey())], { signers: [user, t.channels[3]] });
    expect(check([...sixteen.slice(1), sponsored])).toEqual({ valid: true });
    expect(check([...sixteen, sponsored])).toEqual({ valid: false, reason: 'too many friendbot channel transactions (17)' });
    // Transactions without a channel do not count.
    const pay = t.tx(user, [Operation.payment({ destination: other.publicKey(), asset: native, amount: '1' })]);
    expect(check([...sixteen, pay])).toEqual({ valid: true });
    expect(MAX_FRIENDBOT_TXS_IN_TX_SET).toBe(16);
  });

  it('trimInvalid keeps the 16 channel transactions with the lowest envelope hashes; the rest stay queued', () => {
    const t = production();
    const users = Array.from({ length: 8 }, () => Keypair.random());
    const payers = Array.from({ length: 4 }, () => Keypair.random());
    t.fund([...users, ...payers]);
    // One transaction per source account, so each heads its account's chain:
    // 16 from the channels and 8 from users with a channel operation.
    const channelTxs = [
      ...t.channels.map((c) => t.tx(c, [create()])),
      ...users.map((u, i) => t.tx(u, [create(t.channels[i].publicKey())], { signers: [u, t.channels[i]] })),
    ];
    // Transactions without a channel are not limited by the cap.
    const pays = payers.map((p) => t.tx(p, [Operation.payment({ destination: users[0].publicKey(), asset: native, amount: '1' })]));
    const lowest = new Set([...channelTxs].sort((a, b) => (envHash(a) < envHash(b) ? -1 : 1)).slice(0, 16));
    const all = [...channelTxs, ...pays];
    const r = t.lm.trimInvalid(all, t.closeTime);
    expect(r.invalid).toEqual([]);
    expect(r.valid).toEqual(all.filter((e) => lowest.has(e) || pays.includes(e)));
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(t.lm.lastClosed().hash, r.valid), t.closeTime + 5)).toEqual({ valid: true });
    // The other 8 are still valid and fit the next ledger.
    expect(t.close(r.valid).results.every((x) => x.successful)).toBe(true);
    const rest = channelTxs.filter((e) => !lowest.has(e));
    expect(t.lm.trimInvalid(rest, t.closeTime)).toEqual({ valid: rest, invalid: [] });
  });

  it('a channel chain stays in sequence order: a later transaction never comes before its predecessor', () => {
    const t = production();
    const [c0] = t.channels;
    // A chain of 20 on channel 0: only the first 16 (by sequence number) fit.
    const chain = Array.from({ length: 20 }, (_, k) => t.tx(c0, [create()], { seqOffset: BigInt(k) }));
    const r = t.lm.trimInvalid([...chain].reverse(), t.closeTime);
    expect(r).toEqual({ valid: chain.slice(0, 16).reverse(), invalid: [] });
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(t.lm.lastClosed().hash, r.valid), t.closeTime + 5)).toEqual({ valid: true });
  });

  it('an account whose next channel transaction does not fit keeps the rest of its chain queued', () => {
    const t = production();
    const [user, other] = [Keypair.random(), Keypair.random()];
    t.fund([user, other]);
    const sixteen = t.channels.map((c) => t.tx(c, [create()]));
    const pay = (fee: number, seqOffset: bigint, memo?: Memo) =>
      t.tx(user, [Operation.payment({ destination: other.publicKey(), asset: native, amount: '1' })], { baseFee: fee, seqOffset, memo });
    // user: a payment with a high fee rate, then a channel operation, then another payment.
    const first = pay(1000, 0n);
    // The middle transaction gets the highest envelope hash of all 17 channel
    // transactions (a memo varies it), so the full lane leaves it out.
    const highest = sixteen.map(envHash).sort().pop()!;
    let middle = '';
    for (let i = 0; middle === '' || envHash(middle) <= highest; i++) {
      middle = t.tx(user, [create(t.channels[0].publicKey())], { seqOffset: 1n, memo: Memo.id(String(i)), signers: [user, t.channels[0]] });
    }
    const last = pay(1000, 2n);
    const all = [...sixteen, first, middle, last];
    expect(t.lm.trimInvalid(all, t.closeTime)).toEqual({ valid: [...sixteen, first], invalid: [] });
    // With room in the lane the whole chain goes in.
    expect(t.lm.trimInvalid(all.slice(1), t.closeTime)).toEqual({ valid: all.slice(1), invalid: [] });
  });

  it('one ledger moves at most 16 x FRIENDBOT_AMOUNT out of the channels', () => {
    const t = production();
    const sink = Keypair.random();
    t.fund([sink]);
    // The measured attack: chains of channel payments to one account (here 4 per channel, 64 in all).
    const envs = t.channels.flatMap((c) =>
      Array.from({ length: 4 }, (_, k) => t.tx(c, [Operation.payment({ destination: sink.publicKey(), asset: native, amount: FB })], { seqOffset: BigInt(k) })),
    );
    const lcl = t.lm.lastClosed().hash;
    const ct = t.closeTime + 5;
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, envs), ct)).toEqual({ valid: false, reason: 'too many friendbot channel transactions (64)' });
    const r = t.lm.trimInvalid(envs, ct);
    expect(r.invalid).toEqual([]);
    expect(r.valid).toHaveLength(16);
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, r.valid), ct)).toEqual({ valid: true });
    const before = t.balanceOf(sink.publicKey());
    expect(t.close(r.valid).results.every((x) => x.successful)).toBe(true);
    expect(t.balanceOf(sink.publicKey()) - before).toBe(16n * FRIENDBOT_AMOUNT);
    // Emptying all channels takes 100,000 ledgers: about 5.8 days at the target close time.
    const ledgers = (BigInt(FRIENDBOT_CHANNELS) * FRIENDBOT_CHANNEL_BALANCE) / (BigInt(MAX_FRIENDBOT_TXS_IN_TX_SET) * FRIENDBOT_AMOUNT);
    expect(ledgers).toBe(100_000n);
    expect((Number(ledgers) * LEDGER_TARGET_CLOSE_MS) / 86_400_000).toBeGreaterThan(5.5);
  });

  it('APP_VERSION is 4: older builds lack these rules, so they must not bind', () => {
    // A version 2 build accepts the first two; a version 3 build accepts the
    // third. Bound together, the builds reject each other's tx sets, and a
    // new node replaying an old node's ledger gets another header hash, so it
    // cannot catch up.
    const t = production();
    const seventeen = [...t.channels.map((c) => t.tx(c, [create()])), t.tx(t.channels[0], [create()], { seqOffset: 1n })];
    const set = t.lm.makeTxSet(t.lm.lastClosed().hash, seventeen);
    expect(t.lm.checkTxSetValid(set, t.closeTime + 5).valid).toBe(false);
    expect(t.apply(t.tx(t.channels[1], [create()], { baseFee: 200 })).resultCode).toBe('txNOT_SUPPORTED');
    // Version 4: a channel CreateAccount of an existing account (7.3).
    const existing = t.tx(t.channels[2], [Operation.createAccount({ destination: t.channels[3].publicKey(), startingBalance: FB })]);
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(t.lm.lastClosed().hash, [existing]), t.closeTime + 5).valid).toBe(false);
    expect(APP_VERSION).toBe(4);
  });
});

describe('DEX operations per tx set', () => {
  const issuer = Keypair.random();
  const usd = new Asset('USD', issuer.publicKey());
  const eur = new Asset('EUR', issuer.publicKey());
  const offer = (amount = '1') => Operation.manageSellOffer({ selling: native, buying: usd, amount, price: { n: 1, d: 1 } });
  const offers = (n: number) => Array.from({ length: n }, () => offer());
  const payments = (to: Keypair, n: number) => Array.from({ length: n }, () => Operation.payment({ destination: to.publicKey(), asset: native, amount: '1' }));

  it('classifies operations like stellar-core isDexOperation', () => {
    const t = new TestLedger();
    const a = Keypair.random().publicKey();
    const pp = (send: Asset, dest: Asset, path: Asset[]) => [
      Operation.pathPaymentStrictSend({ sendAsset: send, sendAmount: '1', destination: a, destAsset: dest, destMin: '1', path }),
      Operation.pathPaymentStrictReceive({ sendAsset: send, sendMax: '1', destination: a, destAsset: dest, destAmount: '1', path }),
    ];
    const cases: [xdr.Operation, boolean][] = [
      [offer(), true],
      [Operation.manageSellOffer({ selling: native, buying: usd, amount: '0', price: { n: 1, d: 1 }, offerId: '5' }), false],
      [Operation.manageBuyOffer({ selling: native, buying: usd, buyAmount: '2', price: { n: 1, d: 1 } }), true],
      [Operation.manageBuyOffer({ selling: native, buying: usd, buyAmount: '0', price: { n: 1, d: 1 }, offerId: '5' }), false],
      [Operation.createPassiveSellOffer({ selling: usd, buying: eur, amount: '3', price: { n: 1, d: 1 } }), true],
      ...pp(native, usd, []).map((op): [xdr.Operation, boolean] => [op, true]),
      ...pp(usd, usd, [eur]).map((op): [xdr.Operation, boolean] => [op, true]),
      ...pp(usd, usd, []).map((op): [xdr.Operation, boolean] => [op, false]),
      [Operation.payment({ destination: a, asset: usd, amount: '1' }), false],
      [Operation.createAccount({ destination: a, startingBalance: '1' }), false],
      [Operation.changeTrust({ asset: usd }), false],
    ];
    const tx = decodeTransaction(t.tx(Keypair.random().publicKey(), cases.map(([op]) => op), { seq: 1n }), t.lm.networkId);
    expect(tx.ops.map((op) => isDexOperation(op))).toEqual(cases.map(([, dex]) => dex));
  });

  it('checkTxSetValid rejects more than MAX_DEX_OPS_IN_TX_SET (200) operations in DEX transactions', () => {
    const t = new TestLedger();
    const [a, b, c, d, e, f] = Array.from({ length: 6 }, () => Keypair.random());
    t.fund([a, b, c, d, e, f]);
    const lcl = t.lm.lastClosed().hash;
    const ct = t.closeTime + 5;
    const check = (envs: string[]) => t.lm.checkTxSetValid(t.lm.makeTxSet(lcl, envs), ct);
    const dex100a = t.tx(a, offers(100));
    const dex100b = t.tx(b, offers(100));
    expect(check([dex100a, dex100b])).toEqual({ valid: true });
    const one = t.tx(c, offers(1));
    expect(check([dex100a, dex100b, one])).toEqual({ valid: false, reason: 'too many DEX operations (201)' });
    // Every operation of a transaction with a DEX operation counts (stellar-core lanes).
    const mixed = t.tx(c, [offer(), ...payments(d, 99)]);
    expect(check([dex100a, mixed])).toEqual({ valid: true });
    expect(check([dex100a, mixed, t.tx(d, offers(1))])).toMatchObject({ valid: false });
    // Transactions without DEX operations do not count: offer deletes, plain payments.
    const deletes = t.tx(d, Array.from({ length: 100 }, (_, i) => Operation.manageSellOffer({ selling: native, buying: usd, amount: '0', price: { n: 1, d: 1 }, offerId: String(i + 1) })));
    const pays = t.tx(e, payments(f, 100));
    expect(check([dex100a, dex100b, deletes, pays])).toEqual({ valid: true });
    expect(MAX_DEX_OPS_IN_TX_SET).toBe(200);
  });

  it('trimInvalid fills the DEX lane by fee rate and leaves the rest queued', () => {
    const t = new TestLedger();
    const ks = Array.from({ length: 6 }, () => Keypair.random());
    t.fund(ks);
    const [k0, k1, k2, k3, k4, k5] = ks;
    // Five DEX transactions of 50 operations: the four best fee rates fill the lane.
    const dex = [k0, k1, k2, k3, k4].map((k, i) => t.tx(k, offers(50), { baseFee: 100 * (5 - i) }));
    const cheapPay = t.tx(k5, payments(k0, 3), { baseFee: 100 });
    const r = t.lm.trimInvalid([cheapPay, ...dex], t.closeTime);
    expect(r).toEqual({ valid: [cheapPay, ...dex.slice(0, 4)], invalid: [] });
    expect(t.lm.checkTxSetValid(t.lm.makeTxSet(t.lm.lastClosed().hash, r.valid), t.closeTime + 5)).toEqual({ valid: true });
  });

  it('an account whose next DEX transaction does not fit keeps the rest of its chain queued', () => {
    const t = new TestLedger();
    const ks = Array.from({ length: 4 }, () => Keypair.random());
    t.fund(ks);
    const [g1, g2, f, h] = ks;
    const big1 = t.tx(g1, offers(100), { baseFee: 300 });
    const big2 = t.tx(g2, offers(100), { baseFee: 200 });
    // f: a cheap DEX head, then a payment with a high fee rate that depends on it.
    const fHead = t.tx(f, offers(1), { baseFee: 150 });
    const fNext = t.tx(f, payments(h, 1), { baseFee: 1000, seqOffset: 1n });
    const hPay = t.tx(h, payments(g1, 1), { baseFee: 100 });
    const r = t.lm.trimInvalid([big1, big2, fHead, fNext, hPay], t.closeTime);
    expect(r).toEqual({ valid: [big1, big2, hPay], invalid: [] });
    // Without the full lane, the chain goes in.
    expect(t.lm.trimInvalid([big1, fHead, fNext, hPay], t.closeTime).valid).toEqual([big1, fHead, fNext, hPay]);
  });

  it('without DEX transactions the set is the same as before (generic lane only)', () => {
    const t = new TestLedger();
    const ks = Array.from({ length: 12 }, () => Keypair.random());
    t.fund(ks);
    // 12 x 100 payments: the generic lane (maxTxSetSize 1000) keeps the 10 best fee rates.
    const envs = ks.map((k, i) => t.tx(k, payments(ks[(i + 1) % ks.length], 100), { baseFee: 100 + i }));
    const r = t.lm.trimInvalid(envs, t.closeTime);
    expect(r.valid).toEqual(envs.slice(2));
    expect(r.invalid).toEqual([]);
  });
});
