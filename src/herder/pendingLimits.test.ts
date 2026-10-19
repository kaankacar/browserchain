// Nomination size limit (review: a round leader's nomination with 20,000
// values costs every node 12-16 s of signature checks per slot).

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { networkIdOf } from '../lib/hash';
import { LogSink, Logger } from '../lib/log';
import { seededRng } from '../lib/random';
import { createGenesisLedger } from '../ledger/manager';
import { encodeStellarValue, makeSignedStellarValue } from '../ledger/value';
import type { PeerInfo } from '../overlay/types';
import type { Envelope, QuorumSet } from '../scp/types';
import { MAX_NOMINATION_VALUES, PendingEnvelopes } from './pendingEnvelopes';
import type { HerderNet } from './types';

const PASSPHRASE = 'pending limits test';
const networkId = networkIdOf(PASSPHRASE);
const lm = createGenesisLedger(PASSPHRASE);
const keys = Array.from({ length: 3 }, (_, i) => Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(40 + i)));
const ids = keys.map((k) => k.publicKey());
const LCL_HASH = '0a'.repeat(32);

function setup() {
  const clock = new VirtualClock(1_000);
  const net: HerderNet = {
    floodStellar: () => undefined,
    sendStellar: () => undefined,
    request: () => Promise.reject(new Error('no')),
    peers: () => ids.slice(1).map((nodeId) => ({ nodeId }) as PeerInfo),
  };
  const processed: Envelope[] = [];
  const pe = new PendingEnvelopes({
    clock,
    logger: new Logger(new LogSink(clock, 'error'), 'pe'),
    rng: seededRng(5),
    net,
    networkId,
    lcl: () => ({ seq: 10, hash: LCL_HASH }),
    canProcess: (slot) => slot <= 11,
    process: (env) => processed.push(env),
  });
  const qset: QuorumSet = { threshold: 2, validators: ids, innerSets: [] };
  const qh = pe.pinQSet(qset);
  const txSet = lm.makeTxSet(LCL_HASH, []);
  pe.addTxSet(txSet);
  /** n distinct signed values for the same (cached) tx set. */
  const values = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => encodeStellarValue(makeSignedStellarValue(networkId, keys[1], txSet.hash, 100 + from + i))).sort();
  const nomination = (votes: string[], accepted: string[] = []): Envelope => ({
    statement: { nodeId: ids[1], slotIndex: 11, pledges: { type: 'nominate', quorumSetHash: qh, votes, accepted } },
    signature: '',
  });
  return { pe, processed, values, nomination };
}

describe('PendingEnvelopes nomination size', () => {
  it(`takes nominations with up to ${MAX_NOMINATION_VALUES} votes and accepted values`, () => {
    expect(MAX_NOMINATION_VALUES).toBe(64);
    const { pe, processed, values, nomination } = setup();
    const v = values(64);
    const env = nomination(v, v);
    expect(pe.receive(env, 'k64', ids[1])).toBe('ready');
    expect(processed).toEqual([env]);
  });

  it('drops a nomination with more than 64 votes before fetching or processing anything', () => {
    const { pe, processed, values, nomination } = setup();
    const v = values(65);
    expect(pe.receive(nomination(v), 'k65', ids[1])).toBe('discarded');
    // the size alone decides (signing 20,000 distinct values would only slow the test)
    expect(pe.receive(nomination(Array.from({ length: 20_000 }, (_, i) => v[i % 65])), 'k20k', ids[1])).toBe('discarded');
    expect(processed).toEqual([]);
    expect(pe.waitingCount()).toBe(0);
    // it is not remembered as seen: the same key with a valid body is processed
    expect(pe.isSeen(11, 'k65')).toBe(false);
  });

  it('drops a nomination with more than 64 accepted values', () => {
    const { pe, processed, values, nomination } = setup();
    const v = values(65);
    expect(pe.receive(nomination(v.slice(0, 10), v), 'acc65', ids[1])).toBe('discarded');
    expect(processed).toEqual([]);
  });

  it('does not limit ballot statements', () => {
    const { pe, processed, values } = setup();
    const [value] = values(1);
    const env: Envelope = {
      statement: {
        nodeId: ids[1],
        slotIndex: 11,
        pledges: { type: 'prepare', quorumSetHash: pe.pinQSet({ threshold: 2, validators: ids, innerSets: [] }), ballot: { counter: 1, value }, prepared: null, preparedPrime: null, nC: 0, nH: 0 },
      },
      signature: '',
    };
    expect(pe.receive(env, 'ballot', ids[1])).toBe('ready');
    expect(processed).toEqual([env]);
  });
});
