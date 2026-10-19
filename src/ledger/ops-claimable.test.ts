import { Asset, Claimant, Keypair, Operation, xdr } from '@stellar/stellar-sdk/base';
import { beforeEach, describe, expect, it } from 'vitest';
import { toHex } from '../lib/bytes';
import { claimableBalanceKey, trustlineKey } from './keys';
import { claimableBalanceId, evaluatePredicate } from './ops/claimableBalances';
import { TestLedger, XLM, af, opResultTr, withBody } from './testkit';
import {
  AUTH_CLAWBACK_ENABLED_FLAG,
  AUTH_REVOCABLE_FLAG,
  CB_CLAWBACK_ENABLED_FLAG,
  type ClaimPredicate,
  type ClaimableBalanceEntry,
  type CreditAsset,
  type TrustLineEntry,
} from './types';
import { opBody } from './xdrutil';

function opCodes(r: { operations: { resultCode: string }[] }): string[] {
  return r.operations.map((o) => o.resultCode);
}

const uncond = () => Claimant.predicateUnconditional();

describe('operations: claimable balances', () => {
  let t: TestLedger;
  let a: Keypair;
  let b: Keypair;
  let c: Keypair;

  beforeEach(() => {
    t = new TestLedger();
    a = Keypair.random();
    b = Keypair.random();
    c = Keypair.random();
    t.fund([a, b, c], 100n * XLM);
  });

  function create(src: Keypair, claimants: Claimant[], amount = '10', asset = Asset.native()) {
    const tx = t.build(src, [Operation.createClaimableBalance({ asset, amount, claimants })]);
    const r = t.apply(tx.toEnvelope().toXdr('base64'));
    return { r, id: r.operations[0].details.balanceId as string | undefined, sbId: tx.getClaimableBalanceId(0) };
  }

  const claim = (src: Keypair, id: string) =>
    t.apply(t.tx(src, [Operation.claimClaimableBalance({ balanceId: `00000000${id}` })]));

  it('creates a balance with the stellar-core balance id and sponsors its reserve', () => {
    const seq = t.seqOf(a.publicKey()) + 1n;
    const { r, id, sbId } = create(a, [new Claimant(b.publicKey(), uncond()), new Claimant(c.publicKey(), uncond())]);
    expect(opCodes(r)).toEqual(['CREATE_CLAIMABLE_BALANCE_SUCCESS']);
    expect(id).toBe(sbId.slice(8));
    expect(id).toBe(claimableBalanceId(a.publicKey(), seq, 0));
    const cb = t.lm.getEntry(claimableBalanceKey(id!)) as ClaimableBalanceEntry;
    expect(cb).toMatchObject({ amount: 10n * XLM, sponsor: a.publicKey(), flags: 0, asset: { type: 'native' } });
    expect(cb.claimants.map((x) => x.destination)).toEqual([b.publicKey(), c.publicKey()]);
    const acc = t.lm.getAccount(a.publicKey())!;
    expect(acc.numSponsoring).toBe(2);
    expect(t.lm.minBalance(acc)).toBe(4n * 5_000_000n);
    expect(acc.balance).toBe(90n * XLM - 100n);
    expect(t.lm.getClaimableBalances({ claimant: b.publicKey() })).toHaveLength(1);
    expect(t.lm.getClaimableBalances({ sponsor: a.publicKey() })).toHaveLength(1);
    expect(t.lm.getClaimableBalances({ claimant: a.publicKey() })).toHaveLength(0);

    const created = xdr.expectUnionVariant(opResultTr(r.resultXdr), 'createClaimableBalance').createClaimableBalanceResult;
    expect(toHex(xdr.expectUnionVariant(created, 'createClaimableBalanceSuccess').balanceId.v0.toBytes())).toBe(id);
  });

  it('claims: credits the claimant, removes the entry and releases the sponsor reserve', () => {
    const { id } = create(a, [new Claimant(b.publicKey(), uncond())]);
    const before = t.balanceOf(b.publicKey());
    expect(opCodes(claim(c, id!))).toEqual(['CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM']);
    expect(opCodes(claim(b, id!))).toEqual(['CLAIM_CLAIMABLE_BALANCE_SUCCESS']);
    expect(t.balanceOf(b.publicKey())).toBe(before + 10n * XLM - 100n);
    expect(t.lm.getEntry(claimableBalanceKey(id!))).toBeUndefined();
    expect(t.lm.getAccount(a.publicKey())!.numSponsoring).toBe(0);
    expect(opCodes(claim(b, id!))).toEqual(['CLAIM_CLAIMABLE_BALANCE_DOES_NOT_EXIST']);
  });

  it('CREATE_CLAIMABLE_BALANCE_UNDERFUNDED, LOW_RESERVE and MALFORMED', () => {
    expect(opCodes(create(a, [new Claimant(b.publicKey(), uncond())], '99').r)).toEqual([
      'CREATE_CLAIMABLE_BALANCE_UNDERFUNDED',
    ]);
    // 98.5 XLM leaves 1.5 XLM - fees: enough for the base reserve but not one more.
    expect(opCodes(create(a, [new Claimant(b.publicKey(), uncond())], '98.5').r)).toEqual([
      'CREATE_CLAIMABLE_BALANCE_LOW_RESERVE',
    ]);
    const dup = Operation.createClaimableBalance({
      asset: Asset.native(),
      amount: '1',
      claimants: [new Claimant(b.publicKey(), uncond()), new Claimant(b.publicKey(), uncond())],
    });
    expect(t.lm.checkValid(t.tx(a, [dup])).detail).toContain('CREATE_CLAIMABLE_BALANCE_MALFORMED');
    const deep = Claimant.predicateNot(
      Claimant.predicateNot(Claimant.predicateNot(Claimant.predicateNot(Claimant.predicateUnconditional()))),
    );
    const tooDeep = Operation.createClaimableBalance({ asset: Asset.native(), amount: '1', claimants: [new Claimant(b.publicKey(), deep)] });
    expect(t.lm.checkValid(t.tx(a, [tooDeep])).detail).toContain('CREATE_CLAIMABLE_BALANCE_MALFORMED');
    const ok4 = Claimant.predicateNot(Claimant.predicateNot(Claimant.predicateNot(Claimant.predicateUnconditional())));
    expect(
      t.lm.checkValid(t.tx(a, [Operation.createClaimableBalance({ asset: Asset.native(), amount: '1', claimants: [new Claimant(b.publicKey(), ok4)] })])).ok,
    ).toBe(true);
    const ok = Operation.createClaimableBalance({
      asset: Asset.native(),
      amount: '1',
      claimants: [new Claimant(b.publicKey(), Claimant.predicateBeforeAbsoluteTime('5'))],
    });
    const o = opBody(ok, 'createClaimableBalance').createClaimableBalanceOp;
    const negative = xdr.Claimant.claimantTypeV0(
      new xdr.ClaimantV0({
        destination: o.claimants[0].v0.destination,
        predicate: xdr.ClaimPredicate.claimPredicateBeforeAbsoluteTime(xdr.Int64(-5n)),
      }),
    );
    const neg = withBody(ok, xdr.OperationBody.createClaimableBalance(new xdr.CreateClaimableBalanceOp({ ...o, claimants: [negative] })));
    expect(t.lm.checkValid(t.rawTx(a, [neg])).detail).toContain('CREATE_CLAIMABLE_BALANCE_MALFORMED');
  });

  it('MALFORMED, not a throw, for predicates nested far beyond the depth limit', () => {
    // js-xdr 5 decodes about 500 nested predicates; stellar-base 15 stopped
    // below 100. The depth check of validatePredicate must reject them.
    let deep = Claimant.predicateUnconditional();
    for (let i = 0; i < 300; i++) deep = Claimant.predicateNot(deep);
    const op = Operation.createClaimableBalance({ asset: Asset.native(), amount: '1', claimants: [new Claimant(b.publicKey(), deep)] });
    const r = t.lm.checkValid(t.rawTx(a, [op]));
    expect(r.code).toBe('txFAILED');
    expect(r.detail).toContain('CREATE_CLAIMABLE_BALANCE_MALFORMED');
  });

  it('converts relative predicates to absolute ones at the close time', () => {
    const rel = () => [new Claimant(b.publicKey(), Claimant.predicateBeforeRelativeTime('60'))];
    const r = t.close([
      t.tx(a, [Operation.createClaimableBalance({ asset: Asset.native(), amount: '1', claimants: rel() })]),
      t.tx(c, [Operation.createClaimableBalance({ asset: Asset.native(), amount: '1', claimants: rel() })]),
    ]);
    const created = t.closeTime;
    const ids = r.results.map((x) => x.operations[0].details.balanceId as string);
    for (const id of ids) {
      const cb = t.lm.getEntry(claimableBalanceKey(id)) as ClaimableBalanceEntry;
      expect(cb.claimants[0].predicate).toEqual({ type: 'beforeAbsoluteTime', time: BigInt(created + 60) });
    }
    // Claimable while closeTime < created + 60.
    t.closeTime = created + 54;
    expect(opCodes(claim(b, ids[0]))).toEqual(['CLAIM_CLAIMABLE_BALANCE_SUCCESS']);
    t.closeTime = created + 55;
    expect(opCodes(claim(b, ids[1]))).toEqual(['CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM']);
  });

  it('evaluates not / and / or predicates at the close time', () => {
    const at = t.closeTime + 100;
    const notBefore = Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(String(at)));
    const { id } = create(a, [new Claimant(b.publicKey(), notBefore)]);
    expect(opCodes(claim(b, id!))).toEqual(['CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM']);
    t.closeTime = at - 1;
    expect(opCodes(claim(b, id!))).toEqual(['CLAIM_CLAIMABLE_BALANCE_SUCCESS']);

    const p: ClaimPredicate = {
      type: 'and',
      predicates: [
        { type: 'not', predicate: { type: 'beforeAbsoluteTime', time: 10n } },
        { type: 'or', predicates: [{ type: 'beforeAbsoluteTime', time: 20n }, { type: 'beforeAbsoluteTime', time: 5n }] },
      ],
    };
    expect(evaluatePredicate(p, 9n)).toBe(false);
    expect(evaluatePredicate(p, 10n)).toBe(true);
    expect(evaluatePredicate(p, 19n)).toBe(true);
    expect(evaluatePredicate(p, 20n)).toBe(false);
    expect(evaluatePredicate({ type: 'unconditional' }, 0n)).toBe(true);
  });

  describe('credit asset balances', () => {
    let issuer: Keypair;
    let usd: Asset;
    let USD: CreditAsset;
    beforeEach(() => {
      issuer = Keypair.random();
      t.fund([issuer], 100n * XLM);
      usd = new Asset('USD', issuer.publicKey());
      USD = { type: 'credit_alphanum4', code: 'USD', issuer: issuer.publicKey() };
    });

    it('NO_TRUST, NOT_AUTHORIZED for creators; claims need a trustline unless issuer', () => {
      expect(opCodes(create(a, [new Claimant(b.publicKey(), uncond())], '1', usd).r)).toEqual([
        'CREATE_CLAIMABLE_BALANCE_NO_TRUST',
      ]);
      t.apply(t.tx(a, [Operation.changeTrust({ asset: usd })]));
      t.apply(t.tx(issuer, [Operation.payment({ destination: a.publicKey(), asset: usd, amount: '50' })]));
      expect(opCodes(create(a, [new Claimant(b.publicKey(), uncond())], '50.0000001', usd).r)).toEqual([
        'CREATE_CLAIMABLE_BALANCE_UNDERFUNDED',
      ]);
      const { id } = create(a, [new Claimant(b.publicKey(), uncond()), new Claimant(issuer.publicKey(), uncond())], '20', usd);
      expect((t.lm.getEntry(trustlineKey(a.publicKey(), USD)) as TrustLineEntry).balance).toBe(30n * XLM);
      expect(opCodes(claim(b, id!))).toEqual(['CLAIM_CLAIMABLE_BALANCE_NO_TRUST']);
      t.apply(t.tx(b, [Operation.changeTrust({ asset: usd, limit: '10' })]));
      expect(opCodes(claim(b, id!))).toEqual(['CLAIM_CLAIMABLE_BALANCE_LINE_FULL']);
      // The issuer can claim its own asset without a trustline.
      expect(opCodes(claim(issuer, id!))).toEqual(['CLAIM_CLAIMABLE_BALANCE_SUCCESS']);
      expect(t.lm.getAccount(a.publicKey())!.numSponsoring).toBe(0);

      t.apply(t.tx(issuer, [Operation.setOptions({ setFlags: AUTH_REVOCABLE_FLAG })]));
      const { id: id2 } = create(a, [new Claimant(b.publicKey(), uncond())], '5', usd);
      t.apply(t.tx(issuer, [Operation.setTrustLineFlags({ trustor: b.publicKey(), asset: usd, flags: { authorized: false } })]));
      expect(opCodes(claim(b, id2!))).toEqual(['CLAIM_CLAIMABLE_BALANCE_NOT_AUTHORIZED']);
      t.apply(t.tx(issuer, [Operation.setTrustLineFlags({ trustor: a.publicKey(), asset: usd, flags: { authorized: false } })]));
      expect(opCodes(create(a, [new Claimant(b.publicKey(), uncond())], '1', usd).r)).toEqual([
        'CREATE_CLAIMABLE_BALANCE_NOT_AUTHORIZED',
      ]);
    });

    it('clawback: balances inherit the flag and the issuer can claw them back', () => {
      t.apply(t.tx(issuer, [Operation.setOptions({ setFlags: af(AUTH_REVOCABLE_FLAG | AUTH_CLAWBACK_ENABLED_FLAG) })]));
      t.apply(t.tx(a, [Operation.changeTrust({ asset: usd })]));
      t.apply(t.tx(issuer, [Operation.payment({ destination: a.publicKey(), asset: usd, amount: '50' })]));
      const { id } = create(a, [new Claimant(b.publicKey(), uncond())], '20', usd);
      const cb = t.lm.getEntry(claimableBalanceKey(id!)) as ClaimableBalanceEntry;
      expect(cb.flags).toBe(CB_CLAWBACK_ENABLED_FLAG);
      const back = (src: Keypair, bid: string) =>
        t.apply(t.tx(src, [Operation.clawbackClaimableBalance({ balanceId: `00000000${bid}` })]));
      expect(opCodes(back(a, id!))).toEqual(['CLAWBACK_CLAIMABLE_BALANCE_NOT_ISSUER']);
      expect(opCodes(back(issuer, id!))).toEqual(['CLAWBACK_CLAIMABLE_BALANCE_SUCCESS']);
      expect(t.lm.getEntry(claimableBalanceKey(id!))).toBeUndefined();
      expect(t.lm.getAccount(a.publicKey())!.numSponsoring).toBe(0);
      expect(opCodes(back(issuer, id!))).toEqual(['CLAWBACK_CLAIMABLE_BALANCE_DOES_NOT_EXIST']);

      // Issuer-created balances follow the issuer's clawback flag.
      const { id: own } = create(issuer, [new Claimant(b.publicKey(), uncond())], '1', usd);
      expect((t.lm.getEntry(claimableBalanceKey(own!)) as ClaimableBalanceEntry).flags).toBe(CB_CLAWBACK_ENABLED_FLAG);

      // Native balances and balances without the flag cannot be clawed back.
      const { id: nat } = create(a, [new Claimant(b.publicKey(), uncond())], '1');
      expect(opCodes(back(issuer, nat!))).toEqual(['CLAWBACK_CLAIMABLE_BALANCE_NOT_ISSUER']);
      t.apply(t.tx(issuer, [Operation.setOptions({ clearFlags: AUTH_CLAWBACK_ENABLED_FLAG })]));
      const { id: plain } = create(issuer, [new Claimant(b.publicKey(), uncond())], '1', usd);
      expect(opCodes(back(issuer, plain!))).toEqual(['CLAWBACK_CLAIMABLE_BALANCE_NOT_CLAWBACK_ENABLED']);
    });
  });
});
