// Randomized property test over many seeds: random classic and DEX traffic
// (offers, path payments, payments, claimable balances, trust line changes,
// authorization changes, clawbacks, signers, data, merges) applied by two
// ledger managers. Manager B is reloaded from A's snapshot every few ledgers,
// so its maps are filled in another order. After every ledger:
// - both managers give the same header hash, result set and changed keys;
// - trimInvalid output passes checkTxSetValid;
// - DEX invariants hold (liabilities, sub-entries, book not crossed);
// - sponsoring counts match the claimable balances, offers only use lines
//   authorized to maintain liabilities;
// - native supply (accounts + claimable balances + fee pool) is TOTAL_COINS;
// - every credit supply (trust lines + claimable balances) equals what was
//   issued minus what was clawed back.

import { Claimant, Keypair, Operation, Asset as SdkAsset, xdr, type TrustLineFlag } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { TOTAL_COINS } from '../lib/constants';
import { sha256 } from '../lib/hash';
import { pick, randInt, seededRng, type Rng } from '../lib/random';
import { assetId } from './asset';
import { checkDexInvariants } from './dex/testkit';
import { trustlineKey } from './keys';
import { loadLedgerFromSnapshot } from './manager';
import { TestLedger, af, stroopsToString } from './testkit';
import {
  AUTH_CLAWBACK_ENABLED_FLAG,
  AUTH_REQUIRED_FLAG,
  AUTH_REVOCABLE_FLAG,
  type Asset,
  type ClaimableBalanceEntry,
  type CreditAsset,
  type LedgerCloseResult,
  type LedgerEntry,
  type TrustLineEntry,
} from './types';
import { makeSignedStellarValue } from './value';
import { balanceIdToHex } from './xdrutil';

const amt = stroopsToString;

interface SimAsset {
  sdk: SdkAsset;
  asset: Asset;
}

const XLM_A: SimAsset = { sdk: SdkAsset.native(), asset: { type: 'native' } };

function credit(code: string, issuer: Keypair): SimAsset {
  return { sdk: new SdkAsset(code, issuer.publicKey()), asset: { type: 'credit_alphanum4', code, issuer: issuer.publicKey() } };
}

const PRICES = [
  { n: 1, d: 1 },
  { n: 2, d: 1 },
  { n: 1, d: 2 },
  { n: 3, d: 7 },
  { n: 7, d: 3 },
  { n: 101, d: 100 },
  { n: 100, d: 101 },
  { n: 1, d: 1000 },
  { n: 1000, d: 1 },
  { n: 2147483647, d: 2147483646 },
];

/** Log-uniform amount in stroops between 1 and about 10^10. */
function randAmount(rng: Rng): bigint {
  return BigInt(Math.max(1, Math.floor(Math.pow(10, rng() * 10))));
}

function randPredicate(rng: Rng, depth = 0): xdr.ClaimPredicate {
  const r = rng();
  if (depth >= 2 || r < 0.35) return Claimant.predicateUnconditional();
  if (r < 0.55) return Claimant.predicateBeforeRelativeTime(String(randInt(rng, 0, 30)));
  if (r < 0.7) return Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(String(randInt(rng, 0, 30))));
  if (r < 0.85) return Claimant.predicateAnd(randPredicate(rng, depth + 1), randPredicate(rng, depth + 1));
  return Claimant.predicateOr(randPredicate(rng, depth + 1), randPredicate(rng, depth + 1));
}

class World {
  a: TestLedger;
  b: TestLedger;
  readonly rng: Rng;
  readonly node: Keypair;
  readonly issuers: Keypair[];
  readonly traders: Keypair[];
  readonly signerPool: Keypair[];
  readonly assets: SimAsset[];
  readonly AAA: SimAsset;
  readonly BBB: SimAsset;
  readonly CCC: SimAsset;
  temps: Keypair[] = [];
  /** Issued minus clawed back, per asset id. */
  readonly expectedSupply = new Map<string, bigint>();
  readonly codes = new Map<string, number>();
  closeTime = 1_790_000_000;

  constructor(seed: number) {
    this.rng = seededRng(seed);
    const key = (label: string) => Keypair.fromRawEd25519Seed(sha256(`property|${seed}|${label}`));
    this.node = key('node');
    this.a = new TestLedger();
    this.b = new TestLedger();
    this.issuers = [key('issuer-0'), key('issuer-1')];
    this.traders = Array.from({ length: 7 }, (_, i) => key(`trader-${i}`));
    this.signerPool = [key('signer-0'), key('signer-1'), key('signer-2')];
    this.AAA = credit('AAA', this.issuers[0]);
    this.BBB = credit('BBB', this.issuers[0]);
    // Issuer 1: authorization required, revocable, clawback enabled.
    this.CCC = credit('CCC', this.issuers[1]);
    this.assets = [XLM_A, this.AAA, this.BBB, this.CCC];
  }

