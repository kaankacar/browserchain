import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, readUint64BE, toHex } from '../lib/bytes';
import { networkIdOf, sha256, sha256Hex } from '../lib/hash';
import { computeHashNode, computeValueHash, xdrVarOpaque } from './hash';
import { nodeId, nodeKeypair } from './testkit';
import type { Envelope, QuorumSet, Statement } from './types';
import {
  ENVELOPE_TYPE_SCP,
  envelopeFromBase64,
  envelopeFromXdr,
  envelopeHash,
  envelopeToBase64,
  envelopeToBytes,
  envelopeToXdr,
  hashQuorumSet,
  nodeIdFromXdr,
  nodeIdToXdr,
  qsetFromXdr,
  qsetToBase64,
  qsetToBytes,
  qsetToXdr,
  signEnvelope,
  statementFromXdr,
  statementSignaturePayload,
  statementToBytes,
  statementToXdr,
  verifyEnvelope,
} from './xdr';

const NETWORK_ID = networkIdOf('BrowserChain Network ; October 2026');
const [n0, n1, n2, n3] = [0, 1, 2, 3].map(nodeId);
const H1 = sha256Hex('qset-1');
const V1 = sha256Hex('value-1');
const V2 = sha256Hex('value-2');
const V3 = 'ab'; // short values must round-trip too
const V4 = ''; // and the empty value

const statements: Statement[] = [
  {
    nodeId: n0,
    slotIndex: 7,
    pledges: {
      type: 'prepare',
      quorumSetHash: H1,
      ballot: { counter: 3, value: V2 },
      prepared: { counter: 2, value: V2 },
      preparedPrime: { counter: 1, value: V1 },
      nC: 1,
      nH: 2,
    },
  },
  {
    nodeId: n1,
    slotIndex: 0,
    pledges: {
      type: 'prepare',
      quorumSetHash: H1,
      ballot: { counter: 1, value: V3 },
      prepared: null,
      preparedPrime: null,
      nC: 0,
      nH: 0,
    },
  },
  {
    nodeId: n2,
    slotIndex: 123456,
    pledges: {
      type: 'confirm',
      ballot: { counter: 0xffffffff, value: V1 },
      nPrepared: 0xffffffff,
      nCommit: 2,
      nH: 0xffffffff,
      quorumSetHash: H1,
    },
  },
  {
    nodeId: n3,
    slotIndex: Number.MAX_SAFE_INTEGER,
    pledges: { type: 'externalize', commit: { counter: 2, value: V1 }, nH: 5, commitQuorumSetHash: H1 },
  },
  {
    nodeId: n0,
    slotIndex: 1,
    pledges: { type: 'nominate', quorumSetHash: H1, votes: [V4, V3, V1, V2].sort(), accepted: [V1] },
  },
  {
    nodeId: n0,
    slotIndex: 2,
    pledges: { type: 'nominate', quorumSetHash: H1, votes: [], accepted: [] },
  },
];

