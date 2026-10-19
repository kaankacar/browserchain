import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { ZERO_HASH, fromHex } from '../lib/bytes';
import { sha256 } from '../lib/hash';
import { canonicalJson } from './canonicalJson';
import { LruMap, LruSet } from './lru';
import type { NodeAnnouncement, WireMessage } from './types';
import {
  announcementDigest,
  estimateSize,
  helloDigest,
  isAnnouncement,
  isWireMessage,
  randomId,
  signAnnouncement,
  signHello,
  verifyAnnouncement,
  verifyHello,
} from './wire';

const kp = Keypair.fromRawEd25519Seed(sha256('wire-test'));

function ann(over: Partial<NodeAnnouncement> = {}): NodeAnnouncement {
  return {
    nodeId: kp.publicKey(),
    name: 'node',
    networkId: 'ab'.repeat(32),
    appVersion: 1,
    lcl: { seq: 3, hash: ZERO_HASH },
    state: 'synced',
    validator: true,
    qsetHash: '',
    quorumMode: 'auto',
    ts: 1000,
    ...over,
  };
}

describe('canonicalJson', () => {
  it('sorts keys recursively without whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson(['é', '"q"', true])).toBe('["é","\\"q\\"",true]');
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('rejects values that have no canonical JSON form', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
});

describe('LRU', () => {
  it('evicts the least recently used key', () => {
    const m = new LruMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    expect(m.get('a')).toBe(1);
    m.set('c', 3);
    expect(m.has('b')).toBe(false);
    expect(m.has('a')).toBe(true);
    expect(m.peek('c')).toBe(3);
    expect(m.size).toBe(2);
  });

  it('LruSet.touch refreshes recency', () => {
    const s = new LruSet<string>(2);
    s.add('a');
    s.add('b');
    expect(s.touch('a')).toBe(true);
    s.add('c');
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(false);
    expect(s.touch('zzz')).toBe(false);
  });
});

describe('announcement signatures', () => {
  it('signs sha256(canonicalJson(ann)) and verifies', () => {
    const a = ann();
    const sig = signAnnouncement(kp, a);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyAnnouncement(a, sig)).toBe(true);
    expect(kp.verify(announcementDigest(a), fromHex(sig))).toBe(true);
    // Key order does not matter.
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as NodeAnnouncement;
    expect(Object.keys(reordered)[0]).toBe('ts');
    expect(verifyAnnouncement(reordered, sig)).toBe(true);
  });

  it('fails on any change, a wrong key or a bad node id', () => {
    const a = ann();
    const sig = signAnnouncement(kp, a);
    expect(verifyAnnouncement({ ...a, lcl: { seq: 4, hash: ZERO_HASH } }, sig)).toBe(false);
    expect(verifyAnnouncement({ ...a, ts: 1001 }, sig)).toBe(false);
    expect(verifyAnnouncement({ ...a, nodeId: Keypair.random().publicKey() }, sig)).toBe(false);
    expect(verifyAnnouncement({ ...a, nodeId: 'GNOTAKEY' }, sig)).toBe(false);
    expect(verifyAnnouncement(a, '00'.repeat(64))).toBe(false);
  });
});

describe('hello signatures', () => {
  const nonce = '0a'.repeat(16);
  const peerNonce = '0b'.repeat(16);

  it('cover the announcement and both link nonces', () => {
    const a = ann();
    const sig = signHello(kp, a, nonce, peerNonce);
    expect(verifyHello(a, nonce, peerNonce, sig)).toBe(true);
    expect(kp.verify(helloDigest(a, nonce, peerNonce), fromHex(sig))).toBe(true);
    expect(verifyHello(a, nonce, '0c'.repeat(16), sig)).toBe(false);
    expect(verifyHello(a, '0c'.repeat(16), peerNonce, sig)).toBe(false);
    expect(verifyHello({ ...a, ts: 1001 }, nonce, peerNonce, sig)).toBe(false);
  });

  it('never verify as a status signature, and the other way round', () => {
    const a = ann();
    expect(verifyAnnouncement(a, signHello(kp, a, nonce, peerNonce))).toBe(false);
    expect(verifyHello(a, nonce, peerNonce, signAnnouncement(kp, a))).toBe(false);
  });

  it('cover the channel id when there is one', () => {
    const a = ann();
    const channel = 'cc'.repeat(32);
    const sig = signHello(kp, a, nonce, peerNonce, channel);
    expect(verifyHello(a, nonce, peerNonce, sig, channel)).toBe(true);
    // another channel, or none, does not verify (a relayed hello cannot drop or swap it)
    expect(verifyHello(a, nonce, peerNonce, sig, 'dd'.repeat(32))).toBe(false);
    expect(verifyHello(a, nonce, peerNonce, sig)).toBe(false);
    expect(verifyHello(a, nonce, peerNonce, signHello(kp, a, nonce, peerNonce), channel)).toBe(false);
    // no channel: the digest is the one without the field
    expect(helloDigest(a, nonce, peerNonce, '')).toEqual(helloDigest(a, nonce, peerNonce));
  });
});

describe('isWireMessage', () => {
  const sig = 'ab'.repeat(64);
  const nonce = '01'.repeat(16);
  const good: WireMessage[] = [
    { t: 'hello', ann: ann(), sig, nonce },
    { t: 'hello', ann: ann(), sig, nonce, peerNonce: '02'.repeat(16) },
    { t: 'hello', ann: ann(), sig, nonce, peerNonce: '02'.repeat(16), channel: 'cc'.repeat(32) },
    { t: 'status', ann: ann({ qsetHash: 'cd'.repeat(32), state: 'catching-up', quorumMode: 'manual' }), sig },
    { t: 'stellar', xdr: 'AAAA' },
    { t: 'stellar', xdr: 'AAAABBB=', flood: true },
    { t: 'req', id: 'r1', body: { kind: 'headers', from: 1, to: 64 } },
    { t: 'req', id: 'r2', body: { kind: 'ledgers', from: 1, to: 2 } },
    { t: 'req', id: 'r3', body: { kind: 'snapshot', atOrBefore: 64 } },
    { t: 'req', id: 'r4', body: { kind: 'scpState', fromSlot: 0 } },
    { t: 'req', id: 'r5', body: { kind: 'branchWeight', afterSeq: 9 } },
    { t: 'res', id: 'r1', body: { kind: 'headers', items: [{ seq: 1, headerXdr: 'x' }] } },
    { t: 'res', id: 'r2', body: { kind: 'ledgers', items: [{ seq: 1, headerXdr: 'x', txSetXdr: 'y' }] } },
    { t: 'res', id: 'r3', body: { kind: 'snapshot', seq: 64, data: '{}' } },
    { t: 'res', id: 'r4', body: { kind: 'scpState', envelopes: ['e'] } },
    { t: 'res', id: 'r5', body: { kind: 'branchWeight', afterSeq: 9, weight: 3, lcl: { seq: 1, hash: ZERO_HASH } } },
    { t: 'res', id: 'r6', body: null },
    { t: 'res', id: 'r7', body: null, error: 'busy' },
    { t: 'part', id: 'r8', index: 0, total: 2, data: '{"kind":' },
    { t: 'part', id: 'r8', index: 1, total: 2, data: '' },
    { t: 'bye', nodeId: kp.publicKey() },
  ];

  it('accepts every well-formed message type', () => {
    for (const m of good) expect(isWireMessage(m), JSON.stringify(m)).toBe(true);
  });

  it('rejects malformed messages', () => {
    const bad: unknown[] = [
      null,
      'hello',
      [],
      { t: 'nope' },
      { t: 'hello', ann: ann(), sig: 'AB'.repeat(64), nonce },
      { t: 'hello', ann: ann(), sig },
      { t: 'hello', ann: ann(), sig, nonce: 'AB'.repeat(16) },
      { t: 'hello', ann: ann(), sig, nonce: '01'.repeat(15) },
      { t: 'hello', ann: ann(), sig, nonce, peerNonce: 'x' },
      { t: 'hello', ann: ann(), sig, nonce, peerNonce: '02'.repeat(16), channel: 'CC'.repeat(32) },
      { t: 'hello', ann: ann(), sig, nonce, peerNonce: '02'.repeat(16), channel: 'cc'.repeat(31) },
      { t: 'hello', ann: ann(), sig, nonce, peerNonce: '02'.repeat(16), channel: 7 },
      { t: 'hello', ann: ann({ networkId: 'AB'.repeat(32) }), sig, nonce },
      { t: 'hello', ann: ann({ name: 'x'.repeat(65) }), sig, nonce },
      { t: 'hello', ann: ann({ state: 'dancing' as NodeAnnouncement['state'] }), sig, nonce },
      { t: 'hello', ann: ann({ lcl: { seq: -1, hash: ZERO_HASH } }), sig, nonce },
      { t: 'hello', ann: ann({ qsetHash: 'abc' }), sig, nonce },
      { t: 'hello', ann: ann({ ts: Infinity }), sig, nonce },
      { t: 'hello', ann: ann({ nodeId: 'GNOTAKEY' }), sig, nonce },
      { t: 'status', ann: { ...ann(), extra: 'x'.repeat(1000) }, sig },
      { t: 'status', ann: ann({ lcl: { seq: 1, hash: ZERO_HASH, extra: 1 } as unknown as NodeAnnouncement['lcl'] }), sig },
      { t: 'stellar', xdr: '' },
      { t: 'stellar', xdr: 'AAA' },
      { t: 'stellar', xdr: 'AA AA' },
      { t: 'stellar', xdr: 'AAAA', flood: 'yes' },
      { t: 'req', id: '', body: { kind: 'headers', from: 1, to: 2 } },
      { t: 'req', id: 'x'.repeat(65), body: { kind: 'headers', from: 1, to: 2 } },
      { t: 'req', id: 'r', body: { kind: 'headers', from: 1.5, to: 2 } },
      { t: 'req', id: 'r', body: { kind: 'everything' } },
      { t: 'res', id: 'r', body: { kind: 'headers', items: [{ seq: 'one', headerXdr: 'x' }] } },
      { t: 'res', id: 'r', body: { kind: 'scpState', envelopes: [1] } },
      { t: 'res', id: 'r', body: null, error: 'e'.repeat(300) },
      { t: 'part', id: 'r', index: 0, total: 1, data: 'x' },
      { t: 'part', id: 'r', index: 2, total: 2, data: 'x' },
      { t: 'part', id: 'r', index: 0, total: 257, data: 'x' },
      { t: 'part', id: '', index: 0, total: 2, data: 'x' },
      { t: 'part', id: 'r', index: 0, total: 2, data: 7 },
      { t: 'bye' },
    ];
    for (const m of bad) expect(isWireMessage(m), JSON.stringify(m)).toBe(false);
    expect(isAnnouncement(ann())).toBe(true);
  });
});

describe('estimateSize', () => {
  it('is close to the JSON length', () => {
    const msgs: WireMessage[] = [
      { t: 'stellar', xdr: 'A'.repeat(1000), flood: true },
      { t: 'hello', ann: ann(), sig: 'ab'.repeat(64), nonce: '01'.repeat(16) },
      { t: 'res', id: 'r1', body: { kind: 'ledgers', items: [{ seq: 1, headerXdr: 'x'.repeat(300), txSetXdr: 'y'.repeat(500) }] } },
    ];
    for (const m of msgs) {
      const real = JSON.stringify(m).length;
      const est = estimateSize(m);
      expect(est).toBeGreaterThanOrEqual(real * 0.8);
      expect(est).toBeLessThanOrEqual(real * 1.3);
    }
  });

  it('stops early above the limit and refuses odd values', () => {
    const big = { t: 'stellar', items: Array.from({ length: 100_000 }, () => 'x'.repeat(100)) };
    expect(estimateSize(big, 1000)).toBeGreaterThan(1000);
    expect(estimateSize({ a: 1n })).toBe(Infinity);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(estimateSize(deep)).toBe(Infinity);
  });
});

describe('randomId', () => {
  it('returns lowercase hex of the requested size', () => {
    expect(randomId()).toMatch(/^[0-9a-f]{16}$/);
    expect(randomId(4)).toMatch(/^[0-9a-f]{8}$/);
    expect(randomId()).not.toBe(randomId());
  });
});