  /** Close one ledger on both managers with the valid part of `envs`. */
  close(envs: string[], expectAllValid = true): LedgerCloseResult {
    this.closeTime += randInt(this.rng, 1, 12);
    const lcl = this.a.lm.lastClosed();
    const { valid, invalid } = this.a.lm.trimInvalid(envs, this.closeTime);
    if (expectAllValid) expect(invalid).toEqual([]);
    expect(this.b.lm.trimInvalid(envs, this.closeTime)).toEqual({ valid, invalid });
    const txSet = this.a.lm.makeTxSet(lcl.hash, valid);
    expect(this.a.lm.checkTxSetValid(txSet, this.closeTime)).toEqual({ valid: true });
    expect(this.b.lm.checkTxSetValid(this.b.lm.decodeTxSet(txSet.xdr), this.closeTime)).toEqual({ valid: true });
    const value = makeSignedStellarValue(this.a.lm.networkId, this.node, txSet.hash, this.closeTime);
    const ra = this.a.lm.closeLedger(txSet, value);
    const rb = this.b.lm.closeLedger(this.b.lm.decodeTxSet(txSet.xdr), value);
    expect(rb.hash).toBe(ra.hash);
    expect(rb.resultSetXdr).toBe(ra.resultSetXdr);
    expect(rb.changedKeys).toEqual(ra.changedKeys);
    expect(rb.results.map((r) => r.operations)).toEqual(ra.results.map((r) => r.operations));
    for (const r of ra.results) {
      for (const op of r.operations) this.codes.set(op.resultCode, (this.codes.get(op.resultCode) ?? 0) + 1);
      if (r.operations.length === 0 || !r.successful) this.codes.set(r.resultCode, (this.codes.get(r.resultCode) ?? 0) + 1);
    }
    return ra;
  }