describe('xdr codec round trips', () => {
  for (const st of statements) {
    it(`${st.pledges.type} (slot ${st.slotIndex})`, () => {
      const env: Envelope = { statement: st, signature: 'cd'.repeat(64) };

      // object variant
      const x = envelopeToXdr(env);
      expect(x).toBeInstanceOf(xdr.ScpEnvelope);
      expect(envelopeFromXdr(x)).toEqual(env);

      // base64 variant
      const b64 = envelopeToBase64(env);
      expect(b64).toBe(x.toXdr('base64'));
      expect(envelopeFromXdr(b64)).toEqual(env);
      expect(envelopeFromBase64(b64)).toEqual(env);

      // raw bytes
      const bytes = envelopeToBytes(env);
      expect(envelopeFromXdr(bytes)).toEqual(env);
      expect(envelopeHash(env)).toBe(sha256Hex(bytes));

      // statements alone
      expect(statementFromXdr(statementToXdr(st))).toEqual(st);
      expect(statementFromXdr(statementToBytes(st))).toEqual(st);

      // the SDK sees the expected union arm (name and wire discriminant)
      const arm = { prepare: 0, confirm: 1, externalize: 2, nominate: 3 }[st.pledges.type];
      const name = { prepare: 'scpStPrepare', confirm: 'scpStConfirm', externalize: 'scpStExternalize', nominate: 'scpStNominate' }[st.pledges.type];
      const pledges = xdr.ScpEnvelope.fromXdr(b64, 'base64').statement.pledges;
      expect(pledges.type).toBe(name);
      expect(pledges.toXdrObject().type).toBe(arm);
    });
  }

  it('unsigned envelopes (empty signature) round-trip', () => {
    const env: Envelope = { statement: statements[0], signature: '' };
    expect(envelopeFromXdr(envelopeToBase64(env))).toEqual(env);
  });

  it('rejects malformed input', () => {
    expect(() => envelopeFromXdr('AAAA')).toThrow();
    expect(() => envelopeFromXdr(new Uint8Array([1, 2, 3]))).toThrow();
    // bad hash length / bad hex / bad slot on encode
    const bad = (pledges: Statement['pledges'], slotIndex = 1): Envelope => ({
      statement: { nodeId: n0, slotIndex, pledges },
      signature: '',
    });
    expect(() =>
      envelopeToXdr(bad({ type: 'nominate', quorumSetHash: 'abcd', votes: [], accepted: [] })),
    ).toThrow();
    expect(() => envelopeToXdr(bad({ type: 'nominate', quorumSetHash: H1, votes: ['xyz1'], accepted: [] }))).toThrow();
    expect(() => envelopeToXdr(bad({ type: 'nominate', quorumSetHash: H1, votes: [], accepted: [] }, -1))).toThrow();
    // slot index beyond 2^53 is refused on decode
    const st = statementToXdr(statements[0]);
    const huge = new xdr.ScpStatement({ nodeId: st.nodeId, slotIndex: xdr.Uint64.fromString('18446744073709551615'), pledges: st.pledges });
    expect(() => statementFromXdr(huge)).toThrow('slot index too large');
  });

  it('node ids map to xdr PublicKey', () => {
    const pk = nodeIdToXdr(n1);
    expect(toHex(pk.ed25519.toBytes())).toBe(toHex(StrKey.decodeEd25519PublicKey(n1)));
    expect(nodeIdFromXdr(pk)).toBe(n1);
    expect(() => nodeIdToXdr('GBAD')).toThrow();
  });
});

describe('quorum set codec and hash', () => {
  const nested: QuorumSet = {
    threshold: 2,
    validators: [n0],
    innerSets: [
      { threshold: 1, validators: [n1, n2], innerSets: [] },
      { threshold: 1, validators: [n3], innerSets: [{ threshold: 1, validators: [nodeId(9)], innerSets: [] }] },
    ],
  };

  it('round-trips (object, base64, bytes)', () => {
    expect(qsetFromXdr(qsetToXdr(nested))).toEqual(nested);
    expect(qsetFromXdr(qsetToBase64(nested))).toEqual(nested);
    expect(qsetFromXdr(qsetToBytes(nested))).toEqual(nested);
  });

  it('hash is SHA-256 of the xdr.ScpQuorumSet XDR, validators in the given order', () => {
    const q: QuorumSet = { threshold: 1, validators: [n0, n1], innerSets: [] };
    const manual = new xdr.ScpQuorumSet({
      threshold: 1,
      validators: [n0, n1].map((n) => xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(n))),
      innerSets: [],
    }).toXdr();
    expect(hashQuorumSet(q)).toBe(sha256Hex(manual));
    expect(hashQuorumSet({ ...q, validators: [n1, n0] })).not.toBe(hashQuorumSet(q));
  });

  it('hash is stable (golden values)', () => {
    // keys come from sha256("NODE_SEED_<i>") seeds; changing the encoding or
    // the key derivation must show up here
    expect(n0).toBe(Keypair.fromRawEd25519Seed(sha256('NODE_SEED_0')).publicKey());
    const q: QuorumSet = { threshold: 2, validators: [n0, n1, n2], innerSets: [] };
    expect(hashQuorumSet(q)).toBe(GOLDEN.flatQSetHash);
    expect(hashQuorumSet(nested)).toBe(GOLDEN.nestedQSetHash);
  });
});

