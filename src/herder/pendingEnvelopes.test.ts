import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { networkIdOf } from '../lib/hash';
import { LogSink, Logger } from '../lib/log';
import { seededRng } from '../lib/random';
import { createGenesisLedger } from '../ledger/manager';
import type { TxSetInfo } from '../ledger/types';
import { encodeStellarValue, makeSignedStellarValue } from '../ledger/value';
import { makeDontHaveMessage, parseStellarMessage } from '../overlay/stellarMessage';
import type { PeerInfo } from '../overlay/types';
import type { Envelope, QuorumSet } from '../scp/types';
import { hashQuorumSet, qsetFromXdr, qsetToBase64 } from '../scp/xdr';
import { FETCH_RETRY_MS, FETCH_ROUNDS, PendingEnvelopes } from './pendingEnvelopes';
import type { HerderNet } from './types';

const PASSPHRASE = 'pending envelopes test';
const networkId = networkIdOf(PASSPHRASE);
const lm = createGenesisLedger(PASSPHRASE);
const keys = Array.from({ length: 5 }, () => Keypair.random());
const ids = keys.map((k) => k.publicKey());
const H = (n: number) => n.toString(16).padStart(64, '0');

function txSet(prev: string, n = 0): TxSetInfo {
  // distinct tx sets: same (empty) content, different previous ledger hashes
  const info = lm.makeTxSet(prev, []);
  return n === 0 ? info : { ...info };
}

function value(txSetHash: string, closeTime = 100): string {
  return encodeStellarValue(makeSignedStellarValue(networkId, keys[0], txSetHash, closeTime));
}

function nomination(from: number, slot: number, votes: string[], qsetHash: string): Envelope {
  return {
    statement: { nodeId: ids[from], slotIndex: slot, pledges: { type: 'nominate', quorumSetHash: qsetHash, votes: [...votes].sort(), accepted: [] } },
    signature: '',
  };
}

function setup(peerIds: string[] = [ids[1], ids[2], ids[3]]) {
  const clock = new VirtualClock(1_000);
  const sent: { to: string; kind: string; hash: string }[] = [];
  const net: HerderNet = {
    floodStellar: () => undefined,
    sendStellar: (to, msg) => {
      const m = parseStellarMessage(msg);
      sent.push({ to, kind: m.kind, hash: 'hash' in m ? m.hash : '' });
    },
    request: () => Promise.reject(new Error('no')),
    peers: () => peerIds.map((nodeId) => ({ nodeId }) as PeerInfo),
  };
  const state = { lclSeq: 10, lclHash: H(10), synced: true };
  const processed: Envelope[] = [];
  const buffered: Envelope[] = [];
  const pe = new PendingEnvelopes({
    clock,
    logger: new Logger(new LogSink(clock, 'error'), 'pe'),
    rng: seededRng(5),
    net,
    networkId,
    lcl: () => ({ seq: state.lclSeq, hash: state.lclHash }),
    canProcess: (slot) => state.synced && slot <= state.lclSeq + 1,
    process: (env) => processed.push(env),
    onBuffered: (env) => buffered.push(env),
  });
  const qset: QuorumSet = { threshold: 2, validators: [ids[0], ids[1], ids[2]], innerSets: [] };
  const qh = pe.pinQSet(qset);
  return { clock, pe, sent, state, processed, buffered, qset, qh };
}