  /** Replace B with a node loaded from A's snapshot (JSON round trip). */
  reloadB(): void {
    const json = JSON.stringify(this.a.lm.snapshot(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    this.b = new TestLedger(loadLedgerFromSnapshot(JSON.parse(json), this.a.passphrase));
    expect(this.b.lm.lastClosed().hash).toBe(this.a.lm.lastClosed().hash);
  }

  setup(): void {
    const t = this.a;
    const create = (k: Keypair, xlm: string) => Operation.createAccount({ destination: k.publicKey(), startingBalance: xlm });
    this.close([t.tx(t.root, [...this.issuers.map((k) => create(k, '1000')), ...this.traders.map((k) => create(k, '20000'))])]);
    this.close([
      t.tx(this.issuers[1], [
        Operation.setOptions({ setFlags: af(AUTH_REQUIRED_FLAG | AUTH_REVOCABLE_FLAG | AUTH_CLAWBACK_ENABLED_FLAG) }),
      ]),
    ]);
    this.close(
      this.traders.map((k) =>
        t.tx(k, [this.AAA, this.BBB, this.CCC].map((a) => Operation.changeTrust({ asset: a.sdk }))),
      ),
    );
    this.close([
      t.tx(
        this.issuers[1],
        this.traders.map((k) =>
          Operation.setTrustLineFlags({ trustor: k.publicKey(), asset: this.CCC.sdk, flags: { authorized: true } }),
        ),
      ),
    ]);
    const mint = 1_000_000_000_000n;
    this.close([
      t.tx(this.issuers[0], [
        ...this.traders.map((k) => Operation.payment({ destination: k.publicKey(), asset: this.AAA.sdk, amount: amt(mint) })),
        ...this.traders.map((k) => Operation.payment({ destination: k.publicKey(), asset: this.BBB.sdk, amount: amt(mint) })),
      ]),
      t.tx(this.issuers[1], this.traders.map((k) => Operation.payment({ destination: k.publicKey(), asset: this.CCC.sdk, amount: amt(mint) }))),
    ]);
    for (const a of [this.AAA, this.BBB, this.CCC]) this.expectedSupply.set(assetId(a.asset), mint * BigInt(this.traders.length));
  }

  private claimableBalances(): ClaimableBalanceEntry[] {
    return this.a.lm.getClaimableBalances({});
  }

  private otherAssets(rng: Rng): [SimAsset, SimAsset] {
    const s = pick(rng, this.assets);
    let b = pick(rng, this.assets);
    while (b === s) b = pick(rng, this.assets);
    return [s, b];
  }

  private assetOf(a: Asset): SimAsset {
    return this.assets.find((x) => assetId(x.asset) === assetId(a))!;
  }

  traderOp(trader: Keypair): xdr.Operation {
    const rng = this.rng;
    const [selling, buying] = this.otherAssets(rng);
    const price = pick(rng, PRICES);
    const amount = randAmount(rng);
    const dest = pick(rng, this.traders);
    const r = rng();
    if (r < 0.16) return Operation.manageSellOffer({ selling: selling.sdk, buying: buying.sdk, amount: amt(amount), price });
    if (r < 0.24) return Operation.manageBuyOffer({ selling: selling.sdk, buying: buying.sdk, buyAmount: amt(amount), price });
    if (r < 0.28) return Operation.createPassiveSellOffer({ selling: selling.sdk, buying: buying.sdk, amount: amt(amount), price });
    if (r < 0.38) {
      const mine = this.a.lm.getOffersByAccount(trader.publicKey());
      if (mine.length > 0) {
        const o = pick(rng, mine);
        const same = rng() < 0.7;
        const s = same ? this.assetOf(o.selling) : selling;
        const b = same ? this.assetOf(o.buying) : buying;
        const newAmount = rng() < 0.35 ? 0n : amount;
        return rng() < 0.75
          ? Operation.manageSellOffer({ selling: s.sdk, buying: b.sdk, amount: amt(newAmount), price, offerId: o.offerId.toString() })
          : Operation.manageBuyOffer({ selling: s.sdk, buying: b.sdk, buyAmount: amt(newAmount), price, offerId: o.offerId.toString() });
      }
      return Operation.manageSellOffer({ selling: selling.sdk, buying: buying.sdk, amount: amt(amount), price, offerId: String(randInt(rng, 1, 50)) });
    }
    const path = Array.from({ length: randInt(rng, 0, 3) }, () => pick(rng, this.assets).sdk);
    if (r < 0.5) {
      return Operation.pathPaymentStrictSend({
        sendAsset: selling.sdk,
        sendAmount: amt(amount),
        destination: dest.publicKey(),
        destAsset: rng() < 0.1 ? selling.sdk : buying.sdk,
        destMin: amt(BigInt(randInt(rng, 1, 1000))),
        path,
      });
    }
    if (r < 0.6) {
      return Operation.pathPaymentStrictReceive({
        sendAsset: selling.sdk,
        sendMax: amt(amount * BigInt(randInt(rng, 1, 1000))),
        destination: dest.publicKey(),
        destAsset: rng() < 0.1 ? selling.sdk : buying.sdk,
        destAmount: amt(randAmount(rng)),
        path,
      });
    }
    if (r < 0.68) return Operation.payment({ destination: dest.publicKey(), asset: selling.sdk, amount: amt(amount) });
    if (r < 0.74) {
      const others = this.traders.filter((k) => rng() < 0.4);
      const claimants = (others.length > 0 ? others : [dest]).slice(0, 3).map((k) => new Claimant(k.publicKey(), randPredicate(rng)));
      return Operation.createClaimableBalance({ asset: selling.sdk, amount: amt(amount), claimants });
    }
    if (r < 0.82) {
      const cbs = this.claimableBalances();
      if (cbs.length > 0) return Operation.claimClaimableBalance({ balanceId: `00000000${pick(rng, cbs).balanceId}` });
      return Operation.claimClaimableBalance({ balanceId: `00000000${'ab'.repeat(32)}` });
    }
    if (r < 0.86) {
      const a = pick(rng, [this.AAA, this.BBB, this.CCC]);
      const tl = this.a.lm.getEntry(trustlineKey(trader.publicKey(), a.asset as CreditAsset)) as TrustLineEntry | undefined;
      const choices = [0n, 9_223_372_036_854_775_807n];
      if (tl) choices.push(tl.balance + tl.buyingLiabilities, tl.balance + tl.buyingLiabilities - 1n, tl.balance + 1n);
      const limit = pick(rng, choices);
      return Operation.changeTrust({ asset: a.sdk, limit: amt(limit < 0n ? 0n : limit) });
    }
    if (r < 0.9) {
      const name = `k${randInt(rng, 0, 3)}`;
      return Operation.manageData({ name, value: rng() < 0.6 ? `v${randInt(rng, 0, 999)}` : null });
    }
    if (r < 0.93) {
      return Operation.setOptions({ signer: { ed25519PublicKey: pick(rng, this.signerPool).publicKey(), weight: rng() < 0.6 ? 1 : 0 } });
    }
    if (r < 0.95) {
      const seq = this.a.lm.getAccount(trader.publicKey())!.seqNum;
      return Operation.bumpSequence({ bumpTo: (seq + BigInt(randInt(rng, 0, 3))).toString() });
    }
    const temp = Keypair.fromRawEd25519Seed(sha256(`temp|${rng()}`));
    this.temps.push(temp);
    return Operation.createAccount({ destination: temp.publicKey(), startingBalance: amt(BigInt(randInt(rng, 10_000_000, 60_000_000))) });
  }

  issuerOps(): { kp: Keypair; ops: xdr.Operation[] }[] {
    const rng = this.rng;
    const out: { kp: Keypair; ops: xdr.Operation[] }[] = [];
    const ops: xdr.Operation[] = [];
    const n = randInt(rng, 0, 3);
    for (let i = 0; i < n; i++) {
      const trustor = pick(rng, this.traders).publicKey();
      const r = rng();
      if (r < 0.25) {
        const flags = pick(rng, [
          { authorized: true, authorizedToMaintainLiabilities: false },
          { authorized: false, authorizedToMaintainLiabilities: true },
          { authorized: false, authorizedToMaintainLiabilities: false },
        ]);
        ops.push(Operation.setTrustLineFlags({ trustor, asset: this.CCC.sdk, flags }));
      } else if (r < 0.4) {
        ops.push(Operation.allowTrust({ trustor, assetCode: 'CCC', authorize: randInt(rng, 0, 2) as TrustLineFlag }));
      } else if (r < 0.7) {
        ops.push(Operation.clawback({ asset: this.CCC.sdk, amount: amt(randAmount(rng)), from: trustor }));
      } else {
        const cbs = this.claimableBalances().filter((c) => c.asset.type !== 'native');
        if (cbs.length > 0) ops.push(Operation.clawbackClaimableBalance({ balanceId: `00000000${pick(rng, cbs).balanceId}` }));
      }
    }
    if (ops.length > 0) out.push({ kp: this.issuers[1], ops });
    if (rng() < 0.2) {
      // Issuer 0 is not revocable: revocations fail with *_CANT_REVOKE.
      const trustor = pick(rng, this.traders).publicKey();
      out.push({
        kp: this.issuers[0],
        ops: [
          rng() < 0.5
            ? Operation.allowTrust({ trustor, assetCode: 'AAA', authorize: randInt(rng, 0, 2) as TrustLineFlag })
            : Operation.setTrustLineFlags({ trustor, asset: this.BBB.sdk, flags: { authorized: false } }),
        ],
      });
    }
    return out;
  }

  tempTxs(): string[] {
    const out: string[] = [];
    for (const temp of this.temps) {
      if (!this.a.lm.getAccount(temp.publicKey()) || this.rng() < 0.5) continue;
      const dest = pick(this.rng, this.traders).publicKey();
      const op =
        this.rng() < 0.7
          ? Operation.accountMerge({ destination: dest })
          : Operation.payment({ destination: dest, asset: XLM_A.sdk, amount: amt(BigInt(randInt(this.rng, 1, 5_000_000))) });
      out.push(this.a.tx(temp, [op]));
    }
    return out;
  }

  randomLedger(): LedgerCloseResult {
    const rng = this.rng;
    const cbBefore = new Map(this.claimableBalances().map((c) => [c.balanceId, c]));
    const envs: string[] = [];
    for (const trader of this.traders) {
      if (rng() < 0.2) continue;
      const ops = Array.from({ length: randInt(rng, 1, 3) }, () => this.traderOp(trader));
      envs.push(this.a.tx(trader, ops));
    }
    for (const { kp, ops } of this.issuerOps()) envs.push(this.a.tx(kp, ops));
    envs.push(...this.tempTxs());
    const r = this.close(envs);

    // Clawbacks reduce the credit supply.
    for (const res of r.results) {
      if (!res.successful) continue;
      const env = xdr.expectUnionVariant(xdr.TransactionEnvelope.fromXdr(res.envelopeXdr, 'base64'), 'envelopeTypeTx');
      for (const op of env.v1.tx.operations) {
        const body = op.body;
        if (body.type === 'clawback') {
          const key = assetId(this.CCC.asset);
          this.expectedSupply.set(key, this.expectedSupply.get(key)! - body.clawbackOp.amount);
        } else if (body.type === 'clawbackClaimableBalance') {
          const cb = cbBefore.get(balanceIdToHex(body.clawbackClaimableBalanceOp.balanceId))!;
          const key = assetId(cb.asset);
          this.expectedSupply.set(key, this.expectedSupply.get(key)! - cb.amount);
        }
      }
    }
    return r;
  }

  check(): void {
    const lm = this.a.lm;
    const header = lm.lastClosed().header;
    const entries: LedgerEntry[] = lm.allEntries();
    expect(checkDexInvariants(entries, header.baseReserve)).toEqual([]);

    let native = header.feePool;
    const credit = new Map<string, bigint>();
    const sponsoring = new Map<string, number>();
    const lines = new Map<string, TrustLineEntry>();
    for (const e of entries) {
      if (e.kind === 'account') {
        expect(e.balance >= 0n).toBe(true);
        native += e.balance;
      } else if (e.kind === 'trustline') {
        expect(e.flags & 3).not.toBe(3);
        expect(e.balance >= 0n && e.balance <= e.limit).toBe(true);
        lines.set(`${e.accountId}|${assetId(e.asset)}`, e);
        credit.set(assetId(e.asset), (credit.get(assetId(e.asset)) ?? 0n) + e.balance);
      } else if (e.kind === 'claimableBalance') {
        expect(e.amount > 0n).toBe(true);
        expect(e.claimants.length).toBeGreaterThan(0);
        sponsoring.set(e.sponsor, (sponsoring.get(e.sponsor) ?? 0) + e.claimants.length);
        if (e.asset.type === 'native') native += e.amount;
        else credit.set(assetId(e.asset), (credit.get(assetId(e.asset)) ?? 0n) + e.amount);
      }
    }
    expect(native).toBe(TOTAL_COINS);
    for (const [k, v] of this.expectedSupply) expect(credit.get(k) ?? 0n).toBe(v);
    for (const e of entries) {
      if (e.kind === 'account') expect(e.numSponsoring).toBe(sponsoring.get(e.accountId) ?? 0);
      if (e.kind === 'offer') {
        for (const a of [e.selling, e.buying]) {
          if (a.type === 'native' || a.issuer === e.sellerId) continue;
          const tl = lines.get(`${e.sellerId}|${assetId(a)}`);
          expect(tl && (tl.flags & 3) !== 0).toBe(true);
        }
      }
    }
  }
}

describe('randomized ledger properties', () => {
  // PROPERTY_SEEDS / PROPERTY_LEDGERS / PROPERTY_FIRST_SEED run a longer campaign locally.
  const first = Number(process.env.PROPERTY_FIRST_SEED ?? 1);
  const seeds = Array.from({ length: Number(process.env.PROPERTY_SEEDS ?? 8) }, (_, i) => first + i);
  const ledgers = Number(process.env.PROPERTY_LEDGERS ?? 30);

  it(`holds over ${seeds.length} seeds x ${ledgers} ledgers of random operations`, () => {
    const totals = new Map<string, number>();
    for (const seed of seeds) {
      const w = new World(seed);
      w.setup();
      w.check();
      for (let i = 0; i < ledgers; i++) {
        w.randomLedger();
        w.check();
        if (i % 7 === 6) w.reloadB();
      }
      expect(w.b.lm.stateHash()).toBe(w.a.lm.stateHash());
      for (const [k, v] of w.codes) totals.set(k, (totals.get(k) ?? 0) + v);
    }
    // The traffic reached the interesting paths.
    const at = (code: string) => totals.get(code) ?? 0;
    for (const code of [
      'MANAGE_SELL_OFFER_SUCCESS',
      'MANAGE_BUY_OFFER_SUCCESS',
      'PATH_PAYMENT_STRICT_SEND_SUCCESS',
      'PATH_PAYMENT_STRICT_RECEIVE_SUCCESS',
      'PAYMENT_SUCCESS',
      'CREATE_CLAIMABLE_BALANCE_SUCCESS',
      'CLAIM_CLAIMABLE_BALANCE_SUCCESS',
      'CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM',
      'SET_TRUST_LINE_FLAGS_SUCCESS',
      'ALLOW_TRUST_SUCCESS',
      'CLAWBACK_SUCCESS',
      'CLAWBACK_CLAIMABLE_BALANCE_SUCCESS',
      'CHANGE_TRUST_SUCCESS',
      'CHANGE_TRUST_INVALID_LIMIT',
      'MANAGE_DATA_SUCCESS',
      'SET_OPTIONS_SUCCESS',
      'ACCOUNT_MERGE_SUCCESS',
      'CREATE_ACCOUNT_SUCCESS',
    ]) {
      expect([code, at(code)]).not.toEqual([code, 0]);
    }
    expect([...totals.keys()].filter((c) => !c.endsWith('_SUCCESS')).length).toBeGreaterThan(15);
  });
});