describe('envelope signatures', () => {
  const st = statements[0];

  it('payload = networkId || int32BE(ENVELOPE_TYPE_SCP) || statement XDR', () => {
    const payload = statementSignaturePayload(NETWORK_ID, st);
    expect(ENVELOPE_TYPE_SCP).toBe(xdr.EnvelopeType.envelopeTypeScp.value);
    expect(toHex(payload.slice(0, 32))).toBe(toHex(NETWORK_ID));
    expect(toHex(payload.slice(32, 36))).toBe('00000001');
    expect(toHex(payload.slice(36))).toBe(toHex(statementToXdr(st).toXdr()));
    // hex network id works the same
    expect(toHex(statementSignaturePayload(toHex(NETWORK_ID), st))).toBe(toHex(payload));
    expect(() => statementSignaturePayload(new Uint8Array(31), st)).toThrow();
  });

  it('sign and verify with the node key', () => {
    const kp = nodeKeypair(0);
    const env: Envelope = { statement: st, signature: '' };
    signEnvelope(env, kp, NETWORK_ID);
    expect(env.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(kp.verify(statementSignaturePayload(NETWORK_ID, st), fromHex(env.signature))).toBe(true);
    expect(verifyEnvelope(env, NETWORK_ID)).toBe(true);
    // survives the wire
    expect(verifyEnvelope(envelopeFromXdr(envelopeToBase64(env)), NETWORK_ID)).toBe(true);

    // other network, tampered statement, wrong signer, garbage signature
    expect(verifyEnvelope(env, networkIdOf('other'))).toBe(false);
    const tampered: Envelope = {
      statement: { ...st, pledges: { ...(st.pledges as Extract<Statement['pledges'], { type: 'prepare' }>), nH: 3 } },
      signature: env.signature,
    };
    expect(verifyEnvelope(tampered, NETWORK_ID)).toBe(false);
    expect(verifyEnvelope({ statement: { ...st, nodeId: n1 }, signature: env.signature }, NETWORK_ID)).toBe(false);
    expect(verifyEnvelope({ statement: st, signature: 'zz' }, NETWORK_ID)).toBe(false);
  });
});

describe('default nomination hashes (SCPDriver::hashHelper)', () => {
  const prev = sha256Hex('previous value');
  const val = sha256Hex('candidate value');

  const firstUint64 = (parts: Uint8Array[]) => readUint64BE(sha256(concatBytes(...parts)), 0);
  // Primitive encodings taken from the SDK's own XDR encoder, through small
  // structs: TimeBounds = uint64 || uint64, LedgerBounds = uint32 || uint32,
  // Price = int32 || int32, ScpBallot = uint32 counter || opaque<> value.
  const sbUint64 = (v: bigint) => new xdr.TimeBounds({ minTime: v, maxTime: 0n }).toXdr().slice(0, 8);
  const sbUint32 = (v: number) => new xdr.LedgerBounds({ minLedger: v, maxLedger: 0 }).toXdr().slice(0, 4);
  const sbInt32 = (v: number) => new xdr.Price({ n: v, d: 0 }).toXdr().slice(0, 4);
  const sbVarOpaque = (hexOrBytes: string | Uint8Array) =>
    new xdr.ScpBallot({
      counter: 0,
      value: typeof hexOrBytes === 'string' ? fromHex(hexOrBytes) : hexOrBytes,
    })
      .toXdr()
      .slice(4);

  it('computeHashNode = SHA-256(slot || prev || N/P || round || nodeId), first 8 bytes BE', () => {
    for (const isPriority of [false, true]) {
      const expected = firstUint64([
        sbUint64(42n),
        sbVarOpaque(prev),
        sbUint32(isPriority ? 2 : 1),
        sbInt32(3),
        xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(n1)).toXdr(),
      ]);
      expect(computeHashNode(42, prev, isPriority, 3, n1)).toBe(expected);
    }
  });

  it('computeValueHash = SHA-256(slot || prev || K || round || value), first 8 bytes BE', () => {
    const expected = firstUint64([sbUint64(42n), sbVarOpaque(prev), sbUint32(3), sbInt32(3), sbVarOpaque(val)]);
    expect(computeValueHash(42, prev, 3, val)).toBe(expected);
  });

  it('variable-length opaque padding matches the SDK encoder', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
      const b = new Uint8Array(len).map((_, i) => i + 1);
      expect(toHex(xdrVarOpaque(b))).toBe(toHex(sbVarOpaque(b)));
    }
  });

  it('values differ by slot, round, node and priority flag; stable golden values', () => {
    const h = computeHashNode(1, prev, true, 1, n0);
    expect(computeHashNode(2, prev, true, 1, n0)).not.toBe(h);
    expect(computeHashNode(1, prev, true, 2, n0)).not.toBe(h);
    expect(computeHashNode(1, prev, true, 1, n1)).not.toBe(h);
    expect(computeHashNode(1, prev, false, 1, n0)).not.toBe(h);
    expect(h).toBe(GOLDEN.hashNode);
    expect(computeValueHash(1, prev, 1, val)).toBe(GOLDEN.valueHash);
  });
});

// Golden values (computed once; they guard the wire/hash formats).
const GOLDEN = {
  flatQSetHash: '172dcb852bae7187bcf821b4453692eb4cd2f419dfc692627ef5c30b1d732625',
  nestedQSetHash: 'eca4cfa1948e943dcb9bba147fb907a23c3bb31edfb95f3e259ef2b37fd2370b',
  hashNode: 3179502196158236935n,
  valueHash: 17708289032442841267n,
};