describe('PendingEnvelopes', () => {
  it('processes an envelope whose dependencies are known, once', () => {
    const { pe, processed, qh, state } = setup();
    const ts = txSet(state.lclHash);
    pe.addTxSet(ts);
    const env = nomination(1, 11, [value(ts.hash)], qh);
    expect(pe.receive(env, 'k1', ids[1])).toBe('ready');
    expect(processed).toEqual([env]);
    expect(pe.receive(env, 'k1', ids[2])).toBe('duplicate');
    expect(pe.isSeen(11, 'k1')).toBe(true);
    expect(processed.length).toBe(1);
  });

  it('discards statements with unsigned or malformed values', () => {
    const { pe, qh, state } = setup();
    const ts = txSet(state.lclHash);
    pe.addTxSet(ts);
    const unsigned = encodeStellarValue({ txSetHash: ts.hash, closeTime: 5, upgrades: [], signature: null });
    expect(pe.receive(nomination(1, 11, [unsigned], qh), 'u', ids[1])).toBe('discarded');
    expect(pe.receive(nomination(1, 11, ['abcd'], qh), 'm', ids[1])).toBe('discarded');
    expect(pe.isSeen(11, 'u')).toBe(false);
  });

  it('buffers future slots (and everything while not synced) and pumps them in arrival order', () => {
    const { pe, processed, buffered, qh, state } = setup();
    const ts = txSet(state.lclHash);
    pe.addTxSet(ts);
    const v = value(ts.hash);
    const e12a = nomination(1, 12, [v], qh);
    const e12b = nomination(2, 12, [v], qh);
    const e13 = nomination(3, 13, [v], qh);
    expect(pe.receive(e12a, 'a', null)).toBe('buffered');
    expect(pe.receive(e13, 'c', null)).toBe('buffered');
    expect(pe.receive(e12b, 'b', null)).toBe('buffered');
    expect(buffered.length).toBe(3);
    expect(pe.bufferedSlots()).toEqual([12, 13]);
    state.lclSeq = 11;
    pe.pump();
    expect(processed).toEqual([e12a, e12b]);
    state.synced = false;
    state.lclSeq = 12;
    pe.pump();
    expect(processed.length).toBe(2);
    state.synced = true;
    state.lclSeq = 13;
    pe.pump(); // slot 13 is now <= LCL: dropped
    expect(processed.length).toBe(2);
    expect(pe.bufferedSlots()).toEqual([]);
  });

  it('fetches a missing tx set from the sender, then the statement node, then others', async () => {
    const { pe, processed, sent, qh, clock } = setup([ids[1], ids[2], ids[3], ids[4]]);
    const ts = txSet(H(77));
    const env = nomination(2, 11, [value(ts.hash)], qh);
    expect(pe.receive(env, 'k', ids[3])).toBe('fetching');
    expect(sent).toEqual([{ to: ids[3], kind: 'getTxSet', hash: ts.hash }]);
    // the sender does not have it: ask the statement's node right away
    pe.onDontHave('txSet', ts.hash, ids[3]);
    expect(sent[1]).toEqual({ to: ids[2], kind: 'getTxSet', hash: ts.hash });
    // a DONT_HAVE from a peer we did not ask is ignored
    pe.onDontHave('txSet', ts.hash, ids[4]);
    expect(sent.length).toBe(2);
    await clock.advance(FETCH_RETRY_MS);
    expect(sent.length).toBe(3);
    expect([ids[1], ids[4]]).toContain(sent[2].to);
    expect(pe.isFetching('txSet', ts.hash)).toBe(true);
    // the tx set arrives (it does not build on our LCL, but someone waits for it)
    expect(pe.addTxSet(ts)).toBe(true);
    expect(processed).toEqual([env]);
    expect(pe.isFetching('txSet', ts.hash)).toBe(false);
    expect(pe.waitingCount()).toBe(0);
  });

  it('fetches unknown quorum sets and drops envelopes whose quorum set is not sane', () => {
    const { pe, processed, sent, state } = setup();
    const ts = txSet(state.lclHash);
    pe.addTxSet(ts);
    const insane: QuorumSet = { threshold: 3, validators: [ids[1]], innerSets: [] };
    const good: QuorumSet = { threshold: 1, validators: [ids[1]], innerSets: [] };
    const bad = nomination(1, 11, [value(ts.hash)], hashQuorumSet(insane));
    const fine = nomination(2, 11, [value(ts.hash)], hashQuorumSet(good));
    expect(pe.receive(bad, 'bad', ids[1])).toBe('fetching');
    expect(pe.receive(fine, 'fine', ids[2])).toBe('fetching');
    expect(sent.map((s) => s.kind)).toEqual(['getScpQuorumset', 'getScpQuorumset']);
    expect(pe.addQSet(insane)).toBeNull();
    expect(pe.addQSet(good)).toBe(hashQuorumSet(good));
    expect(processed).toEqual([fine]);
    expect(pe.getQSet(hashQuorumSet(good))).toEqual(good);
    // the dropped envelope may be received again later
    expect(pe.isSeen(11, 'bad')).toBe(false);
  });

  it('rejects a quorum set nested far beyond the nesting limit, without throwing', () => {
    // js-xdr 5 decodes quorum sets nested about 500 deep; stellar-base 15
    // stopped below 100. The sanity check must reject them, not the decoder.
    let deep: QuorumSet = { threshold: 1, validators: [ids[1]], innerSets: [] };
    for (let i = 0; i < 150; i++) deep = { threshold: 1, validators: [], innerSets: [deep] };
    const decoded = qsetFromXdr(qsetToBase64(deep));
    expect(decoded).toEqual(deep);
    const { pe } = setup();
    expect(pe.addQSet(decoded)).toBeNull();
    expect(pe.getQSet(hashQuorumSet(deep))).toBeNull();
  });

  it('gives up after a few rounds over all peers', async () => {
    const { pe, processed, sent, qh, clock } = setup([ids[1], ids[2]]);
    const ts = txSet(H(5));
    pe.receive(nomination(1, 11, [value(ts.hash)], qh), 'k', ids[1]);
    await clock.advance(FETCH_RETRY_MS * 2 * FETCH_ROUNDS + 10);
    expect(sent.length).toBe(2 * FETCH_ROUNDS);
    expect(pe.isFetching('txSet', ts.hash)).toBe(false);
    expect(pe.waitingCount()).toBe(0);
    expect(pe.isSeen(11, 'k')).toBe(false);
    pe.addTxSet(ts);
    expect(processed).toEqual([]);
  });

  it('keeps unsolicited tx sets only when they build on our LCL', () => {
    const { pe, state } = setup();
    expect(pe.addTxSet(txSet(H(1)))).toBe(false);
    const mine = txSet(state.lclHash);
    expect(pe.addTxSet(mine)).toBe(true);
    expect(pe.addTxSet(mine)).toBe(false);
    expect(pe.getTxSet(mine.hash)?.stats).toEqual({ txCount: 0, opCount: 0, totalFees: 0n });
    expect(pe.addTxSet(txSet(H(2)), { force: true, slot: 50 })).toBe(true);
  });

  it('tags fetched tx sets with the slot of the envelopes that need them (survive purges)', () => {
    const { pe, processed, state, qh } = setup();
    // a tx set for slot 30 arrives while our LCL is 10
    const future = txSet(H(29));
    const env = nomination(1, 30, [value(future.hash)], qh);
    expect(pe.receive(env, 'f', ids[1])).toBe('fetching');
    pe.addTxSet(future);
    expect(pe.getTxSet(future.hash)?.slot).toBe(30);
    // we catch up to 29: ledgers 11..29 purge slots below 29 - 12
    state.lclSeq = 29;
    state.lclHash = H(29);
    pe.purge(17);
    expect(pe.getTxSet(future.hash)).toBeDefined();
    pe.pump();
    expect(processed).toEqual([env]);
    pe.purge(31);
    expect(pe.getTxSet(future.hash)).toBeUndefined();
  });

  it('purge drops old slots and slots beyond the validity bracket; reset keeps quorum sets', () => {
    const { pe, qh, state, qset } = setup();
    const ts = txSet(state.lclHash);
    pe.addTxSet(ts);
    state.synced = false;
    pe.receive(nomination(1, 11, [value(ts.hash)], qh), 'a', null);
    pe.receive(nomination(1, 200, [value(ts.hash)], qh), 'b', null);
    expect(pe.bufferedSlots()).toEqual([11, 200]);
    pe.purge(5);
    expect(pe.bufferedSlots()).toEqual([11]);
    pe.purge(12);
    expect(pe.bufferedSlots()).toEqual([]);
    pe.reset();
    expect(pe.getTxSet(ts.hash)).toBeUndefined();
    expect(pe.getQSet(qh)).toEqual(qset);
  });
});

describe('DONT_HAVE helper', () => {
  it('parses back to the item type', () => {
    const m = parseStellarMessage(makeDontHaveMessage('txSet', H(3)));
    expect(m).toEqual({ kind: 'dontHave', itemType: 'txSet', hash: H(3) });
  });
});
