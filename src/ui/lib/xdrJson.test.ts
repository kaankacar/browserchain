import { Asset, Keypair, Memo, Operation, StrKey, TransactionBuilder, Account, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { base64ToHex, utf8 } from '../../lib/bytes';
import { decodeXdr, detectXdrType, jsonText, normalizeXdrInput, xdrToJson, type Json } from './xdrJson';

const PASS = 'BrowserChain Network ; October 2026';
const kp = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(21));
const dest = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(22)).publicKey();

function sampleEnvelope(): string {
  const tx = new TransactionBuilder(new Account(kp.publicKey(), '99'), { fee: '100', networkPassphrase: PASS })
    .addOperation(Operation.payment({ destination: dest, asset: new Asset('USDB', kp.publicKey()), amount: '10.5' }))
    .addMemo(Memo.text('hello'))
    .setTimeout(0)
    .build();
  tx.sign(kp);
  return tx.toEnvelope().toXdr('base64');
}

function obj(j: Json): Record<string, Json> {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
  return j as Record<string, Json>;
}

describe('xdr decoding', () => {
  it('decodes a transaction envelope into readable JSON', () => {
    const j = obj(decodeXdr('TransactionEnvelope', sampleEnvelope()));
    const v1 = obj(j.envelopeTypeTx);
    const tx = obj(v1.tx);
    expect(tx.sourceAccount).toBe(kp.publicKey());
    expect(tx.fee).toBe(100);
    expect(tx.seqNum).toBe('100');
    expect(tx.memo).toEqual({ memoText: 'hello' });
    const ops = tx.operations as Json[];
    const body = obj(obj(ops[0]).body);
    const pay = obj(body.payment);
    expect(pay.destination).toBe(dest);
    expect(pay.asset).toBe(`USDB:${kp.publicKey()}`);
    expect(pay.amount).toBe('105000000');
    expect(tx.ext).toBe('v0');
    const sigs = v1.signatures as Json[];
    expect(obj(sigs[0]).hint).toMatch(/^[0-9a-f]{8}$/);
    expect(jsonText(j)).toContain('"memoText": "hello"');
  });

  it('decodes results and headers', () => {
    const result = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString('100'),
      result: xdr.TransactionResultResult.txFailed([
        xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentUnderfunded())),
      ]),
      ext: xdr.TransactionResultExt.v0(),
    });
    const j = obj(decodeXdr('TransactionResult', result.toXdr('base64')));
    expect(j.feeCharged).toBe('100');
    expect(j.result).toEqual({ txFailed: [{ opInner: { payment: 'paymentUnderfunded' } }] });

    const zero = new Uint8Array(32);
    const header = new xdr.LedgerHeader({
      ledgerVersion: 23,
      previousLedgerHash: zero,
      scpValue: new xdr.StellarValue({ txSetHash: zero, closeTime: xdr.Uint64.fromString('1790000000'), upgrades: [], ext: xdr.StellarValueExt.stellarValueBasic() }),
      txSetResultHash: zero,
      bucketListHash: new Uint8Array(32).fill(0xab),
      ledgerSeq: 12,
      totalCoins: xdr.Int64.fromString('1000000000000000000'),
      feePool: xdr.Int64.fromString('0'),
      inflationSeq: 0,
      idPool: xdr.Uint64.fromString('3'),
      baseFee: 100,
      baseReserve: 5000000,
      maxTxSetSize: 1000,
      skipList: [zero, zero, zero, zero],
      ext: xdr.LedgerHeaderExt.v0(),
    });
    const h = obj(decodeXdr('LedgerHeader', header.toXdr('base64')));
    expect(h.ledgerSeq).toBe(12);
    expect(h.bucketListHash).toBe('ab'.repeat(32));
    expect(obj(h.scpValue).closeTime).toBe('1790000000');
    expect(obj(h.scpValue).ext).toBe('stellarValueBasic');
    expect(h.totalCoins).toBe('1000000000000000000');
  });

  it('decodes SCP envelopes and shows ballot values as StellarValues', () => {
    const value = new xdr.StellarValue({ txSetHash: new Uint8Array(32).fill(1), closeTime: xdr.Uint64.fromString('42'), upgrades: [], ext: xdr.StellarValueExt.stellarValueBasic() });
    const statement = new xdr.ScpStatement({
      nodeId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(kp.publicKey())),
      slotIndex: xdr.Uint64.fromString('7'),
      pledges: xdr.ScpStatementPledges.scpStExternalize(
        new xdr.ScpStatementExternalize({ commit: new xdr.ScpBallot({ counter: 1, value: value.toXdr() }), nH: 1, commitQuorumSetHash: new Uint8Array(32).fill(2) }),
      ),
    });
    const env = new xdr.ScpEnvelope({ statement, signature: new Uint8Array(64).fill(9) });
    const b64 = env.toXdr('base64');
    expect(detectXdrType(b64)).toBe('ScpEnvelope');
    const j = obj(decodeXdr('ScpEnvelope', b64));
    const st = obj(j.statement);
    expect(st.nodeId).toBe(kp.publicKey());
    expect(st.slotIndex).toBe('7');
    const ext = obj(obj(st.pledges).scpStExternalize);
    const commit = obj(ext.commit);
    expect(commit.counter).toBe(1);
    const decodedValue = obj(commit.value);
    expect(decodedValue.hex).toBe(value.toXdr('hex'));
    expect(obj(decodedValue.stellarValue).closeTime).toBe('42');
  });

  it('shows the envelopes of a TransactionSet under "txs", the XDR field name', () => {
    // stellar-base 15 named this field "txes"; stellar-sdk 17 uses the XDR name.
    const env = xdr.TransactionEnvelope.fromXdr(sampleEnvelope(), 'base64');
    const set = new xdr.TransactionSet({ previousLedgerHash: new Uint8Array(32), txs: [env] });
    const j = obj(decodeXdr('TransactionSet', set.toXdr('base64')));
    expect(Object.keys(j)).toEqual(['previousLedgerHash', 'txs']);
    expect(j.txs).toHaveLength(1);
  });

  it('detects types and accepts hex input', () => {
    const env = sampleEnvelope();
    expect(detectXdrType(env)).toBe('TransactionEnvelope');
    const hex = base64ToHex(env);
    expect(normalizeXdrInput(hex).format).toBe('hex');
    expect(detectXdrType(hex)).toBe('TransactionEnvelope');
    expect(detectXdrType('AAAA')).not.toBe('TransactionEnvelope');
    expect(detectXdrType('###')).toBeNull();
    expect(() => decodeXdr('LedgerHeader', env)).toThrow(/Not a valid LedgerHeader/);
    expect(() => normalizeXdrInput('   ')).toThrow(/Paste/);
    expect(() => normalizeXdrInput('***')).toThrow(/base64/);
  });

  it('converts primitive values', () => {
    expect(xdrToJson(5n)).toBe('5');
    expect(xdrToJson(null)).toBeNull();
    expect(xdrToJson(new Uint8Array([1, 255]))).toBe('01ff');
    expect(xdrToJson(utf8('home.example'), 'homeDomain')).toBe('home.example');
    expect(xdrToJson(new xdr.XdrString('home.example'), 'homeDomain')).toBe('home.example');
    expect(xdrToJson(new Uint8Array([85, 83, 68, 0]), 'assetCode')).toBe('USD');
  });
});
